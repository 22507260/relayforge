import dns, { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";

export const LIVE_DEADLINE_MS = 5_000;
export const LIVE_MAX_HEADER_BYTES = 8_192;
export const REFERENCE_DESTINATION = "http://127.0.0.1:4100/webhooks";
const MAX_RETRY_AFTER_MS = 86_400_000;

export interface TransportPolicy {
  allowedHosts: string[];
  referenceEnabled: boolean;
}
export type TransportFailureCode =
  | "destination_blocked"
  | "dns_failed"
  | "timeout"
  | "tls_failed"
  | "network_error"
  | "response_headers_too_large"
  | "http_rejected";
export interface TransportResult {
  statusCode: number | null;
  error: string | null;
  failureCode: TransportFailureCode | null;
  durationMs: number;
  retryAfterMs: number | null;
}
export interface LiveDeliveryRequest {
  transport: "https" | "reference";
  destinationUrl: string | null;
  endpointId: string;
  eventId: string;
  cycle: number;
  body: string;
  timestamp: number;
  signatures: { keyId: string; signature: string }[];
  signal?: AbortSignal;
}
export interface ResolvedAddress {
  address: string;
  family: number;
}
interface TransportDependencies {
  policy?: TransportPolicy;
  resolve?: (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;
  request?: (
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ClientRequest;
}

/** A fresh resolver makes cancellation local to this delivery, across A and AAAA. */
export async function resolveDestinationAddresses(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
  if (signal.aborted) throw new Error("Resolution cancelled.");
  const resolver = new Resolver({ timeout: LIVE_DEADLINE_MS, tries: 1 });
  resolver.setServers(dns.getServers());
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const records = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) throw new Error("Resolution cancelled.");
    const addresses: ResolvedAddress[] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (record.status === "fulfilled") addresses.push(...record.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })));
      else if (!(record.reason && typeof record.reason === "object" && "code" in record.reason && record.reason.code === "ENODATA")) throw new Error("Resolution failed.");
    }
    if (!addresses.length) throw new Error("Resolution failed.");
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function hostname(value: string): string {
  const normalized = domainToASCII(value.toLowerCase());
  if (
    !normalized || normalized.length > 253 || normalized.endsWith(".") ||
    isIP(normalized) !== 0 ||
    !normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) throw new Error("An exact DNS hostname is required.");
  return normalized;
}

/** Operator configuration contains names, never address ranges or wildcards. */
export function readTransportPolicy(): TransportPolicy {
  const values = (process.env.RELAYFORGE_ALLOWED_HOSTS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return {
    allowedHosts: [...new Set(values.map(hostname))],
    referenceEnabled: process.env.RELAYFORGE_REFERENCE_ENABLED === "true",
  };
}

/** Canonical destination addresses are immutable after a connection is created. */
export function validateDestinationUrl(value: string, allowedHosts: string[]): string {
  if (value.length === 0 || value.length > 2_048 || value !== value.trim() || /[\u0000-\u0020\\?#]/.test(value)) {
    throw new Error("Use an HTTPS address without credentials, query, or fragment.");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Use a valid HTTPS address."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Only HTTPS on port 443 is supported.");
  }
  const targetHost = hostname(url.hostname);
  const allowed = allowedHosts.map(hostname);
  if (!allowed.includes(targetHost)) throw new Error("This hostname is not in the operator allowlist.");
  url.hostname = targetHost;
  if (url.href.length > 2_048) throw new Error("The HTTPS address is too long.");
  return url.href;
}

/** Mapped IPv4 is classified as IPv4; special IPv6 outside global unicast is blocked. */
export function isPublicAddress(address: string): boolean {
  if (address.includes("%") || !ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
    else if (!ipv6.match(ipaddr.parse("2000::") as ipaddr.IPv6, 3)) return false;
  }
  return parsed.range() === "unicast";
}

export function parseRetryAfter(value: string | undefined, now: number): number | null {
  if (!value || value.length > 64) return null;
  let delay: number;
  if (/^\d{1,8}$/.test(value)) delay = Number(value) * 1_000;
  else {
    if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) return null;
    delay = parsed - now;
  }
  return Number.isSafeInteger(delay) && delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : null;
}

export function isRetryableTransportResult(result: TransportResult): boolean {
  if (result.statusCode !== null) return result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500;
  return result.failureCode === "dns_failed" || result.failureCode === "timeout" || result.failureCode === "tls_failed" || result.failureCode === "network_error";
}

const FAILURE_MESSAGES: Record<TransportFailureCode, string> = {
  destination_blocked: "The destination was blocked by the network policy.",
  dns_failed: "The destination could not be resolved.",
  timeout: "The receiver did not acknowledge within five seconds.",
  tls_failed: "The receiver TLS certificate could not be verified.",
  network_error: "The connection ended before an acknowledgement was received.",
  response_headers_too_large: "The receiver response headers exceeded the limit.",
  http_rejected: "The receiver returned an unsuccessful HTTP status.",
};

