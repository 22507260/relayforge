import type {
  Action,
  Activity,
  Attempt,
  Delivery,
  DeliveryDetail,
  DeliveryPage,
  DeliveryQuery,
  Endpoint,
  ReceiverMode,
  RecoveryDemo,
  ReplayBatchRequest,
  ReplayBatchResponse,
  Snapshot,
  ScopeSnapshot,
} from "../contracts.ts";
import {
  ApiError,
  canonicalJson,
  hashPayload,
  LEASE_MS,
  MAX_ATTEMPTS,
  newSecret,
  nextStatus,
  RECEIVER_TIMEOUT_MS,
  retryDelayMs,
  signPayload,
  verifySignature,
  WORKER_HEARTBEAT_TTL_MS,
} from "./domain.ts";
import type { SqlDatabase, SqlStatement } from "./sql.ts";
import { LiveTransport } from "./transport.ts";
import {
  loadConnectionSigningKeys,
  signConnectionBody,
  SigningConfigurationError,
} from "./signing.ts";

type WorkspaceRow = {
  signing_secret: string;
  queue_paused: number;
  duplicates_prevented: number;
};
type EndpointRow = {
  id: string;
  owner: string;
  name: string;
  description: string;
  color: string;
  mode: ReceiverMode;
  purpose: Endpoint["purpose"];
  transport: Endpoint["transport"];
  destination_url: string | null;
  enabled: number;
  revision: number;
};
type DeliveryRow = {
  id: string;
  owner: string;
  endpoint_id: string;
  endpoint_name: string;
  event_type: string;
  payload: string;
  payload_hash: string;
  status: Delivery["status"];
  attempts: number;
  current_cycle: number;
  created_at: number;
  updated_at: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  latest_attempt_id: string | null;
  latest_cycle: number | null;
  latest_status_code: number | null;
  latest_duration_ms: number | null;
  latest_error: string | null;
  latest_created_at: number;
  latest_finished_at: number | null;
  transport: Endpoint["transport"];
  latest_failure_code: string | null;
  latest_signing_key_ids: string | null;
  latest_connection_revision: number | null;
};
type AttemptRow = {
  id: string;
  event_id: string;
  number: number;
  cycle: number | null;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  created_at: number;
  finished_at: number | null;
  failure_code: string | null;
  signing_key_ids: string | null;
  connection_revision: number | null;
};
type ActivityRow = {
  id: string;
  kind: Activity["kind"];
  event_id: string | null;
  message: string;
  created_at: number;
  cycle: number | null;
  operation_id: string | null;
};
type RecoveryDemoRow = {
  owner: string;
  endpoint_id: string;
  event_id: string;
  previous_event_id: string | null;
  created_at: number;
  repaired_at: number | null;
};
type ReceiverEnvelope = {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempt: number;
};
const EVENT_LIMIT = 500;
const SNAPSHOT_LIMIT = 100;
const id = () => crypto.randomUUID();

const DELIVERY_SELECT = `SELECT d.*, e.name AS endpoint_name, e.transport AS transport,
  a.id AS latest_attempt_id, a.cycle AS latest_cycle, a.status_code AS latest_status_code,
  CASE WHEN a.finished_at IS NOT NULL AND (a.status_code IS NOT NULL OR a.failure_code IS NOT NULL) THEN a.duration_ms END AS latest_duration_ms,
  a.error AS latest_error, a.created_at AS latest_created_at, a.finished_at AS latest_finished_at,
  a.failure_code AS latest_failure_code, a.signing_key_ids AS latest_signing_key_ids,
  a.connection_revision AS latest_connection_revision
  FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner
  LEFT JOIN attempts a ON a.rowid = (
    SELECT rowid FROM attempts WHERE owner = d.owner AND event_id = d.id
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  ) AND a.owner = d.owner`;

function deliveryView(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    eventType: row.event_type,
    endpointId: row.endpoint_id,
    endpointName: row.endpoint_name,
    transport: row.transport,
    status: row.status,
    attempts: row.attempts,
    currentCycle: row.current_cycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    payload: row.payload,
    latestAttempt: row.latest_attempt_id
      ? {
          cycle: row.latest_cycle,
          statusCode: row.latest_status_code,
          durationMs: row.latest_duration_ms,
          error: row.latest_error,
          createdAt: row.latest_created_at,
          finishedAt: row.latest_finished_at,
          failureCode: row.latest_failure_code,
          signingKeyIds: JSON.parse(row.latest_signing_key_ids || "[]"),
          connectionRevision: row.latest_connection_revision,
        }
      : null,
  };
}
function attemptView(row: AttemptRow): Attempt {
  return {
    id: row.id,
    eventId: row.event_id,
    number: row.number,
    cycle: row.cycle,
    statusCode: row.status_code,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    failureCode: row.failure_code,
    signingKeyIds: JSON.parse(row.signing_key_ids || "[]"),
    connectionRevision: row.connection_revision,
  };
}

/** All SQL uses the trusted owner; a browser cannot select another workspace. */
export class RelayService {
  private db: SqlDatabase;
  private owner: string;
  private clock: () => number;
  private random: () => number;
  private user: Snapshot["user"];
  constructor(
    db: SqlDatabase,
    owner: string,
    clock = Date.now,
    random = Math.random,
    user: Snapshot["user"] = null,
  ) {
    this.db = db;
    this.owner = owner;
    this.clock = clock;
    this.random = random;
    this.user = user?.id === owner ? user : null;
  }
  private stmt(sql: string, ...values: unknown[]): SqlStatement {
    return this.db.prepare(sql).bind(...values);
  }
  private async workspace() {
    return this.stmt(
      "SELECT signing_secret, queue_paused, duplicates_prevented FROM workspaces WHERE owner = ?",
      this.owner,
    ).first<WorkspaceRow>();
  }
  private async endpoint(endpointId: string): Promise<EndpointRow> {
    const row = await this.stmt(
      "SELECT * FROM endpoints WHERE owner = ? AND id = ?",
      this.owner,
      endpointId,
    ).first<EndpointRow>();
    if (!row) throw new ApiError(404, "Endpoint not found.");
    return row;
  }
  private activity(
    kind: Activity["kind"],
    eventId: string | null,
    message: string,
    now = this.clock(),
  ) {
    return this.stmt(
      "INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle) VALUES (?, ?, ?, ?, ?, ?, (SELECT current_cycle FROM deliveries WHERE owner = ? AND id = ?))",
      id(),
      this.owner,
      kind,
      eventId,
      message,
      now,
      this.owner,
      eventId,
    );
  }

