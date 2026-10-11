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
  Snapshot,
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
  created_at: number;
  updated_at: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  latest_attempt_id: string | null;
  latest_status_code: number | null;
  latest_duration_ms: number | null;
  latest_error: string | null;
  latest_created_at: number;
  latest_finished_at: number | null;
};
type AttemptRow = {
  id: string;
  event_id: string;
  number: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  created_at: number;
  finished_at: number | null;
};
type ActivityRow = {
  id: string;
  kind: Activity["kind"];
  event_id: string | null;
  message: string;
  created_at: number;
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

const DELIVERY_SELECT = `SELECT d.*, e.name AS endpoint_name,
  a.id AS latest_attempt_id, a.status_code AS latest_status_code,
  CASE WHEN a.finished_at IS NOT NULL AND a.status_code IS NOT NULL THEN a.duration_ms END AS latest_duration_ms,
  a.error AS latest_error, a.created_at AS latest_created_at, a.finished_at AS latest_finished_at
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
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    payload: row.payload,
    latestAttempt: row.latest_attempt_id
      ? {
          statusCode: row.latest_status_code,
          durationMs: row.latest_duration_ms,
          error: row.latest_error,
          createdAt: row.latest_created_at,
          finishedAt: row.latest_finished_at,
        }
      : null,
  };
}
function attemptView(row: AttemptRow): Attempt {
  return {
    id: row.id,
    eventId: row.event_id,
    number: row.number,
    statusCode: row.status_code,
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
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
      "INSERT INTO activity (id, owner, kind, event_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id(),
      this.owner,
      kind,
      eventId,
      message,
      now,
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
    await this.endpoint(endpointId);
    const immutablePayload = canonicalJson(payload);
    if (new TextEncoder().encode(immutablePayload).byteLength > 12_288)
      throw new ApiError(413, "Event payload is too large.");
    const hash = await hashPayload(canonicalJson({ eventType, payload }));
    const eventId = id();
    const now = this.clock();
    await this.db.batch([
      this.stmt(
        `INSERT OR IGNORE INTO deliveries
        (id, owner, endpoint_id, event_type, payload, payload_hash, idempotency_key, status, attempts, created_at, updated_at, next_attempt_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM deliveries WHERE owner = ?) < ?`,
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
      ),
      this.stmt(
        "INSERT INTO activity (id, owner, kind, event_id, message, created_at) SELECT ?, ?, 'accepted', id, ?, ? FROM deliveries WHERE owner = ? AND id = ?",
        id(),
        this.owner,
        `${eventType} accepted into the durable queue`,
        now,
        this.owner,
        eventId,
      ),
    ]);
    const stored = await this.stmt(
      "SELECT id, payload_hash FROM deliveries WHERE owner = ? AND endpoint_id = ? AND idempotency_key = ?",
      this.owner,
      endpointId,
      idempotencyKey,
    ).first<{ id: string; payload_hash: string }>();
    if (!stored)
      throw new ApiError(
        429,
        "This demo workspace has reached its 500-event limit.",
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
    return stored.id;
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
        const now = this.clock();
        const row = await this.stmt(
          "UPDATE deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL WHERE owner = ? AND id = ? AND status IN ('dead', 'delivered') AND lease_token IS NULL RETURNING id",
          now,
          now,
          this.owner,
          action.eventId,
        ).first<{ id: string }>();
        if (!row)
          throw new ApiError(
            409,
            "Only a completed or dead delivery can be replayed.",
          );
        await this.activity(
          "replay",
          row.id,
          "Event replayed with its original identity and immutable payload",
          now,
        ).run();
        await this.pump();
        break;
      }
      case "demo": {
        const { results } = await this.stmt(
          "SELECT id FROM endpoints WHERE owner = ? ORDER BY id",
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

  /** API calls and the standalone worker claim at most 12 due deliveries per owner. */
  async pump(): Promise<void> {
    const workspace = await this.workspace();
    if (!workspace || workspace.queue_paused) return;
    const now = this.clock();
    // An interrupted worker consumes an attempt. Recovery never silently drops it.
    await this.db.batch([
      this.stmt(
        `INSERT INTO activity (id, owner, kind, event_id, message, created_at)
        SELECT lower(hex(randomblob(16))), owner, CASE WHEN attempts >= ? THEN 'dead' ELSE 'system' END, id,
        'Expired worker lease recovered', ? FROM deliveries WHERE owner = ? AND lease_until <= ? AND lease_token IS NOT NULL`,
        MAX_ATTEMPTS,
        now,
        this.owner,
        now,
      ),
      this.stmt(
        `UPDATE attempts SET error = 'Worker lease expired before acknowledgment', finished_at = ?
        WHERE owner = ? AND finished_at IS NULL AND id IN (SELECT lease_token FROM deliveries WHERE owner = ? AND lease_until <= ?)`,
        now,
        this.owner,
        this.owner,
        now,
      ),
      this.stmt(
        `UPDATE deliveries SET status = CASE WHEN attempts >= ? THEN 'dead' ELSE 'retrying' END,
        next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END, updated_at = ?, lease_token = NULL, lease_until = NULL
        WHERE owner = ? AND lease_until <= ? AND lease_token IS NOT NULL`,
        MAX_ATTEMPTS,
        MAX_ATTEMPTS,
        now,
        now,
        this.owner,
        now,
      ),
    ]);
    const due = await this.stmt(
      "SELECT id FROM deliveries WHERE owner = ? AND status IN ('pending', 'retrying') AND next_attempt_at <= ? AND attempts < ? AND lease_token IS NULL ORDER BY next_attempt_at, created_at LIMIT 12",
      this.owner,
      now,
      MAX_ATTEMPTS,
    ).all<{ id: string }>();
    for (const candidate of due.results) {
      const token = id();
      const claimAt = this.clock();
      const claimed = await this.db.batch<DeliveryRow>([
        this.stmt(
          `UPDATE deliveries SET lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE owner = ? AND id = ? AND status IN ('pending', 'retrying') AND attempts < ? AND next_attempt_at <= ? AND lease_token IS NULL
          AND EXISTS (SELECT 1 FROM workspaces WHERE owner = ? AND queue_paused = 0) RETURNING *`,
          token,
          claimAt + LEASE_MS,
          claimAt,
          this.owner,
          candidate.id,
          MAX_ATTEMPTS,
          claimAt,
          this.owner,
        ),
        this.stmt(
          "INSERT INTO attempts (id, owner, event_id, number, created_at) SELECT ?, owner, id, attempts, ? FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?",
          token,
          claimAt,
          this.owner,
          candidate.id,
          token,
        ),
      ]);
      const event = claimed[0].results[0];
      if (!event) continue;
      const endpoint = await this.endpoint(event.endpoint_id);
      const start = performance.now();
      const timestamp = this.clock();
      const body = canonicalJson({
        eventId: event.id,
        eventType: event.event_type,
        payload: JSON.parse(event.payload),
        attempt: event.attempts,
      });
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
      const finishedAt = this.clock();
      const duration = Math.max(1, Math.round(performance.now() - start));
      const successful = response.status >= 200 && response.status < 300;
      const status = nextStatus(successful, event.attempts);
      const nextAt =
        status === "retrying"
          ? finishedAt + retryDelayMs(event.attempts, this.random())
          : null;
      const message = successful
        ? `${endpoint.name} acknowledged the event`
        : status === "dead"
          ? `${endpoint.name} exhausted ${MAX_ATTEMPTS} attempts`
          : `${endpoint.name} returned ${response.status}; retry scheduled`;
      await this.db.batch([
        this.stmt(
          `UPDATE attempts SET status_code = ?, error = ?, duration_ms = ?, finished_at = ? WHERE owner = ? AND id = ?
          AND EXISTS (SELECT 1 FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?)`,
          response.status,
          successful ? null : response.error,
          duration,
          finishedAt,
          this.owner,
          token,
          this.owner,
          event.id,
          token,
        ),
        this.stmt(
          "INSERT INTO activity (id, owner, kind, event_id, message, created_at) SELECT ?, owner, ?, id, ?, ? FROM deliveries WHERE owner = ? AND id = ? AND lease_token = ?",
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
  }

  /** Controlled in-process receiver. It shares signing and persistence with the HTTP route. */
  async receive(
    endpointId: string,
    body: string,
    timestamp: number,
    signature: string,
  ): Promise<{ status: number; error: string | null; duplicate?: boolean }> {
    const endpoint = await this.endpoint(endpointId);
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
         WHERE a.owner = e.owner AND target.endpoint_id = e.id AND a.finished_at IS NOT NULL AND a.status_code IS NOT NULL
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
        "SELECT AVG(duration_ms) AS average FROM attempts WHERE owner = ? AND finished_at IS NOT NULL AND status_code IS NOT NULL",
        this.owner,
      ).first<{ average: number | null }>(),
      this.stmt(
        "SELECT COUNT(*) AS total FROM receiver_effects WHERE owner = ?",
        this.owner,
      ).first<{ total: number }>(),
      this.stmt(
        "SELECT CAST(created_at / 60000 AS INTEGER) AS minute, SUM(status_code BETWEEN 200 AND 299) AS delivered, SUM(status_code >= 400) AS failed FROM attempts WHERE owner = ? AND created_at >= ? GROUP BY minute",
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
        url: `/api/receiver/${row.id}`,
        description: row.description,
        color: row.color,
        mode: row.mode,
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
      })),
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