function classifyError(error: unknown): TransportFailureCode {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "HPE_HEADER_OVERFLOW") return "response_headers_too_large";
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)/.test(code)) return "tls_failed";
  return "network_error";
}

/** Only the worker calls this transport. Connections never inherit proxy settings. */
export class LiveTransport {
  private readonly policy: TransportPolicy;
  private readonly resolve: NonNullable<TransportDependencies["resolve"]>;
  private readonly requestOverride?: TransportDependencies["request"];

  constructor(dependencies: TransportDependencies = {}) {
    if (dependencies.policy) this.policy = dependencies.policy;
    else {
      try { this.policy = readTransportPolicy(); }
      catch { this.policy = { allowedHosts: [], referenceEnabled: false }; }
    }
    this.resolve = dependencies.resolve ?? resolveDestinationAddresses;
    this.requestOverride = dependencies.request;
  }

  isAvailable(transport: "https" | "reference", destinationUrl: string | null): boolean {
    if (transport === "reference") return this.policy.referenceEnabled && (destinationUrl === null || destinationUrl === REFERENCE_DESTINATION);
    try { validateDestinationUrl(destinationUrl ?? "", this.policy.allowedHosts); return true; }
    catch { return false; }
  }

  async send(delivery: LiveDeliveryRequest): Promise<TransportResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    let request: ClientRequest | undefined;
    let settled = false;
    let complete: (result: TransportResult) => void = () => undefined;
    const result = new Promise<TransportResult>((resolveResult) => { complete = resolveResult; });
    const finish = (statusCode: number | null, failureCode: TransportFailureCode | null, retryAfterMs: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delivery.signal?.removeEventListener("abort", aborted);
      controller.abort();
      complete({ statusCode, failureCode, error: failureCode ? FAILURE_MESSAGES[failureCode] : null, durationMs: Math.max(0, Date.now() - startedAt), retryAfterMs });
    };
    const aborted = () => { finish(null, "network_error"); request?.destroy(); };
    const timer = setTimeout(() => { finish(null, "timeout"); request?.destroy(); }, LIVE_DEADLINE_MS);
    delivery.signal?.addEventListener("abort", aborted, { once: true });
    if (delivery.signal?.aborted) aborted();

    void (async () => {
      let url: URL;
      let addresses: ResolvedAddress[];
      try {
        if (delivery.transport === "reference") {
          if (!this.policy.referenceEnabled || (delivery.destinationUrl !== null && delivery.destinationUrl !== REFERENCE_DESTINATION)) {
            finish(null, "destination_blocked"); return;
          }
          url = new URL(REFERENCE_DESTINATION);
          addresses = [{ address: "127.0.0.1", family: 4 }];
        } else {
          url = new URL(validateDestinationUrl(delivery.destinationUrl ?? "", this.policy.allowedHosts));
          try { addresses = await this.resolve(url.hostname, controller.signal); }
          catch { finish(null, "dns_failed"); return; }
          if (!addresses.length || addresses.some((item) => (item.family !== 4 && item.family !== 6) || isIP(item.address) !== item.family || !isPublicAddress(item.address))) {
            finish(null, "destination_blocked"); return;
          }
        }
      } catch { finish(null, "destination_blocked"); return; }
      if (settled) return;
      const pinned = addresses[0];
      const options: RequestOptions = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        agent: false,
        maxHeaderSize: LIVE_MAX_HEADER_BYTES,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(delivery.body),
          "X-RelayForge-Connection-ID": delivery.endpointId,
          "X-RelayForge-Event-ID": delivery.eventId,
          "X-RelayForge-Cycle": String(delivery.cycle),
          "X-RelayForge-Timestamp": String(delivery.timestamp),
          "X-RelayForge-Signatures": delivery.signatures.map(({ keyId, signature }) => `${keyId}=${signature}`).join(","),
        },
        lookup: (_hostname, options, callback) => options.all
          ? callback(null, [{ address: pinned.address, family: pinned.family }])
          : callback(null, pinned.address, pinned.family),
        ...(url.protocol === "https:" ? { servername: url.hostname, rejectUnauthorized: true } : {}),
      };
      try {
        const connect = this.requestOverride ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
        request = connect(options, (response) => {
          const statusCode = response.statusCode ?? null;
          const retryAfter = (statusCode === 429 || statusCode === 503) && typeof response.headers["retry-after"] === "string"
            ? parseRetryAfter(response.headers["retry-after"], Date.now()) : null;
          finish(statusCode, statusCode !== null && statusCode >= 200 && statusCode < 300 ? null : "http_rejected", retryAfter);
          response.destroy();
        });
        request.once("error", (error) => finish(null, classifyError(error)));
        request.end(delivery.body);
      } catch (error) { finish(null, classifyError(error)); request?.destroy(); }
    })();
    return result;
  }
}
