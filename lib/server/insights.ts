import { z } from "zod";
import type { DeliveryInsights, InsightsQuery } from "../contracts.ts";
import { ApiError } from "./domain.ts";
import type { SqlDatabase } from "./sql.ts";

const querySchema = z
  .object({
    window: z.enum(["1h", "24h", "7d"]).default("24h"),
    scope: z.enum(["live", "lab"]).default("live"),
    endpointId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("all"),
  })
  .strict();

export function parseInsightsQuery(request: Request): InsightsQuery {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(values, key))
      throw new ApiError(400, "Duplicate query parameters are not allowed.");
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  const result = querySchema.safeParse(values);
  if (!result.success)
    throw new ApiError(
      400,
      "Invalid insights filters. Check the window, scope and connection.",
    );
  return result.data;
}

const WINDOWS = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
const ACKNOWLEDGED = "status_code BETWEEN 200 AND 299";
const MEASURED =
  "finished_at IS NOT NULL AND (status_code IS NOT NULL OR failure_code IS NOT NULL)";
const FAILED = `finished_at IS NOT NULL AND ((status_code IS NOT NULL AND NOT (${ACKNOWLEDGED})) OR (status_code IS NULL AND failure_code IS NOT NULL))`;
const FAILURE_CATEGORY = `CASE
  WHEN status_code BETWEEN 300 AND 399 THEN 'http_3xx'
  WHEN status_code BETWEEN 400 AND 499 THEN 'http_4xx'
  WHEN status_code BETWEEN 500 AND 599 THEN 'http_5xx'
  WHEN status_code IS NOT NULL THEN 'http_other'
  WHEN failure_code IN ('destination_blocked','dns_failed','timeout','tls_failed','network_error','response_headers_too_large','http_rejected') THEN failure_code
  ELSE 'unclassified' END`;

type EventCounts = DeliveryInsights["events"];
type AttemptCounts = DeliveryInsights["attempts"];
type EndpointStats = DeliveryInsights["endpoints"][number];
type QueueCounts = DeliveryInsights["queue"];

/** Full-history aggregates only: no event payloads, secrets or receiver requests. */
export class InsightsService {
  private db: SqlDatabase;
  private owner: string;
  private clock: () => number;
  constructor(db: SqlDatabase, owner: string, clock: () => number = Date.now) {
    this.db = db;
    this.owner = owner;
    this.clock = clock;
  }

