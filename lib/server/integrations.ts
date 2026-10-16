import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Connection, ProducerKey } from "../contracts.ts";
import { ApiError, canonicalJson } from "./domain.ts";
import { assertJsonComplexity, readBody } from "./http.ts";
import {
  SigningConfigurationError,
  SigningKeyStore,
  loadConnectionSigningKeys,
  type SigningStoreOptions,
} from "./signing.ts";
import type { SqlDatabase, SqlStatement } from "./sql.ts";
import { readTransportPolicy, validateDestinationUrl } from "./transport.ts";

const DAY_MS = 86_400_000;
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(200).optional(),
    transport: z.enum(["https", "reference"]),
    url: z.string().max(2048).optional(),
  })
  .strict();
const enabledSchema = z
  .object({ enabled: z.boolean(), expectedRevision: revision })
  .strict();
const rotateSchema = z.object({ expectedRevision: revision }).strict();
const producerSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    endpointId: identifier,
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();
const producerEventSchema = z
  .object({
    eventType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
    payload: z.record(z.unknown()),
  })
  .strict();

export type IntegrationOptions = SigningStoreOptions & {
  clock?: () => number;
  allowedHosts?: string[];
  referenceEnabled?: boolean;
};
type ConnectionRow = {
  id: string;
  owner: string;
  name: string;
  description: string;
  color: string;
  mode: "healthy" | "flaky" | "failing" | "timeout";
  purpose: "standard" | "recovery";
  transport: "demo" | "https" | "reference";
  destination_url: string | null;
  enabled: number;
  revision: number;
  signing_key_id: string | null;
  signing_created_at: number | null;
  previous_key_id: string | null;
  previous_expires_at: number | null;
  deliveries: number;
  delivered: number;
  last_duration_ms: number | null;
};
type ProducerRow = {
  id: string;
  name: string;
  endpoint_id: string;
  prefix: string;
  scope: "events:write";
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

function connectionView(row: ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    url:
      row.transport === "demo"
        ? `/api/receiver/${row.id}`
        : (row.destination_url ?? ""),
    mode: row.transport === "demo" ? row.mode : null,
    purpose: row.purpose,
    transport: row.transport,
    enabled: !!row.enabled,
    revision: row.revision,
    deliveries: row.deliveries,
    delivered: row.delivered,
    lastDurationMs: row.last_duration_ms,
    signing:
      row.signing_key_id && row.signing_created_at !== null
        ? {
            keyId: row.signing_key_id,
            createdAt: row.signing_created_at,
            previousKeyId: row.previous_key_id,
            previousExpiresAt: row.previous_expires_at,
          }
        : null,
  };
}
function producerView(row: ProducerRow): ProducerKey {
  return {
    id: row.id,
    name: row.name,
    endpointId: row.endpoint_id,
    prefix: row.prefix,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export async function readIntegrationJson(request: Request): Promise<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(await readBody(request));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid JSON.");
  }
  assertJsonComplexity(value);
  return value;
}