  async initialize(): Promise<void> {
    const now = this.clock();
    const suffix = (await hashPayload(this.owner)).slice(0, 20);
    const presets = [
      {
        slug: "billing",
        name: "Billing API",
        description:
          "Healthy receiver · signatures verified, effects deduplicated",
        color: "lime",
        mode: "healthy",
      },
      {
        slug: "analytics",
        name: "Analytics sink",
        description: "Flaky receiver · first two attempts return HTTP 503",
        color: "cyan",
        mode: "flaky",
      },
      {
        slug: "notifications",
        name: "Notifications",
        description: "Failing receiver · returns HTTP 500 until repaired",
        color: "orange",
        mode: "failing",
      },
    ];
    await this.db.batch([
      this.stmt(
        "INSERT OR IGNORE INTO workspaces (owner, signing_secret, queue_paused, duplicates_prevented, created_at) VALUES (?, ?, 0, 0, ?)",
        this.owner,
        newSecret(),
        now,
      ),
      ...presets.map((preset) =>
        this.stmt(
          "INSERT OR IGNORE INTO endpoints (id, owner, name, description, color, mode) VALUES (?, ?, ?, ?, ?, ?)",
          `${preset.slug}_${suffix}`,
          this.owner,
          preset.name,
          preset.description,
          preset.color,
          preset.mode,
        ),
      ),
    ]);
  }

  async send(
    endpointId: string,
    eventType: string,
    payload: Record<string, unknown> = { message: "Hello from RelayForge" },
    idempotencyKey = id(),
  ): Promise<string> {
    return (await this.enqueue(endpointId, eventType, payload, idempotencyKey))
      .eventId;
  }

  async enqueue(
    endpointId: string,
    eventType: string,
    payload: Record<string, unknown> = { message: "Hello from RelayForge" },
    idempotencyKey = id(),
  ): Promise<{ eventId: string; duplicate: boolean }> {
    const endpoint = await this.endpoint(endpointId);
    if (!endpoint.enabled)
      throw new ApiError(409, "This connection is disabled.");
    if (endpoint.purpose !== "standard")
      throw new ApiError(
        409,
        "Recovery Lab events are managed by the recovery guide.",
      );
    const immutablePayload = canonicalJson(payload);
    if (new TextEncoder().encode(immutablePayload).byteLength > 12_288)
      throw new ApiError(413, "Event payload is too large.");
    const hash = await hashPayload(canonicalJson({ eventType, payload }));
    const eventId = id();
    const now = this.clock();
    const acceptance = await this.db.batch([
      this.stmt(
        `INSERT OR IGNORE INTO deliveries
        (id, owner, endpoint_id, event_type, payload, payload_hash, idempotency_key, status, attempts, created_at, updated_at, next_attempt_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM deliveries WHERE owner = ?) < ?
        AND EXISTS (SELECT 1 FROM endpoints WHERE owner = ? AND id = ? AND enabled = 1 AND revision = ?)`,
        eventId,
        this.owner,
        endpointId,
        eventType,
        immutablePayload,
        hash,
        idempotencyKey,
        now,
        now,
        now,
        this.owner,
        EVENT_LIMIT,
        this.owner,
        endpointId,
        endpoint.revision,
      ),
      this.stmt(
        "INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle) SELECT ?, ?, 'accepted', id, ?, ?, current_cycle FROM deliveries WHERE owner = ? AND id = ?",
        id(),
        this.owner,
        `${eventType} accepted into the durable queue`,
        now,
        this.owner,
        eventId,
      ),
      this.stmt(
        "SELECT id FROM endpoints WHERE owner = ? AND id = ? AND enabled = 1 AND revision = ?",
        this.owner,
        endpointId,
        endpoint.revision,
      ),
    ]);
    if (acceptance[2].results.length !== 1)
      throw new ApiError(
        409,
        "This connection changed. Refresh it before sending again.",
      );
    const stored = await this.stmt(
      "SELECT id, payload_hash FROM deliveries WHERE owner = ? AND endpoint_id = ? AND idempotency_key = ?",
      this.owner,
      endpointId,
      idempotencyKey,
    ).first<{ id: string; payload_hash: string }>();
    if (!stored)
      throw new ApiError(
        429,
        "This workspace has reached its 500-event limit or its connection changed.",
      );
    if (stored.payload_hash !== hash)
      throw new ApiError(
        409,
        "This idempotency key already belongs to a different event payload or type.",
      );
    if (stored.id !== eventId)
      await this.db.batch([
        this.stmt(
          "UPDATE workspaces SET duplicates_prevented = duplicates_prevented + 1 WHERE owner = ?",
          this.owner,
        ),
        this.activity(
          "duplicate",
          stored.id,
          "Duplicate event rejected; original delivery preserved",
          now,
        ),
      ]);
    return { eventId: stored.id, duplicate: stored.id !== eventId };
  }

