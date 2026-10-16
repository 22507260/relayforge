import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server, IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

export type ReferenceMode = "healthy" | "failing" | "lose-first-ack";
export interface ReferenceConfiguration {
  mode: ReferenceMode;
  connections: {
    endpointId: string;
    keys: { keyId: string; secret: string; expiresAt?: number }[];
  }[];
}
interface ReceiverOptions {
  database: DatabaseSync;
  readConfiguration: () => ReferenceConfiguration | Promise<ReferenceConfiguration>;
  clock?: () => number;
}
interface Envelope {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempt: number;
  cycle: number;
  createdAt: number;
}
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,100}$/;
const MAX_BODY_BYTES = 16_384;

export function parseReferenceConfiguration(value: unknown): ReferenceConfiguration {
  if (!value || typeof value !== "object" || !("mode" in value) || !("connections" in value)) throw new Error("Invalid reference receiver configuration.");
  const source = value as Record<string, unknown>;
  if (!(["healthy", "failing", "lose-first-ack"] as unknown[]).includes(source.mode) || !Array.isArray(source.connections) || source.connections.length > 100) throw new Error("Invalid reference receiver configuration.");
  const ids = new Set<string>();
  const connections = source.connections.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid reference receiver configuration.");
    const connection = item as Record<string, unknown>;
    if (typeof connection.endpointId !== "string" || !IDENTIFIER.test(connection.endpointId) || ids.has(connection.endpointId) || !Array.isArray(connection.keys) || connection.keys.length < 1 || connection.keys.length > 2) throw new Error("Invalid reference receiver configuration.");
    ids.add(connection.endpointId);
    const keyIds = new Set<string>();
    const keys = connection.keys.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("Invalid reference receiver configuration.");
      const key = item as Record<string, unknown>;
      if (typeof key.keyId !== "string" || !IDENTIFIER.test(key.keyId) || keyIds.has(key.keyId) || typeof key.secret !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(key.secret) || Buffer.from(key.secret, "base64url").length !== 32 || Buffer.from(key.secret, "base64url").toString("base64url") !== key.secret || (key.expiresAt !== undefined && (!Number.isSafeInteger(key.expiresAt) || Number(key.expiresAt) < 0))) throw new Error("Invalid reference receiver configuration.");
      keyIds.add(key.keyId);
      return { keyId: key.keyId, secret: key.secret, ...(key.expiresAt !== undefined ? { expiresAt: Number(key.expiresAt) } : {}) };
    });
    return { endpointId: connection.endpointId, keys };
  });
  return { mode: source.mode as ReferenceMode, connections };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function validEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Record<string, unknown>;
  return typeof envelope.eventId === "string" && IDENTIFIER.test(envelope.eventId) &&
    typeof envelope.eventType === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(envelope.eventType) &&
    !!envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload) &&
    Number.isInteger(envelope.attempt) && Number(envelope.attempt) >= 1 && Number(envelope.attempt) <= 4 &&
    Number.isInteger(envelope.cycle) && Number(envelope.cycle) >= 1 &&
    Number.isSafeInteger(envelope.createdAt) && Number(envelope.createdAt) >= 0;
}