/** Session-owned configuration. No public response includes encrypted key material or token hashes. */
export class IntegrationService {
  private db: SqlDatabase;
  private owner: string;
  private clock: () => number;
  private store: SigningKeyStore;
  private allowedHosts: string[];
  private referenceEnabled: boolean;
  private signingOptions: SigningStoreOptions;
  constructor(
    db: SqlDatabase,
    owner: string,
    options: IntegrationOptions = {},
  ) {
    this.db = db;
    this.owner = owner;
    this.clock = options.clock ?? Date.now;
    this.store = new SigningKeyStore(options);
    this.signingOptions = options;
    const policy = readTransportPolicy();
    this.allowedHosts = options.allowedHosts ?? policy.allowedHosts;
    this.referenceEnabled = options.referenceEnabled ?? policy.referenceEnabled;
  }
  private stmt(sql: string, ...values: unknown[]): SqlStatement {
    return this.db.prepare(sql).bind(...values);
  }
  private audit(
    message: string,
    now: number,
    condition = "1",
    ...values: unknown[]
  ): SqlStatement {
    return this.stmt(
      `INSERT INTO activity(id, owner, kind, event_id, message, created_at, operation_id)
      SELECT ?, ?, 'system', NULL, ?, ?, ? WHERE ${condition}`,
      randomUUID(),
      this.owner,
      message,
      now,
      randomUUID(),
      ...values,
    );
  }
  private async assertSigningConfiguration(): Promise<void> {
    if (!this.store.available()) throw new SigningConfigurationError();
    // The master key is global. Existing connections from every workspace prove
    // that a valid-looking replacement file is the same key used for stored data.
    const known = await this.stmt(
      "SELECT owner,id FROM endpoints WHERE transport IN ('https','reference')",
    ).all<{ owner: string; id: string }>();
    const now = this.clock();
    for (const endpoint of known.results)
      await loadConnectionSigningKeys(
        this.db,
        endpoint.owner,
        endpoint.id,
        now,
        this.signingOptions,
      );
  }
  async configuration() {
    let signingAvailable = true;
    try {
      await this.assertSigningConfiguration();
    } catch (error) {
      if (!(error instanceof SigningConfigurationError)) throw error;
      signingAvailable = false;
    }
    return {
      allowedHosts: this.allowedHosts,
      referenceEnabled: this.referenceEnabled,
      signingAvailable,
    };
  }
  async listConnections(): Promise<Connection[]> {
    const now = this.clock();
    const result = await this.stmt(
      `SELECT e.*,
      k.created_at AS signing_created_at,
      (SELECT key_id FROM connection_signing_keys WHERE owner=e.owner AND endpoint_id=e.id AND key_id<>e.signing_key_id AND expires_at>? ORDER BY created_at DESC LIMIT 1) AS previous_key_id,
      (SELECT expires_at FROM connection_signing_keys WHERE owner=e.owner AND endpoint_id=e.id AND key_id<>e.signing_key_id AND expires_at>? ORDER BY created_at DESC LIMIT 1) AS previous_expires_at,
      (SELECT COUNT(*) FROM deliveries WHERE owner=e.owner AND endpoint_id=e.id) AS deliveries,
      (SELECT COUNT(*) FROM deliveries WHERE owner=e.owner AND endpoint_id=e.id AND status='delivered') AS delivered,
      (SELECT a.duration_ms FROM attempts a JOIN deliveries d ON d.id=a.event_id AND d.owner=a.owner WHERE d.owner=e.owner AND d.endpoint_id=e.id AND a.finished_at IS NOT NULL AND (a.status_code IS NOT NULL OR a.failure_code IS NOT NULL) ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1) AS last_duration_ms
      FROM endpoints e LEFT JOIN connection_signing_keys k ON k.key_id=e.signing_key_id AND k.owner=e.owner AND k.endpoint_id=e.id
      WHERE e.owner=? ORDER BY e.rowid`,
      now,
      now,
      this.owner,
    ).all<ConnectionRow>();
    return result.results.map(connectionView);
  }
  private async connection(endpointId: string): Promise<Connection> {
    const connection = (await this.listConnections()).find(
      (row) => row.id === endpointId,
    );
    if (!connection) throw new ApiError(404, "Connection not found.");
    return connection;
  }
  async createConnection(
    value: unknown,
  ): Promise<{ connection: Connection; signingSecret: string; keyId: string }> {
    const parsed = createSchema.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        400,
        "Enter a connection name, transport and allowed destination.",
      );
    const input = parsed.data;
    let url: string;
    if (input.transport === "reference") {
      if (!this.referenceEnabled)
        throw new ApiError(
          403,
          "The local reference receiver is disabled by the operator.",
        );
      if (input.url !== undefined)
        throw new ApiError(
          400,
          "The reference receiver uses its fixed local address.",
        );
      url = "http://127.0.0.1:4100/webhooks";
    } else {
      if (!input.url)
        throw new ApiError(400, "An HTTPS destination is required.");
      try {
        url = validateDestinationUrl(input.url, this.allowedHosts);
      } catch {
        throw new ApiError(
          400,
          "Use an allowed HTTPS destination without credentials, query or fragment.",
        );
      }
    }
    const endpointId = randomUUID(),
      keyId = randomUUID(),
      now = this.clock();
    let key: { secret: string; encryptedSecret: string };
    try {
      await this.assertSigningConfiguration();
      key = this.store.create(this.owner, endpointId, keyId);
    } catch (error) {
      if (error instanceof SigningConfigurationError)
        throw new ApiError(this.store.available() ? 409 : 503, error.message);
      throw error;
    }
    await this.db.batch([
      this.stmt(
        `INSERT INTO endpoints(id,owner,name,description,color,mode,purpose,transport,destination_url,enabled,revision,signing_key_id)
        VALUES(?,?,?,?,?,'healthy','standard',?,?,1,1,?)`,
        endpointId,
        this.owner,
        input.name,
        input.description ?? "",
        input.transport === "https" ? "cyan" : "lime",
        input.transport,
        url,
        keyId,
      ),
      this.stmt(
        `INSERT INTO connection_signing_keys(key_id,owner,endpoint_id,encrypted_secret,created_at,expires_at) VALUES(?,?,?,?,?,NULL)`,
        keyId,
        this.owner,
        endpointId,
        key.encryptedSecret,
        now,
      ),
      this.audit(
        `${input.transport === "https" ? "HTTPS" : "Reference"} connection created: ${input.name}`,
        now,
      ),
    ]);
    return {
      connection: await this.connection(endpointId),
      signingSecret: key.secret,
      keyId,
    };
  }
  async updateEnabled(endpointId: string, value: unknown): Promise<Connection> {
    const parsed = enabledSchema.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        400,
        "Provide enabled and the current connection revision.",
      );
    const current = await this.connection(endpointId);
    if (current.transport === "demo")
      throw new ApiError(
        409,
        "Lab receivers are managed by their reliability controls.",
      );
    const now = this.clock(),
      { enabled, expectedRevision } = parsed.data;
    const results = await this.db.batch([
      this.stmt(
        "UPDATE endpoints SET enabled=?,revision=revision+1 WHERE id=? AND owner=? AND revision=? AND transport IN ('https','reference')",
        Number(enabled),
        endpointId,
        this.owner,
        expectedRevision,
      ),
      this.audit(
        `Connection ${enabled ? "enabled" : "disabled"}: ${current.name}`,
        now,
        "changes()=1",
      ),
    ]);
    if (!results[0].meta?.changes)
      throw new ApiError(
        409,
        "This connection changed. Refresh before updating it.",
      );
    return this.connection(endpointId);
  }
  async rotateSigningKey(
    endpointId: string,
    value: unknown,
  ): Promise<{ connection: Connection; signingSecret: string; keyId: string }> {
    const parsed = rotateSchema.safeParse(value);
    if (!parsed.success)
      throw new ApiError(400, "Provide the current connection revision.");
    const current = await this.connection(endpointId);
    if (current.transport === "demo")
      throw new ApiError(
        409,
        "Lab receivers use their existing controlled signing setup.",
      );
    const now = this.clock(),
      keyId = randomUUID();
    try {
      await loadConnectionSigningKeys(
        this.db,
        this.owner,
        endpointId,
        now,
        this.signingOptions,
      );
    } catch (error) {
      if (error instanceof SigningConfigurationError)
        throw new ApiError(503, error.message);
      throw error;
    }
    let key: { secret: string; encryptedSecret: string };
    try {
      key = this.store.create(this.owner, endpointId, keyId);
    } catch (error) {
      if (error instanceof SigningConfigurationError)
        throw new ApiError(503, error.message);
      throw error;
    }
    const results = await this.db.batch([
      this.stmt(
        `UPDATE endpoints SET signing_key_id=?,revision=revision+1
        WHERE owner=? AND id=? AND revision=? AND transport IN ('https','reference')
        AND NOT EXISTS(SELECT 1 FROM connection_signing_keys WHERE owner=? AND endpoint_id=? AND key_id<>endpoints.signing_key_id AND expires_at>?)`,
        keyId,
        this.owner,
        endpointId,
        parsed.data.expectedRevision,
        this.owner,
        endpointId,
        now,
      ),
      this.stmt(
        `UPDATE connection_signing_keys SET expires_at=? WHERE owner=? AND endpoint_id=? AND key_id=?
        AND EXISTS(SELECT 1 FROM endpoints WHERE owner=? AND id=? AND signing_key_id=?)`,
        now + DAY_MS,
        this.owner,
        endpointId,
        current.signing?.keyId ?? "",
        this.owner,
        endpointId,
        keyId,
      ),
      this.stmt(
        `INSERT INTO connection_signing_keys(key_id,owner,endpoint_id,encrypted_secret,created_at,expires_at)
        SELECT ?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM endpoints WHERE owner=? AND id=? AND signing_key_id=?)`,
        keyId,
        this.owner,
        endpointId,
        key.encryptedSecret,
        now,
        this.owner,
        endpointId,
        keyId,
      ),
      this.audit(
        `Connection signing key rotated: ${current.name}`,
        now,
        "EXISTS(SELECT 1 FROM endpoints WHERE owner=? AND id=? AND signing_key_id=?)",
        this.owner,
        endpointId,
        keyId,
      ),
    ]);
    if (!results[0].meta?.changes)
      throw new ApiError(
        409,
        "This connection changed or its previous signing key is still in the 24-hour grace period.",
      );
    return {
      connection: await this.connection(endpointId),
      signingSecret: key.secret,
      keyId,
    };
  }
  async listProducerKeys(): Promise<ProducerKey[]> {
    const result = await this.stmt(
      `SELECT id,name,endpoint_id,prefix,scope,created_at,expires_at,last_used_at,revoked_at
      FROM producer_keys WHERE owner=? ORDER BY created_at DESC,rowid DESC`,
      this.owner,
    ).all<ProducerRow>();
    return result.results.map(producerView);
  }
  async createProducerKey(
    value: unknown,
  ): Promise<{ key: ProducerKey; token: string }> {
    const parsed = producerSchema.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        400,
        "Provide a key name, connection and an expiry between 1 and 90 days.",
      );
    const now = this.clock(),
      input = parsed.data,
      keyId = randomUUID();
    const token = `rf_live_${randomBytes(32).toString("base64url")}`,
      prefix = token.slice(0, 18);
    const expiresAt = now + (input.expiresInDays ?? 90) * DAY_MS;
    const connection = await this.connection(input.endpointId);
    if (connection.transport === "demo" || !connection.enabled)
      throw new ApiError(
        409,
        "Producer keys require an enabled live connection.",
      );
    try {
      await loadConnectionSigningKeys(
        this.db,
        this.owner,
        input.endpointId,
        now,
        this.signingOptions,
      );
    } catch (error) {
      if (error instanceof SigningConfigurationError)
        throw new ApiError(503, error.message);
      throw error;
    }
    const results = await this.db.batch([
      this.stmt(
        `INSERT INTO producer_keys(id,owner,endpoint_id,name,token_hash,prefix,scope,created_at,expires_at,last_used_at,revoked_at)
        SELECT ?,?,?,?,?,?,'events:write',?,?,NULL,NULL
        WHERE EXISTS(SELECT 1 FROM endpoints WHERE owner=? AND id=? AND enabled=1 AND transport IN ('https','reference'))
        AND (SELECT COUNT(*) FROM producer_keys WHERE owner=? AND revoked_at IS NULL AND expires_at>?)<10`,
        keyId,
        this.owner,
        input.endpointId,
        input.name,
        createHash("sha256").update(token).digest("hex"),
        prefix,
        now,
        expiresAt,
        this.owner,
        input.endpointId,
        this.owner,
        now,
      ),
      this.audit(
        `Producer key created for ${connection.name}`,
        now,
        "changes()=1",
      ),
    ]);
    if (!results[0].meta?.changes)
      throw new ApiError(
        409,
        "The connection changed or this workspace already has 10 active producer keys.",
      );
    const key = (await this.listProducerKeys()).find(
      (row) => row.id === keyId,
    )!;
    return { key, token };
  }
  async revokeProducerKey(keyId: string): Promise<void> {
    const now = this.clock();
    const results = await this.db.batch([
      this.stmt(
        "UPDATE producer_keys SET revoked_at=? WHERE id=? AND owner=? AND revoked_at IS NULL",
        now,
        keyId,
        this.owner,
      ),
      this.audit("Producer key revoked", now, "changes()=1"),
    ]);
    if (!results[0].meta?.changes) {
      const exists = await this.stmt(
        "SELECT id FROM producer_keys WHERE id=? AND owner=?",
        keyId,
        this.owner,
      ).first();
      if (!exists) throw new ApiError(404, "Producer key not found.");
    }
  }
}