  async action(action: Action): Promise<Snapshot> {
    await this.initialize();
    switch (action.type) {
      case "initialize":
        break;
      case "send":
        await this.send(
          action.endpointId,
          action.eventType,
          action.payload,
          action.idempotencyKey,
        );
        await this.pump();
        break;
      case "pump":
        await this.pump();
        break;
      case "pause":
        await this.db.batch([
          this.stmt(
            "UPDATE workspaces SET queue_paused = ? WHERE owner = ?",
            action.paused ? 1 : 0,
            this.owner,
          ),
          this.activity(
            "system",
            null,
            action.paused
              ? "Queue paused; accepted events remain durable"
              : "Queue resumed",
          ),
        ]);
        break;
      case "set-receiver": {
        const endpoint = await this.endpoint(action.endpointId);
        if (endpoint.transport !== "demo")
          throw new ApiError(
            409,
            "Live connections have observed delivery results, not simulated receiver modes.",
          );
        if (endpoint.purpose !== "standard")
          throw new ApiError(
            409,
            "Repair Recovery Lab through the recovery guide.",
          );
        await this.db.batch([
          this.stmt(
            "UPDATE endpoints SET mode = ? WHERE owner = ? AND id = ?",
            action.mode,
            this.owner,
            action.endpointId,
          ),
          this.activity(
            "system",
            null,
            `${endpoint.name} receiver changed to ${action.mode}`,
          ),
        ]);
        break;
      }
      case "replay": {
        const results = await this.replaySelections(
          [{ eventId: action.eventId, expectedCycle: action.expectedCycle }],
          "standard",
          true,
        );
        if (!results[0])
          throw new ApiError(
            409,
            "Only an unchanged completed or dead standard delivery can be replayed.",
          );
        await this.pump();
        break;
      }
      case "start-recovery-demo":
        await this.startRecoveryDemo(action.previousEventId);
        await this.pump();
        break;
      case "repair-recovery-demo":
        await this.repairRecoveryDemo(action.eventId, action.expectedCycle);
        break;
      case "replay-recovery-demo": {
        const results = await this.replaySelections(
          [{ eventId: action.eventId, expectedCycle: action.expectedCycle }],
          "recovery",
        );
        if (!results[0])
          throw new ApiError(
            409,
            "Repair the unchanged failed recovery event before replaying it.",
          );
        await this.pump();
        break;
      }
      case "demo": {
        const { results } = await this.stmt(
          "SELECT id FROM endpoints WHERE owner = ? AND purpose = 'standard' AND transport = 'demo' AND enabled = 1 ORDER BY id",
          this.owner,
        ).all<{ id: string }>();
        const batchId = id();
        let duplicate:
          | {
              endpoint: string;
              type: string;
              payload: Record<string, unknown>;
              key: string;
            }
          | undefined;
        for (let index = 0; index < 12; index++) {
          const event = {
            endpoint: results[index % results.length].id,
            type: ["invoice.paid", "user.created", "order.completed"][
              index % 3
            ],
            payload: {
              sequence: index + 1,
              source: "live-demo",
              order: `ORD-${1000 + index}`,
            },
            key: `${batchId}:${index}`,
          };
          await this.send(event.endpoint, event.type, event.payload, event.key);
          duplicate ??= event;
        }
        if (duplicate)
          await this.send(
            duplicate.endpoint,
            duplicate.type,
            duplicate.payload,
            duplicate.key,
          );
        await this.pump();
        break;
      }
    }
    return this.snapshot();
  }

  /** Eligibility, audit, and cycle reset share one write transaction. */
  private async replaySelections(
    selections: { eventId: string; expectedCycle?: number }[],
    purpose: Endpoint["purpose"],
    includeDelivered = false,
  ): Promise<({ id: string; current_cycle: number } | null)[]> {
    const now = this.clock();
    const operationId = id();
    const statements: SqlStatement[] = [];
    for (const selection of selections) {
      const auditId = id();
      const eligible = `owner = ? AND id = ? AND status IN (${includeDelivered ? "'dead', 'delivered'" : "'dead'"})
        AND lease_token IS NULL AND lease_until IS NULL AND current_cycle < ?
        AND (? IS NULL OR current_cycle = ?)
        AND EXISTS (SELECT 1 FROM endpoints e WHERE e.owner = deliveries.owner AND e.id = deliveries.endpoint_id AND e.purpose = ?)
        ${
          purpose === "recovery"
            ? `AND EXISTS (SELECT 1 FROM recovery_demos r JOIN endpoints e ON e.id = r.endpoint_id AND e.owner = r.owner
          WHERE r.owner = deliveries.owner AND r.event_id = deliveries.id AND r.endpoint_id = deliveries.endpoint_id
          AND r.repaired_at IS NOT NULL AND e.mode = 'healthy')`
            : ""
        }`;
      const values = [
        this.owner,
        selection.eventId,
        Number.MAX_SAFE_INTEGER,
        selection.expectedCycle ?? null,
        selection.expectedCycle ?? null,
        purpose,
      ];
      statements.push(
        this.stmt(
          `INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle, operation_id)
          SELECT ?, owner, 'replay', id, 'Event replayed with its original identity and immutable payload', ?, current_cycle + 1, ?
          FROM deliveries WHERE ${eligible}`,
          auditId,
          now,
          operationId,
          ...values,
        ),
        this.stmt(
          `UPDATE deliveries SET status = 'pending', attempts = 0, current_cycle = current_cycle + 1,
          next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
          WHERE ${eligible} AND EXISTS (SELECT 1 FROM activity a WHERE a.owner = deliveries.owner AND a.event_id = deliveries.id
            AND a.id = ? AND a.cycle = deliveries.current_cycle + 1 AND a.operation_id = ?)
          RETURNING id, current_cycle`,
          now,
          now,
          ...values,
          auditId,
          operationId,
        ),
      );
    }
    const results = await this.db.batch<{ id: string; current_cycle: number }>(
      statements,
    );
    return selections.map(
      (_, index) => results[index * 2 + 1].results[0] ?? null,
    );
  }

  async replayBatch(request: ReplayBatchRequest): Promise<ReplayBatchResponse> {
    if (
      !request ||
      !Array.isArray(request.items) ||
      request.items.length < 1 ||
      request.items.length > 20 ||
      request.items.some(
        (item) =>
          !item ||
          typeof item.eventId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(item.eventId) ||
          !Number.isSafeInteger(item.expectedCycle) ||
          item.expectedCycle < 1,
      ) ||
      new Set(request.items.map((item) => item.eventId)).size !==
        request.items.length
    )
      throw new ApiError(
        400,
        "Select 1–20 unique events with their current replay cycles.",
      );
    const rows = await this.replaySelections(request.items, "standard");
    return {
      results: request.items.map((item, index) => ({
        eventId: item.eventId,
        outcome: rows[index] ? "replayed" : "skipped",
        currentCycle: rows[index]?.current_cycle ?? null,
      })),
      snapshot: await this.snapshot(),
    };
  }

