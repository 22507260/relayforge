import type { ApiErrorCode } from "../contracts.ts";

export const MAX_ATTEMPTS = 4;
export const LEASE_MS = 15_000;
export const MAX_BODY_BYTES = 16_384;
export const RECEIVER_TIMEOUT_MS = 250;
export const WORKER_HEARTBEAT_TTL_MS = 10_000;
export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;

  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? defaultErrorCode(status);
  }
}

function defaultErrorCode(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "auth_required";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 413:
      return "payload_too_large";
    case 415:
      return "unsupported_media_type";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : "request_failed";
  }
}

/** Sorted JSON preserves idempotency when clients reorder object keys. */
export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value) {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const fields = entries.map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`,
    );
    return `{${fields.join(",")}}`;
  }
  throw new ApiError(400, "Payload must contain JSON values.");
}

export function retryDelayMs(attempt: number, random = Math.random()): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new Error("Invalid attempt number");
  }
  const base = Math.min(20_000, 1_000 * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + Math.max(0, Math.min(1, random)) * 0.4));
}

export function nextStatus(
  success: boolean,
  attempt: number,
): "delivered" | "retrying" | "dead" {
  return success ? "delivered" : attempt >= MAX_ATTEMPTS ? "dead" : "retrying";
}

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function hashPayload(payload: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(payload)));
}

export function newSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacKey(secret: string, usages: KeyUsage[]) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function signPayload(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${timestamp}.${body}`),
    ),
  );
}

export async function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > 300_000 ||
    !/^[a-f0-9]{64}$/.test(signature)
  ) {
    return false;
  }
  const bytes = Uint8Array.from(signature.match(/../g)!, (pair) =>
    parseInt(pair, 16),
  );
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, ["verify"]),
    bytes,
    encoder.encode(`${timestamp}.${body}`),
  );
}