export class ProducerRateLimitError extends ApiError {
  retryAfter: number;
  constructor(now: number) {
    super(429, "Producer request limit reached. Try again in the next minute.");
    this.retryAfter = Math.ceil((60_000 - (now % 60_000)) / 1000);
  }
}

/** Every authority/quota check and the event insert run under one BEGIN IMMEDIATE batch. */
export async function enqueueProducerEvent(
  db: SqlDatabase,
  token: string,
  idempotencyKey: string,
  value: unknown,
  now = Date.now(),
): Promise<{ eventId: string; duplicate: boolean }> {
  if (!/^rf_live_[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(401, "A valid producer key is required.");
  if (
    !idempotencyKey ||
    idempotencyKey.length > 128 ||
    !/^[\x20-\x7e]+$/.test(idempotencyKey)
  )
    throw new ApiError(
      400,
      "Provide an Idempotency-Key header between 1 and 128 printable characters.",
    );
  assertJsonComplexity(value);
  const parsed = producerEventSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(400, "Provide an event type and a JSON object payload.");
  const payload = canonicalJson(parsed.data.payload);
  if (Buffer.byteLength(payload) > 12_288)
    throw new ApiError(413, "Event payload is too large.");
  const payloadHash = createHash("sha256")
    .update(canonicalJson(parsed.data))
    .digest("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex"),
    eventId = randomUUID(),
    requestId = randomUUID();
  const windowStart = now - (now % 60_000);
  const statement = (sql: string, ...values: unknown[]) =>
    db.prepare(sql).bind(...values);
  const authority = `SELECT k.id,k.owner,k.endpoint_id FROM producer_keys k JOIN endpoints e ON e.id=k.endpoint_id AND e.owner=k.owner
    WHERE k.token_hash=? AND k.scope='events:write' AND k.revoked_at IS NULL AND k.expires_at>?
    AND e.enabled=1 AND e.transport IN ('https','reference')`;
  const admitted = `SELECT k.id,k.owner,k.endpoint_id FROM (${authority}) k
    JOIN producer_rate_limits kr ON kr.key='key:'||k.id AND kr.last_request_id=?
    JOIN producer_rate_limits wr ON wr.key='owner:'||k.owner AND wr.last_request_id=?`;
  const results = await db.batch([
    statement(authority, tokenHash, now),
    statement(
      `SELECT r.key,r.attempts,r.window_start FROM producer_rate_limits r
      JOIN (${authority}) k ON r.key='key:'||k.id OR r.key='owner:'||k.owner`,
      tokenHash,
      now,
    ),
    statement(
      `INSERT INTO producer_rate_limits(key,owner,window_start,attempts,last_request_id)
      SELECT 'key:'||k.id,k.owner,?,1,? FROM (${authority}) k
      WHERE NOT EXISTS(SELECT 1 FROM producer_rate_limits WHERE key='key:'||k.id AND window_start=? AND attempts>=60)
      AND NOT EXISTS(SELECT 1 FROM producer_rate_limits WHERE key='owner:'||k.owner AND window_start=? AND attempts>=240)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN producer_rate_limits.window_start=excluded.window_start THEN producer_rate_limits.attempts+1 ELSE 1 END,
      window_start=excluded.window_start,last_request_id=excluded.last_request_id`,
      windowStart,
      requestId,
      tokenHash,
      now,
      windowStart,
      windowStart,
    ),
    statement(
      `INSERT INTO producer_rate_limits(key,owner,window_start,attempts,last_request_id)
      SELECT 'owner:'||k.owner,k.owner,?,1,? FROM (${authority}) k
      WHERE EXISTS(SELECT 1 FROM producer_rate_limits WHERE key='key:'||k.id AND last_request_id=?)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN producer_rate_limits.window_start=excluded.window_start THEN producer_rate_limits.attempts+1 ELSE 1 END,
      window_start=excluded.window_start,last_request_id=excluded.last_request_id`,
      windowStart,
      requestId,
      tokenHash,
      now,
      requestId,
    ),
    statement(
      `UPDATE producer_keys SET last_used_at=? WHERE id IN(SELECT id FROM (${admitted}))`,
      now,
      tokenHash,
      now,
      requestId,
      requestId,
    ),
    statement(
      `INSERT OR IGNORE INTO deliveries(id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,attempts,current_cycle,created_at,updated_at,next_attempt_at)
      SELECT ?,k.owner,k.endpoint_id,?,?,?,?,'pending',0,1,?,?,? FROM (${admitted}) k
      WHERE (SELECT COUNT(*) FROM deliveries WHERE owner=k.owner)<500`,
      eventId,
      parsed.data.eventType,
      payload,
      payloadHash,
      idempotencyKey,
      now,
      now,
      now,
      tokenHash,
      now,
      requestId,
      requestId,
    ),
    statement(
      `INSERT INTO activity(id,owner,kind,event_id,message,created_at,cycle)
      SELECT ?,d.owner,'accepted',d.id,?, ?,d.current_cycle FROM deliveries d WHERE d.id=?`,
      randomUUID(),
      `${parsed.data.eventType} accepted into the durable queue`,
      now,
      eventId,
    ),
    statement(
      `UPDATE workspaces SET duplicates_prevented=duplicates_prevented+1
      WHERE owner IN(SELECT k.owner FROM (${admitted}) k JOIN deliveries d ON d.owner=k.owner AND d.endpoint_id=k.endpoint_id
      WHERE d.idempotency_key=? AND d.payload_hash=? AND d.id<>?)`,
      tokenHash,
      now,
      requestId,
      requestId,
      idempotencyKey,
      payloadHash,
      eventId,
    ),
    statement(
      `INSERT INTO activity(id,owner,kind,event_id,message,created_at,cycle)
      SELECT ?,d.owner,'duplicate',d.id,'Duplicate producer event acknowledged; original delivery preserved',?,d.current_cycle
      FROM (${admitted}) k JOIN deliveries d ON d.owner=k.owner AND d.endpoint_id=k.endpoint_id
      WHERE d.idempotency_key=? AND d.payload_hash=? AND d.id<>?`,
      randomUUID(),
      now,
      tokenHash,
      now,
      requestId,
      requestId,
      idempotencyKey,
      payloadHash,
      eventId,
    ),
    statement(
      `SELECT d.id,d.payload_hash FROM (${admitted}) k JOIN deliveries d ON d.owner=k.owner AND d.endpoint_id=k.endpoint_id WHERE d.idempotency_key=?`,
      tokenHash,
      now,
      requestId,
      requestId,
      idempotencyKey,
    ),
  ]);
  if (!results[0].results.length)
    throw new ApiError(
      401,
      "A valid producer key for an enabled connection is required.",
    );
  const prior = results[1].results as {
    key: string;
    attempts: number;
    window_start: number;
  }[];
  if (
    prior.some(
      (row) =>
        row.window_start === windowStart &&
        row.attempts >= (row.key.startsWith("key:") ? 60 : 240),
    )
  )
    throw new ProducerRateLimitError(now);
  const stored = results[9].results[0] as
    { id: string; payload_hash: string } | undefined;
  if (!stored)
    throw new ApiError(429, "This workspace has reached its 500-event limit.");
  if (stored.payload_hash !== payloadHash)
    throw new ApiError(
      409,
      "This idempotency key already belongs to a different event payload or type.",
    );
  return { eventId: stored.id, duplicate: stored.id !== eventId };
}