  private async currentRecoveryDemo(): Promise<RecoveryDemoRow | null> {
    return this.stmt(
      "SELECT * FROM recovery_demos WHERE owner = ?",
      this.owner,
    ).first<RecoveryDemoRow>();
  }

  private async startRecoveryDemo(previousEventId?: string): Promise<void> {
    const current = await this.currentRecoveryDemo();
    if (current && !previousEventId) return;
    if (current?.previous_event_id === previousEventId && previousEventId)
      return;
    const now = this.clock();
    const suffix = (await hashPayload(this.owner)).slice(0, 20);
    const endpointId = `recovery_${suffix}`;
    const eventId = id();
    const eventType = "recovery.proof";
    const payload = {
      source: "recovery-lab",
      scenario: "repair-and-replay",
      run: eventId,
    };
    const immutablePayload = canonicalJson(payload);
    const hash = await hashPayload(canonicalJson({ eventType, payload }));
    // These predicates are evaluated under BEGIN IMMEDIATE, never by a stale preflight read.
    const eligible = `EXISTS (SELECT 1 FROM workspaces WHERE owner = ?)
      AND (SELECT COUNT(*) FROM deliveries WHERE owner = ?) < ?
      AND NOT EXISTS (SELECT 1 FROM deliveries WHERE owner = ? AND endpoint_id = ?
        AND (status IN ('pending', 'retrying') OR lease_token IS NOT NULL OR lease_until IS NOT NULL))
      AND ${
        previousEventId
          ? `EXISTS (SELECT 1 FROM recovery_demos r JOIN deliveries d ON d.owner = r.owner AND d.id = r.event_id
          WHERE r.owner = ? AND r.event_id = ? AND d.status = 'delivered' AND d.lease_token IS NULL AND d.lease_until IS NULL)`
          : "NOT EXISTS (SELECT 1 FROM recovery_demos WHERE owner = ?)"
      }`;
    const values: unknown[] = [
      this.owner,
      this.owner,
      EVENT_LIMIT,
      this.owner,
      endpointId,
      this.owner,
    ];
    if (previousEventId) values.push(previousEventId);
    const results = await this.db.batch<{ id: string }>([
      this.stmt(
        `INSERT INTO endpoints (id, owner, name, description, color, mode, purpose)
        SELECT ?, ?, 'Recovery Lab', 'Managed receiver · repair and replay through the recovery guide', 'violet', 'failing', 'recovery'
        WHERE ${eligible} ON CONFLICT(id) DO UPDATE SET mode = 'failing'
        WHERE endpoints.owner = excluded.owner AND endpoints.purpose = 'recovery'`,
        endpointId,
        this.owner,
        ...values,
      ),
      this.stmt(
        `INSERT INTO deliveries (id, owner, endpoint_id, event_type, payload, payload_hash, idempotency_key,
          status, attempts, current_cycle, created_at, updated_at, next_attempt_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?, ? WHERE ${eligible}
        AND EXISTS (SELECT 1 FROM endpoints WHERE owner = ? AND id = ? AND purpose = 'recovery' AND mode = 'failing') RETURNING id`,
        eventId,
        this.owner,
        endpointId,
        eventType,
        immutablePayload,
        hash,
        `recovery:${eventId}`,
        now,
        now,
        now,
        ...values,
        this.owner,
        endpointId,
      ),
      this.stmt(
        `INSERT INTO recovery_demos (owner, endpoint_id, event_id, previous_event_id, created_at, repaired_at)
        SELECT owner, endpoint_id, id, ?, ?, NULL FROM deliveries WHERE owner = ? AND id = ?
        ON CONFLICT(owner) DO UPDATE SET endpoint_id = excluded.endpoint_id, event_id = excluded.event_id,
          previous_event_id = excluded.previous_event_id, created_at = excluded.created_at, repaired_at = NULL`,
        previousEventId ?? null,
        now,
        this.owner,
        eventId,
      ),
      this.stmt(
        `INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle)
        SELECT ?, owner, 'accepted', id, 'Recovery Lab event accepted into the durable queue', ?, current_cycle
        FROM deliveries WHERE owner = ? AND id = ?`,
        id(),
        now,
        this.owner,
        eventId,
      ),
    ]);
    if (results[1].results[0]) return;
    const stored = await this.currentRecoveryDemo();
    if (
      stored &&
      (!previousEventId || stored.previous_event_id === previousEventId)
    )
      return;
    const count = await this.stmt(
      "SELECT COUNT(*) AS total FROM deliveries WHERE owner = ?",
      this.owner,
    ).first<{ total: number }>();
    if ((count?.total ?? 0) >= EVENT_LIMIT)
      throw new ApiError(
        429,
        "This demo workspace has reached its 500-event limit.",
      );
    throw new ApiError(
      409,
      "Complete the current recovery run before starting another.",
    );
  }

  private async repairRecoveryDemo(
    eventId: string,
    expectedCycle: number,
  ): Promise<void> {
    const auditId = id();
    const now = this.clock();
    const results = await this.db.batch<{ id: string }>([
      this.stmt(
        `INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle, operation_id)
        SELECT ?, d.owner, 'system', d.id, 'Recovery Lab receiver repaired; failed event is ready for replay', ?, d.current_cycle, ?
        FROM recovery_demos r JOIN deliveries d ON d.id = r.event_id AND d.owner = r.owner
        JOIN endpoints e ON e.id = r.endpoint_id AND e.owner = r.owner
        WHERE r.owner = ? AND r.event_id = ? AND d.endpoint_id = r.endpoint_id AND d.status = 'dead'
        AND d.current_cycle = ? AND d.lease_token IS NULL AND d.lease_until IS NULL
        AND e.purpose = 'recovery' AND e.mode = 'failing' AND r.repaired_at IS NULL RETURNING id`,
        auditId,
        now,
        id(),
        this.owner,
        eventId,
        expectedCycle,
      ),
      this.stmt(
        `UPDATE endpoints SET mode = 'healthy' WHERE owner = ? AND purpose = 'recovery'
        AND id = (SELECT endpoint_id FROM recovery_demos WHERE owner = ? AND event_id = ?)
        AND EXISTS (SELECT 1 FROM activity WHERE owner = ? AND id = ?)`,
        this.owner,
        this.owner,
        eventId,
        this.owner,
        auditId,
      ),
      this.stmt(
        `UPDATE recovery_demos SET repaired_at = ? WHERE owner = ? AND event_id = ?
        AND EXISTS (SELECT 1 FROM activity WHERE owner = ? AND id = ?)`,
        now,
        this.owner,
        eventId,
        this.owner,
        auditId,
      ),
    ]);
    if (!results[0].results[0])
      throw new ApiError(
        409,
        "Only the unchanged failed recovery run can be repaired.",
      );
  }