function respond(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_limit");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Independent storage records a business effect before acknowledging delivery. */
export function createReferenceReceiver(options: ReceiverOptions): Server {
  const database = options.database;
  const clock = options.clock ?? Date.now;
  database.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS effects (
      endpoint_id TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      event_type TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(endpoint_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint_id TEXT NOT NULL,
      event_id TEXT NOT NULL, attempt INTEGER NOT NULL, cycle INTEGER NOT NULL,
      acknowledged INTEGER NOT NULL, status_code INTEGER, received_at INTEGER NOT NULL
    );`);
  const server = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/webhooks") { respond(response, 404, { error: "Not found." }); return; }
      if ((request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") { respond(response, 415, { error: "JSON is required." }); return; }
      let raw: string;
      try { raw = await body(request); } catch { respond(response, 413, { error: "The request body is too large." }); return; }
      let configuration: ReferenceConfiguration;
      try { configuration = parseReferenceConfiguration(await options.readConfiguration()); }
      catch { respond(response, 503, { error: "The receiver signing configuration is unavailable." }); return; }
      const endpointId = request.headers["x-relayforge-connection-id"];
      const timestampHeader = request.headers["x-relayforge-timestamp"];
      const signaturesHeader = request.headers["x-relayforge-signatures"];
      const timestamp = typeof timestampHeader === "string" && /^\d{1,16}$/.test(timestampHeader) ? Number(timestampHeader) : NaN;
      const connection = typeof endpointId === "string" ? configuration.connections.find((item) => item.endpointId === endpointId) : undefined;
      const signatures = typeof signaturesHeader === "string" && signaturesHeader.length <= 400 ? signaturesHeader.split(",") : [];
      const now = clock();
      let verified = false;
      if (connection && Number.isSafeInteger(timestamp) && Math.abs(now - timestamp) <= 300_000 && signatures.length >= 1 && signatures.length <= 2) {
        for (const signature of signatures) {
          const match = /^([a-zA-Z0-9_-]{1,100})=([a-f0-9]{64})$/.exec(signature.trim());
          if (!match) continue;
          const key = connection.keys.find((item) => item.keyId === match[1] && (item.expiresAt === undefined || item.expiresAt > now));
          if (!key) continue;
          const expected = createHmac("sha256", Buffer.from(key.secret, "base64url")).update(`${timestamp}.${raw}`).digest();
          if (timingSafeEqual(expected, Buffer.from(match[2], "hex"))) verified = true;
        }
      }
      if (!verified) { respond(response, 401, { error: "The webhook signature is invalid or expired." }); return; }
      let envelope: Envelope;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!validEnvelope(parsed) || request.headers["x-relayforge-event-id"] !== parsed.eventId || request.headers["x-relayforge-cycle"] !== String(parsed.cycle)) throw new Error("invalid_envelope");
        envelope = parsed;
      } catch { respond(response, 400, { error: "The webhook envelope is invalid." }); return; }
      if (configuration.mode === "failing") {
        database.prepare("INSERT INTO receipts(endpoint_id,event_id,attempt,cycle,acknowledged,status_code,received_at) VALUES(?,?,?,?,0,503,?)").run(String(endpointId), envelope.eventId, envelope.attempt, envelope.cycle, now);
        respond(response, 503, { error: "The reference receiver is simulating a failure." }); return;
      }
      const payloadHash = createHash("sha256").update(canonical({ eventType: envelope.eventType, payload: envelope.payload })).digest("hex");
      database.exec("BEGIN IMMEDIATE");
      let loseAcknowledgement = false;
      let duplicate = false;
      try {
        const existing = database.prepare("SELECT payload_hash FROM effects WHERE endpoint_id=? AND event_id=?").get(String(endpointId), envelope.eventId) as { payload_hash: string } | undefined;
        if (existing && existing.payload_hash !== payloadHash) {
          database.exec("ROLLBACK");
          respond(response, 409, { error: "This event ID already has a different payload." }); return;
        }
        const insert = database.prepare("INSERT OR IGNORE INTO effects(endpoint_id,event_id,payload_hash,event_type,created_at) VALUES(?,?,?,?,?)").run(String(endpointId), envelope.eventId, payloadHash, envelope.eventType, now);
        duplicate = Number(insert.changes) === 0;
        loseAcknowledgement = configuration.mode === "lose-first-ack" && Number(insert.changes) === 1;
        database.prepare("INSERT INTO receipts(endpoint_id,event_id,attempt,cycle,acknowledged,status_code,received_at) VALUES(?,?,?,?,?,?,?)").run(String(endpointId), envelope.eventId, envelope.attempt, envelope.cycle, loseAcknowledgement ? 0 : 1, loseAcknowledgement ? null : 200, now);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      if (loseAcknowledgement) { request.socket.destroy(); return; }
      respond(response, 200, { eventId: envelope.eventId, acknowledged: true, duplicate });
    })().catch(() => { if (!response.headersSent && !response.destroyed) respond(response, 500, { error: "The reference receiver could not persist this delivery." }); });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  return server;
}
