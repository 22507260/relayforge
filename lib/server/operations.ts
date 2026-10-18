import type { OperationsQueueCode, OperationsReport } from "../contracts.ts";
import {
  ApiError,
  EVENT_LIMIT,
  MAX_ATTEMPTS,
  WORKER_HEARTBEAT_TTL_MS,
} from "./domain.ts";
import type { SqlDatabase } from "./sql.ts";

export type OperationsScope = OperationsReport["scope"];

export function parseOperationsQuery(request: Request): {
  scope: OperationsScope;
} {
  const params = new URL(request.url).searchParams;
  if (
    [...params.keys()].some((key) => key !== "scope") ||
    params.getAll("scope").length > 1
  )
    throw new ApiError(400, "Use only one operations scope: live or lab.");
  const scope = params.get("scope") ?? "live";
  if (scope !== "live" && scope !== "lab")
    throw new ApiError(400, "Use only one operations scope: live or lab.");
  return { scope };
}

const QUEUE_CODES: OperationsQueueCode[] = [
  "in_flight",
  "lease_recovery",
  "disabled",
  "budget_exhausted",
  "scheduled",
  "due",
  "unscheduled",
];

/** Local observations only: no receiver requests or configuration/key inspection. */
export class OperationsService {
  private readonly db: SqlDatabase;
  private readonly owner: string;
  private readonly clock: () => number;
  constructor(db: SqlDatabase, owner: string, clock: () => number = Date.now) {
    this.db = db;
    this.owner = owner;
    this.clock = clock;
  }

  async read(scope: OperationsScope = "live"): Promise<OperationsReport> {
    if (scope !== "live" && scope !== "lab")
      throw new ApiError(400, "Use only one operations scope: live or lab.");
    const now = this.clock();
    const common = `WITH selected_endpoints AS (
      SELECT id, name, transport, enabled FROM endpoints
      WHERE owner = ? AND transport ${scope === "lab" ? "=" : "<>"} 'demo'
    ), selected_deliveries AS (
      SELECT d.endpoint_id, d.status, d.created_at, d.attempts,
        d.next_attempt_at, d.lease_token, d.lease_until, e.enabled FROM deliveries d
      JOIN selected_endpoints e ON e.id = d.endpoint_id WHERE d.owner = ?
    ), queue AS (
      SELECT *, CASE
        WHEN lease_token IS NOT NULL AND lease_until > ? THEN 'in_flight'
        WHEN lease_token IS NOT NULL AND lease_until <= ? THEN 'lease_recovery'
        WHEN enabled = 0 THEN 'disabled'
        WHEN attempts >= ? THEN 'budget_exhausted'
        WHEN next_attempt_at > ? THEN 'scheduled'
        WHEN lease_token IS NULL AND next_attempt_at <= ? THEN 'due'
        ELSE 'unscheduled' END AS code
      FROM selected_deliveries WHERE status IN ('pending','retrying')
    )`;
    const scoped = (sql: string) =>
      this.db
        .prepare(`${common} ${sql}`)
        .bind(this.owner, this.owner, now, now, MAX_ATTEMPTS, now, now);
    // A single aggregate batch keeps the queue partition and connection counts
    // consistent while querying the complete history, including future timestamps.
    const results = await this.db.batch([
      this.db
        .prepare(
          `SELECT
        coalesce(sum(last_seen_at > ? AND last_seen_at <= ?), 0) AS activeWorkers,
        max(CASE WHEN last_seen_at <= ? THEN last_seen_at END) AS lastHeartbeatAt
        FROM worker_heartbeats`,
        )
        .bind(now - WORKER_HEARTBEAT_TTL_MS, now, now),
      this.db
        .prepare(
          `SELECT
        coalesce((SELECT queue_paused FROM workspaces WHERE owner = ?), 0) AS paused,
        (SELECT count(*) FROM deliveries WHERE owner = ?) AS acceptedEvents`,
        )
        .bind(this.owner, this.owner),
      scoped(`SELECT code, count(*) AS count, min(created_at) AS oldestCreatedAt
        FROM queue GROUP BY code`),
      scoped(`SELECT e.id AS endpointId, e.name, e.transport, e.enabled,
        (SELECT count(*) FROM queue q WHERE q.endpoint_id = e.id) AS queued,
        (SELECT count(*) FROM selected_deliveries d WHERE d.endpoint_id = e.id AND d.status = 'dead') AS dead,
        (SELECT min(created_at) FROM queue q WHERE q.endpoint_id = e.id) AS oldestQueuedAt,
        (SELECT count(*) FROM queue q WHERE q.endpoint_id = e.id AND q.code IN ('lease_recovery','budget_exhausted','unscheduled')) AS anomalies
        FROM selected_endpoints e ORDER BY e.name COLLATE NOCASE, e.id`),
    ]);
    const observedWorker = results[0].results[0] as {
      activeWorkers: number;
      lastHeartbeatAt: number | null;
    };
    const online = observedWorker.activeWorkers > 0;
    const workspace = results[1].results[0] as {
      paused: number;
      acceptedEvents: number;
    };
    const paused = Boolean(workspace.paused);
    const rows = results[2]
      .results as unknown as OperationsReport["queue"]["buckets"];
    const buckets = QUEUE_CODES.map((code) => {
      const row = rows.find((value) => value.code === code);
      return {
        code,
        count: row?.count ?? 0,
        oldestCreatedAt: row?.oldestCreatedAt ?? null,
      };
    });
    const oldest = buckets.flatMap((row) =>
      row.oldestCreatedAt === null ? [] : [row.oldestCreatedAt],
    );
    const total = buckets.reduce((sum, row) => sum + row.count, 0);
    const connections = (
      results[3].results as unknown as (Omit<
        OperationsReport["connections"][number],
        "needsAttention" | "enabled"
      > & { enabled: number; anomalies: number })[]
    )
      .map(({ anomalies, ...connection }) => ({
        ...connection,
        enabled: Boolean(connection.enabled),
        needsAttention:
          connection.dead > 0 ||
          anomalies > 0 ||
          (connection.queued > 0 &&
            (!connection.enabled || paused || (scope === "live" && !online))),
      }))
      .sort(
        (left, right) =>
          Number(right.needsAttention) - Number(left.needsAttention) ||
          right.queued - left.queued ||
          right.dead - left.dead ||
          left.name.localeCompare(right.name) ||
          left.endpointId.localeCompare(right.endpointId),
      );
    return {
      scope,
      now,
      worker: {
        ...observedWorker,
        online,
        heartbeatTtlMs: WORKER_HEARTBEAT_TTL_MS,
      },
      workspace: {
        paused,
        acceptedEvents: workspace.acceptedEvents,
        eventLimit: EVENT_LIMIT,
        remainingEvents: Math.max(0, EVENT_LIMIT - workspace.acceptedEvents),
      },
      queue: {
        total,
        oldestCreatedAt: oldest.length ? Math.min(...oldest) : null,
        buckets,
      },
      connections,
      summary: {
        dead: connections.reduce((sum, connection) => sum + connection.dead, 0),
        disabledConnections: connections.filter(
          (connection) => !connection.enabled,
        ).length,
        queuedLiveRequiresWorker: scope === "live" && total > 0 && !online,
      },
    };
  }
}