  /** Browser fallback is demo-only; a worker explicitly admits bounded live calls. */
  async pump(
    options: {
      allowLive?: boolean;
      limit?: number;
      transport?: LiveTransport;
    } = {},
  ): Promise<number> {
    const workspace = await this.workspace();
    if (!workspace || workspace.queue_paused) return 0;
    const now = this.clock();
    const allowLive = options.allowLive === true;
    const limit = Math.max(1, Math.min(12, options.limit ?? 12));
    const transport = options.transport ?? new LiveTransport();
    const eligibleTransport = allowLive ? "1 = 1" : "e.transport = 'demo'";
    // An interrupted worker consumes an attempt. Recovery never silently drops it.
    await this.db.batch([
      this.stmt(
        `INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle)
        SELECT lower(hex(randomblob(16))), owner, CASE WHEN attempts >= ? THEN 'dead' ELSE 'system' END, id,
        'Expired worker lease recovered', ?, current_cycle FROM deliveries WHERE owner = ? AND lease_until <= ? AND lease_token IS NOT NULL
        AND EXISTS (SELECT 1 FROM endpoints e WHERE e.owner = deliveries.owner AND e.id = deliveries.endpoint_id AND ${eligibleTransport})`,
        MAX_ATTEMPTS,
        now,
        this.owner,
        now,
      ),
      this.stmt(
        `UPDATE attempts SET error = 'Worker lease expired before acknowledgment', finished_at = ?
        WHERE owner = ? AND finished_at IS NULL AND id IN (SELECT lease_token FROM deliveries WHERE owner = ? AND lease_until <= ?
        AND EXISTS (SELECT 1 FROM endpoints e WHERE e.owner = deliveries.owner AND e.id = deliveries.endpoint_id AND ${eligibleTransport}))`,
        now,
        this.owner,
        this.owner,
        now,
      ),
      this.stmt(
        `UPDATE deliveries SET status = CASE WHEN attempts >= ? THEN 'dead' ELSE 'retrying' END,
        next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END, updated_at = ?, lease_token = NULL, lease_until = NULL
        WHERE owner = ? AND lease_until <= ? AND lease_token IS NOT NULL
        AND EXISTS (SELECT 1 FROM endpoints e WHERE e.owner = deliveries.owner AND e.id = deliveries.endpoint_id AND ${eligibleTransport})`,
        MAX_ATTEMPTS,
        MAX_ATTEMPTS,
        now,
        now,
        this.owner,
        now,
      ),
    ]);
    const due = await this.stmt(
      `SELECT d.id, d.endpoint_id FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner
       WHERE d.owner = ? AND d.status IN ('pending', 'retrying') AND d.next_attempt_at <= ? AND d.attempts < ?
       AND d.lease_token IS NULL AND e.enabled = 1 AND ${eligibleTransport} ORDER BY d.next_attempt_at, d.created_at LIMIT 500`,
      this.owner,
      now,
      MAX_ATTEMPTS,
    ).all<{ id: string; endpoint_id: string }>();
    let processed = 0;
    const prepared = new Map<
      string,
      {
        endpoint: EndpointRow;
        signingKeys: Awaited<ReturnType<typeof loadConnectionSigningKeys>>;
        available: boolean;
      }
    >();
    for (const candidate of due.results) {
      if (processed >= limit) break;
      let connection = prepared.get(candidate.endpoint_id);
      if (!connection) {
        const endpoint = await this.endpoint(candidate.endpoint_id);
        let signingKeys: Awaited<ReturnType<typeof loadConnectionSigningKeys>> =
          [];
        let available = true;
        if (endpoint.transport !== "demo") {
          available =
            allowLive &&
            transport.isAvailable(endpoint.transport, endpoint.destination_url);
          if (available) {
            try {
              signingKeys = await loadConnectionSigningKeys(
                this.db,
                this.owner,
                endpoint.id,
                this.clock(),
              );
            } catch (error) {
              if (error instanceof SigningConfigurationError) available = false;
              else throw error;
            }
          }
        }
        connection = { endpoint, signingKeys, available };
        prepared.set(candidate.endpoint_id, connection);
      }
      if (!connection.available) continue;
      const { endpoint, signingKeys } = connection;
      const token = id();
      const claimAt = this.clock();
      const claimed = await this.db.batch<DeliveryRow>([
        this.stmt(
          `UPDATE deliveries SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE owner = ? AND id = ? AND status IN ('pending', 'retrying') AND attempts < ? AND next_attempt_at <= ? AND lease_token IS NULL
          AND EXISTS (SELECT 1 FROM workspaces WHERE owner = ? AND queue_paused = 0)
          AND EXISTS (SELECT 1 FROM endpoints WHERE owner = ? AND id = ? AND enabled = 1 AND revision = ?) RETURNING *`,
          token,
          claimAt + LEASE_MS,
          claimAt,
          this.owner,
          candidate.id,
          MAX_ATTEMPTS,
          claimAt,
          this.owner,
          this.owner,
          endpoint.id,
          endpoint.revision,
        ),
        this.stmt(
          "INSERT INTO attempts (id, owner, event_id, number, created_at, cycle, signing_key_ids, connection_revision) SELECT ?, owner, id, attempts, ?, current_cycle, ?, ? FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?",
          token,
          claimAt,
          JSON.stringify(signingKeys.map((key) => key.keyId)),
          endpoint.revision,
          this.owner,
          candidate.id,
          token,
        ),
      ]);
      const event = claimed[0].results[0];
      if (!event) continue;
      processed++;
      const start = performance.now();
      const timestamp = this.clock();
      const body = canonicalJson({
        eventId: event.id,
        eventType: event.event_type,
        payload: JSON.parse(event.payload),
        attempt: event.attempts,
        ...(endpoint.transport === "demo"
          ? {}
          : { cycle: event.current_cycle, createdAt: event.created_at }),
      });
      let statusCode: number | null;
      let error: string | null;
      let failureCode: string | null = null;
      let retryAfterMs: number | null = null;
      let measuredDuration: number | null = null;
      if (endpoint.transport === "demo") {
        const signature = await signPayload(
          workspace.signing_secret,
          timestamp,
          body,
        );
        const response = await this.receive(
          endpoint.id,
          body,
          timestamp,
          signature,
        );
        statusCode = response.status;
        error = response.error;
      } else {
        const response = await transport.send({
          transport: endpoint.transport,
          destinationUrl: endpoint.destination_url,
          endpointId: endpoint.id,
          eventId: event.id,
          cycle: event.current_cycle,
          body,
          timestamp,
          signatures: signConnectionBody(signingKeys, timestamp, body),
        });
        statusCode = response.statusCode;
        error = response.error;
        failureCode = response.failureCode;
        retryAfterMs = response.retryAfterMs;
        measuredDuration = response.durationMs;
      }
      const finishedAt = this.clock();
      const duration =
        measuredDuration ?? Math.max(1, Math.round(performance.now() - start));
      const successful =
        statusCode !== null && statusCode >= 200 && statusCode < 300;
      const retryable =
        endpoint.transport === "demo" ||
        statusCode === null ||
        statusCode === 408 ||
        statusCode === 429 ||
        statusCode >= 500;
      const status = successful
        ? "delivered"
        : retryable
          ? nextStatus(false, event.attempts)
          : "dead";
      const nextAt =
        status === "retrying"
          ? finishedAt +
            Math.max(
              retryDelayMs(event.attempts, this.random()),
              retryAfterMs ?? 0,
            )
          : null;
      const message = successful
        ? `${endpoint.name} acknowledged the event`
        : status === "dead"
          ? `${endpoint.name} delivery failed${retryable ? ` after ${MAX_ATTEMPTS} attempts` : " with a terminal HTTP response"}`
          : `${endpoint.name} ${statusCode === null ? "had a network failure" : `returned ${statusCode}`}; retry scheduled`;
      await this.db.batch([
        this.stmt(
          `UPDATE attempts SET status_code = ?, error = ?, duration_ms = ?, finished_at = ?, failure_code = ? WHERE owner = ? AND id = ?
          AND EXISTS (SELECT 1 FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?)`,
          statusCode,
          successful ? null : error,
          duration,
          finishedAt,
          failureCode,
          this.owner,
          token,
          this.owner,
          event.id,
          token,
        ),
        this.stmt(
          "INSERT INTO activity (id, owner, kind, event_id, message, created_at, cycle) SELECT ?, owner, ?, id, ?, ?, current_cycle FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?",
          id(),
          successful ? "delivered" : status === "dead" ? "dead" : "retry",
          message,
          finishedAt,
          this.owner,
          event.id,
          token,
        ),
        this.stmt(
          "UPDATE deliveries SET status = ?, next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL WHERE owner = ? AND id = ? AND lease_token = ?",
          status,
          nextAt,
          finishedAt,
          this.owner,
          event.id,
          token,
        ),
      ]);
    }
    return processed;
  }