  async read(query: InsightsQuery): Promise<DeliveryInsights> {
    const validated = querySchema.safeParse(query);
    if (!validated.success)
      throw new ApiError(
        400,
        "Invalid insights filters. Check the window, scope and connection.",
      );
    query = validated.data;
    const now = this.clock();
    const since = now - WINDOWS[query.window];
    const common = `WITH RECURSIVE selected_endpoints AS (
      SELECT id, name, transport, enabled FROM endpoints
      WHERE owner = ? AND transport ${query.scope === "lab" ? "=" : "<>"} 'demo'
        AND (? = 'all' OR id = ?)
    ), events AS (
      SELECT d.id, d.endpoint_id, d.status, d.created_at, d.next_attempt_at,
        d.lease_token, d.lease_until, d.attempts
      FROM deliveries d JOIN selected_endpoints e ON e.id = d.endpoint_id
      WHERE d.owner = ? AND d.created_at <= ?
    ), window_events AS (
      SELECT * FROM events WHERE created_at >= ?
    ), window_attempts AS (
      SELECT a.id, a.status_code, a.failure_code, a.duration_ms, a.created_at,
        a.finished_at, d.endpoint_id
      FROM attempts a JOIN events d ON d.id = a.event_id
      WHERE a.owner = ? AND a.created_at >= ? AND a.created_at <= ?
    )`;
    const filters = [
      this.owner,
      query.endpointId,
      query.endpointId,
      this.owner,
      now,
      since,
      this.owner,
      since,
      now,
    ];
    const statement = (sql: string, ...extra: unknown[]) =>
      this.db.prepare(`${common} ${sql}`).bind(...filters, ...extra);
    // The adapter executes this bounded aggregate batch in one transaction. The
    // percentile windows rank in SQLite rather than loading attempt histories.
    const results = await this.db.batch([
      this.db
        .prepare("SELECT id FROM endpoints WHERE owner = ? AND id = ?")
        .bind(this.owner, query.endpointId),
      statement(`SELECT count(*) AS accepted,
        coalesce(sum(status = 'delivered'), 0) AS acknowledged,
        coalesce(sum(status = 'dead'), 0) AS dead,
        coalesce(sum(status IN ('pending','retrying')), 0) AS queued
        FROM window_events`),
      statement(`, ranked AS (
        SELECT duration_ms, row_number() OVER (ORDER BY duration_ms, id) AS rank,
          count(*) OVER () AS size FROM window_attempts WHERE ${MEASURED}
      ) SELECT count(*) AS total,
        coalesce(sum(finished_at IS NOT NULL), 0) AS completed,
        coalesce(sum(finished_at IS NOT NULL AND (${ACKNOWLEDGED})), 0) AS acknowledged,
        coalesce(sum(${FAILED}), 0) AS failed,
        coalesce(sum(finished_at IS NULL), 0) AS inFlight,
        coalesce(sum(finished_at IS NOT NULL AND status_code IS NULL AND failure_code IS NULL), 0) AS unmeasuredInterrupted,
        (SELECT count(*) FROM ranked) AS measured,
        (SELECT duration_ms FROM ranked WHERE rank = (size * 50 + 99) / 100) AS p50Ms,
        (SELECT duration_ms FROM ranked WHERE rank = (size * 95 + 99) / 100) AS p95Ms,
        (SELECT max(duration_ms) FROM ranked) AS maxMs
        FROM window_attempts`),
      statement(`SELECT status_code AS statusCode, count(*) AS count
        FROM window_attempts WHERE ${MEASURED}
        GROUP BY status_code ORDER BY status_code IS NULL, status_code`),
      statement(`SELECT ${FAILURE_CATEGORY} AS category, count(*) AS count
        FROM window_attempts WHERE ${FAILED}
        GROUP BY category ORDER BY count DESC, category`),
      statement(
        `, buckets AS (
        SELECT 0 AS bucket UNION ALL SELECT bucket + 1 FROM buckets WHERE bucket < 11
      ), event_buckets AS (
        SELECT min(11, CAST((created_at - ?) * 12 / ? AS INTEGER)) AS bucket,
          count(*) AS accepted FROM window_events GROUP BY bucket
      ), attempt_buckets AS (
        SELECT min(11, CAST((created_at - ?) * 12 / ? AS INTEGER)) AS bucket,
          coalesce(sum(finished_at IS NOT NULL AND (${ACKNOWLEDGED})), 0) AS acknowledged,
          coalesce(sum(${FAILED}), 0) AS failed
        FROM window_attempts GROUP BY bucket
      ) SELECT ? + b.bucket * ? / 12 AS startAt,
        ? + (b.bucket + 1) * ? / 12 AS endAt,
        coalesce(e.accepted, 0) AS accepted,
        coalesce(a.acknowledged, 0) AS acknowledged,
        coalesce(a.failed, 0) AS failed
      FROM buckets b LEFT JOIN event_buckets e ON e.bucket = b.bucket
        LEFT JOIN attempt_buckets a ON a.bucket = b.bucket ORDER BY b.bucket`,
        since,
        WINDOWS[query.window],
        since,
        WINDOWS[query.window],
        since,
        WINDOWS[query.window],
        since,
        WINDOWS[query.window],
      ),
      statement(`, event_counts AS (
        SELECT endpoint_id, count(*) AS accepted,
          sum(status = 'delivered') AS acknowledged, sum(status = 'dead') AS dead,
          sum(status IN ('pending','retrying')) AS queued
        FROM window_events GROUP BY endpoint_id
      ), attempt_counts AS (
        SELECT endpoint_id, count(*) AS attempts, sum(${FAILED}) AS failedAttempts
        FROM window_attempts GROUP BY endpoint_id
      ), ranked AS (
        SELECT endpoint_id, duration_ms,
          row_number() OVER (PARTITION BY endpoint_id ORDER BY duration_ms, id) AS rank,
          count(*) OVER (PARTITION BY endpoint_id) AS size
        FROM window_attempts WHERE ${MEASURED}
      ) SELECT e.id AS endpointId, e.name, e.transport, e.enabled,
        coalesce(d.accepted, 0) AS accepted, coalesce(d.acknowledged, 0) AS acknowledged,
        coalesce(d.dead, 0) AS dead, coalesce(d.queued, 0) AS queued,
        coalesce(a.attempts, 0) AS attempts, coalesce(a.failedAttempts, 0) AS failedAttempts,
        r.duration_ms AS p95Ms
      FROM selected_endpoints e LEFT JOIN event_counts d ON d.endpoint_id = e.id
        LEFT JOIN attempt_counts a ON a.endpoint_id = e.id
        LEFT JOIN ranked r ON r.endpoint_id = e.id AND r.rank = (r.size * 95 + 99) / 100
      ORDER BY coalesce(d.accepted, 0) DESC, e.name COLLATE NOCASE, e.id`),
      statement(
        `SELECT count(*) AS total,
        coalesce(sum(e.enabled = 1 AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
          AND d.attempts < 4 AND d.lease_token IS NULL AND d.lease_until IS NULL), 0) AS due,
        min(d.created_at) AS oldestCreatedAt,
        (SELECT queue_paused FROM workspaces WHERE owner = ?) AS paused,
        coalesce(sum(e.enabled = 0), 0) AS blockedDisabled
      FROM events d JOIN selected_endpoints e ON e.id = d.endpoint_id
      WHERE d.status IN ('pending','retrying')`,
        now,
        this.owner,
      ),
    ]);
    // Missing and other owners' identifiers have exactly the same response.
    if (query.endpointId !== "all" && results[0].results.length === 0)
      throw new ApiError(404, "Connection not found.");
    const events = { ...results[1].results[0] } as unknown as EventCounts;
    const attempts = { ...results[2].results[0] } as unknown as AttemptCounts;
    const queue = results[7].results[0] as unknown as QueueCounts;
    return {
      ...query,
      since,
      now,
      events,
      attempts,
      httpStatuses: results[3].results.map((row) => ({
        ...row,
      })) as unknown as DeliveryInsights["httpStatuses"],
      failures: results[4].results.map((row) => ({
        ...row,
      })) as unknown as DeliveryInsights["failures"],
      timeline: results[5].results.map((row) => ({
        ...row,
      })) as unknown as DeliveryInsights["timeline"],
      endpoints: (results[6].results as unknown as EndpointStats[]).map(
        (endpoint) => ({
          ...endpoint,
          enabled: Boolean(endpoint.enabled),
        }),
      ),
      queue: { ...queue, paused: Boolean(queue.paused) },
    };
  }
}