  /** Controlled in-process receiver. It shares signing and persistence with the HTTP route. */
  async receive(
    endpointId: string,
    body: string,
    timestamp: number,
    signature: string,
  ): Promise<{ status: number; error: string | null; duplicate?: boolean }> {
    const endpoint = await this.endpoint(endpointId);
    if (endpoint.transport !== "demo")
      return { status: 404, error: "Receiver not found" };
    const workspace = await this.workspace();
    if (
      !workspace ||
      !(await verifySignature(
        workspace.signing_secret,
        timestamp,
        body,
        signature,
        this.clock(),
      ))
    )
      return { status: 401, error: "Invalid or expired receiver signature" };
    let envelope: ReceiverEnvelope;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { status: 400, error: "Invalid receiver JSON" };
    }
    if (
      !envelope ||
      typeof envelope.eventId !== "string" ||
      typeof envelope.eventType !== "string" ||
      typeof envelope.payload !== "object" ||
      envelope.payload === null ||
      Array.isArray(envelope.payload) ||
      !Number.isInteger(envelope.attempt) ||
      envelope.attempt < 1 ||
      envelope.attempt > MAX_ATTEMPTS
    ) {
      return { status: 400, error: "Invalid receiver envelope" };
    }
    const delivery = await this.stmt(
      "SELECT event_type, payload FROM deliveries WHERE owner = ? AND id = ? AND endpoint_id = ?",
      this.owner,
      envelope.eventId,
      endpointId,
    ).first<{ event_type: string; payload: string }>();
    if (
      !delivery ||
      delivery.event_type !== envelope.eventType ||
      delivery.payload !== canonicalJson(envelope.payload)
    )
      return {
        status: 400,
        error: "Receiver payload does not match the immutable event",
      };
    if (endpoint.mode === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, RECEIVER_TIMEOUT_MS));
      return {
        status: 504,
        error: `Controlled receiver exceeded ${RECEIVER_TIMEOUT_MS} ms deadline`,
      };
    }
    if (endpoint.mode === "failing")
      return { status: 500, error: "Controlled receiver returned HTTP 500" };
    if (endpoint.mode === "flaky" && envelope.attempt <= 2)
      return {
        status: 503,
        error: "Controlled receiver temporarily unavailable",
      };
    const effect = await this.stmt(
      "INSERT OR IGNORE INTO receiver_effects (id, owner, event_id, created_at) VALUES (?, ?, ?, ?) RETURNING id",
      id(),
      this.owner,
      envelope.eventId,
      this.clock(),
    ).first<{ id: string }>();
    return { status: 200, error: null, duplicate: !effect };
  }

  async detail(eventId: string): Promise<DeliveryDetail> {
    const row = await this.stmt(
      `${DELIVERY_SELECT} WHERE d.owner = ? AND d.id = ?`,
      this.owner,
      eventId,
    ).first<DeliveryRow>();
    if (!row) throw new ApiError(404, "Delivery not found.");
    const attempts = await this.stmt(
      "SELECT * FROM attempts WHERE owner = ? AND event_id = ? ORDER BY created_at, rowid",
      this.owner,
      eventId,
    ).all<AttemptRow>();
    return {
      delivery: deliveryView(row),
      attempts: attempts.results.map(attemptView),
    };
  }

  async listDeliveries(query: DeliveryQuery): Promise<DeliveryPage> {
    const { page, pageSize, search, status, endpointId } = query;
    const conditions = ["d.owner = ?"];
    const values: unknown[] = [this.owner];
    if (status !== "all") {
      conditions.push("d.status = ?");
      values.push(status);
    }
    if (endpointId !== "all") {
      conditions.push("d.endpoint_id = ?");
      values.push(endpointId);
    }
    if (search) {
      // instr treats percent/underscore/quotes as literal search text.
      conditions.push(
        "(instr(lower(d.id), lower(?)) > 0 OR instr(lower(d.event_type), lower(?)) > 0 OR instr(lower(e.name), lower(?)) > 0)",
      );
      values.push(search, search, search);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const results = await this.db.batch<DeliveryRow | { total: number }>([
      this.stmt(
        `SELECT COUNT(*) AS total FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner ${where}`,
        ...values,
      ),
      this.stmt(
        `${DELIVERY_SELECT} ${where} ORDER BY d.created_at DESC, d.rowid DESC LIMIT ? OFFSET ?`,
        ...values,
        pageSize,
        (page - 1) * pageSize,
      ),
    ]);
    const total = (results[0].results[0] as { total: number }).total;
    return {
      deliveries: (results[1].results as DeliveryRow[]).map(deliveryView),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  private async recoveryDemoSnapshot(): Promise<RecoveryDemo | null> {
    const current = await this.currentRecoveryDemo();
    if (!current) return null;
    const [delivery, effects] = await Promise.all([
      this.stmt(
        `${DELIVERY_SELECT} WHERE d.owner = ? AND d.id = ? AND d.endpoint_id = ?`,
        this.owner,
        current.event_id,
        current.endpoint_id,
      ).first<DeliveryRow>(),
      this.stmt(
        "SELECT COUNT(*) AS total FROM receiver_effects WHERE owner = ? AND event_id = ?",
        this.owner,
        current.event_id,
      ).first<{ total: number }>(),
    ]);
    if (!delivery) return null;
    const stage: RecoveryDemo["stage"] =
      delivery.status === "delivered"
        ? "completed"
        : delivery.status === "dead"
          ? current.repaired_at === null
            ? "awaiting-repair"
            : "ready-to-replay"
          : current.repaired_at === null
            ? "failing"
            : "recovering";
    return {
      eventId: current.event_id,
      endpointId: current.endpoint_id,
      createdAt: current.created_at,
      repairedAt: current.repaired_at,
      stage,
      delivery: deliveryView(delivery),
      businessEffects: effects?.total ?? 0,
    };
  }

  private async scopeSnapshot(
    scope: "live" | "lab",
    now: number,
  ): Promise<ScopeSnapshot> {
    const filter =
      scope === "lab" ? "e.transport = 'demo'" : "e.transport != 'demo'";
    const [summary, latency, buckets, duplicates, effects, recent] =
      await Promise.all([
        this.stmt(
          `SELECT COUNT(*) AS total, COALESCE(SUM(d.status = 'delivered'),0) AS delivered,
        COALESCE(SUM(d.status IN ('pending','retrying')),0) AS queued, COALESCE(SUM(d.status = 'dead'),0) AS dead
        FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner WHERE d.owner = ? AND ${filter}`,
          this.owner,
        ).first<{
          total: number;
          delivered: number;
          queued: number;
          dead: number;
        }>(),
        this.stmt(
          `SELECT AVG(a.duration_ms) AS average FROM attempts a JOIN deliveries d ON d.id = a.event_id AND d.owner = a.owner
        JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner WHERE a.owner = ? AND ${filter}
        AND a.finished_at IS NOT NULL AND (a.status_code IS NOT NULL OR a.failure_code IS NOT NULL)`,
          this.owner,
        ).first<{ average: number | null }>(),
        this.stmt(
          `SELECT CAST(a.created_at / 60000 AS INTEGER) AS minute,
        SUM(CASE WHEN a.status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN a.status_code BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS failed
        FROM attempts a JOIN deliveries d ON d.id = a.event_id AND d.owner = a.owner JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner
        WHERE a.owner = ? AND ${filter} AND a.created_at >= ? AND a.finished_at IS NOT NULL GROUP BY minute`,
          this.owner,
          now - 600_000,
        ).all<{ minute: number; delivered: number; failed: number }>(),
        this.stmt(
          `SELECT COUNT(*) AS total FROM activity a JOIN deliveries d ON d.id = a.event_id AND d.owner = a.owner
        JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner WHERE a.owner = ? AND a.kind = 'duplicate' AND ${filter}`,
          this.owner,
        ).first<{ total: number }>(),
        this.stmt(
          `SELECT COUNT(*) AS total FROM receiver_effects r JOIN deliveries d ON d.id = r.event_id AND d.owner = r.owner
        JOIN endpoints e ON e.id = d.endpoint_id AND e.owner = d.owner WHERE r.owner = ? AND ${filter}`,
          this.owner,
        ).first<{ total: number }>(),
        this.stmt(
          `${DELIVERY_SELECT} WHERE d.owner = ? AND ${filter} ORDER BY d.created_at DESC, d.rowid DESC LIMIT 8`,
          this.owner,
        ).all<DeliveryRow>(),
      ]);
    const total = summary?.total ?? 0;
    const delivered = summary?.delivered ?? 0;
    return {
      deliveries: recent.results.map(deliveryView),
      metrics: {
        total,
        delivered,
        queued: summary?.queued ?? 0,
        dead: summary?.dead ?? 0,
        successRate: total ? Math.round((delivered / total) * 1000) / 10 : 0,
        avgLatency: Math.round(latency?.average ?? 0),
        duplicatesPrevented: duplicates?.total ?? 0,
        businessEffects: effects?.total ?? 0,
      },
      chart: Array.from({ length: 10 }, (_, index) => {
        const minute = Math.floor(now / 60_000) - 9 + index;
        const bucket = buckets.results.find((row) => row.minute === minute);
        const time = new Date(minute * 60_000);
        return {
          label: `${String(time.getUTCHours()).padStart(2, "0")}:${String(time.getUTCMinutes()).padStart(2, "0")}`,
          delivered: bucket?.delivered ?? 0,
          failed: bucket?.failed ?? 0,
        };
      }),
    };
  }

  async snapshot(): Promise<Snapshot> {
    const workspace = await this.workspace();
    const now = this.clock();
    const [
      endpointRows,
      deliveryRows,
      activityRows,
      summary,
      latency,
      effects,
      buckets,
      worker,
    ] = await Promise.all([
      this.stmt(
        `SELECT e.*, COUNT(d.id) AS deliveries, SUM(CASE WHEN d.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
        (SELECT a.duration_ms FROM attempts a JOIN deliveries target ON target.id = a.event_id AND target.owner = a.owner
         WHERE a.owner = e.owner AND target.endpoint_id = e.id AND a.finished_at IS NOT NULL AND (a.status_code IS NOT NULL OR a.failure_code IS NOT NULL)
         ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1) AS last_duration_ms
        FROM endpoints e LEFT JOIN deliveries d ON d.endpoint_id = e.id AND d.owner = e.owner WHERE e.owner = ? GROUP BY e.id ORDER BY e.id`,
        this.owner,
      ).all<
        EndpointRow & {
          deliveries: number;
          delivered: number;
          last_duration_ms: number | null;
        }
      >(),
      this.stmt(
        `${DELIVERY_SELECT} WHERE d.owner = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
        this.owner,
        SNAPSHOT_LIMIT,
      ).all<DeliveryRow>(),
      this.stmt(
        "SELECT * FROM activity WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 30",
        this.owner,
      ).all<ActivityRow>(),
      this.stmt(
        "SELECT COUNT(*) AS total, SUM(status = 'delivered') AS delivered, SUM(status IN ('pending', 'retrying')) AS queued, SUM(status = 'dead') AS dead FROM deliveries WHERE owner = ?",
        this.owner,
      ).first<{
        total: number;
        delivered: number;
        queued: number;
        dead: number;
      }>(),
      this.stmt(
        "SELECT AVG(duration_ms) AS average FROM attempts WHERE owner = ? AND finished_at IS NOT NULL AND (status_code IS NOT NULL OR failure_code IS NOT NULL)",
        this.owner,
      ).first<{ average: number | null }>(),
      this.stmt(
        "SELECT COUNT(*) AS total FROM receiver_effects WHERE owner = ?",
        this.owner,
      ).first<{ total: number }>(),
      this.stmt(
        "SELECT CAST(created_at / 60000 AS INTEGER) AS minute, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN status_code BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS failed FROM attempts WHERE owner = ? AND created_at >= ? AND finished_at IS NOT NULL GROUP BY minute",
        this.owner,
        this.clock() - 600_000,
      ).all<{ minute: number; delivered: number; failed: number }>(),
      this.stmt(
        "SELECT SUM(last_seen_at > ?) AS active_workers, MAX(last_seen_at) AS last_heartbeat_at FROM worker_heartbeats",
        now - WORKER_HEARTBEAT_TTL_MS,
      ).first<{
        active_workers: number | null;
        last_heartbeat_at: number | null;
      }>(),
    ]);
    const delivered = summary?.delivered ?? 0;
    const total = summary?.total ?? 0;
    const chart = Array.from({ length: 10 }, (_, index) => {
      const minute = Math.floor(now / 60_000) - 9 + index;
      const bucket = buckets.results.find((row) => row.minute === minute);
      const time = new Date(minute * 60_000);
      return {
        label: `${time.getUTCHours().toString().padStart(2, "0")}:${time.getUTCMinutes().toString().padStart(2, "0")}`,
        delivered: bucket?.delivered ?? 0,
        failed: bucket?.failed ?? 0,
      };
    });
    return {
      user: this.user,
      endpoints: endpointRows.results.map((row): Endpoint => ({
        id: row.id,
        name: row.name,
        url:
          row.transport === "demo"
            ? `/api/receiver/${row.id}`
            : (row.destination_url ?? ""),
        description: row.description,
        color: row.color,
        mode: row.transport === "demo" ? row.mode : null,
        transport: row.transport,
        enabled: !!row.enabled,
        revision: row.revision,
        purpose: row.purpose,
        deliveries: row.deliveries,
        delivered: row.delivered ?? 0,
        lastDurationMs: row.last_duration_ms,
      })),
      deliveries: deliveryRows.results.map(deliveryView),
      activity: activityRows.results.map((row) => ({
        id: row.id,
        kind: row.kind,
        eventId: row.event_id,
        message: row.message,
        createdAt: row.created_at,
        cycle: row.cycle,
        operationId: row.operation_id,
      })),
      recoveryDemo: await this.recoveryDemoSnapshot(),
      metrics: {
        total,
        delivered,
        queued: summary?.queued ?? 0,
        dead: summary?.dead ?? 0,
        successRate: total ? Math.round((delivered / total) * 1000) / 10 : 0,
        avgLatency: Math.round(latency?.average ?? 0),
        duplicatesPrevented: workspace?.duplicates_prevented ?? 0,
        businessEffects: effects?.total ?? 0,
      },
      chart,
      scopes: {
        live: await this.scopeSnapshot("live", now),
        lab: await this.scopeSnapshot("lab", now),
      },
      system: {
        queuePaused: Boolean(workspace?.queue_paused),
        processor: worker?.active_workers ? "worker" : "request-driven",
        worker: {
          activeWorkers: worker?.active_workers ?? 0,
          lastHeartbeatAt: worker?.last_heartbeat_at ?? null,
        },
        maxAttempts: MAX_ATTEMPTS,
        eventLimit: EVENT_LIMIT,
        snapshotLimit: SNAPSHOT_LIMIT,
        now,
      },
    };
  }
}
