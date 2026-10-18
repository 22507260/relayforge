import { WORKER_HEARTBEAT_TTL_MS } from "./domain.ts";
import { json } from "./http.ts";
import type { SqlDatabase } from "./sql.ts";

/** Web-process liveness has no database dependency. */
export function livenessResponse(): Response {
  return json({ status: "alive" });
}

/** Pipeline readiness reports no tenant, configuration or infrastructure details. */
export async function readinessResponse(
  getDatabase: () => SqlDatabase | Promise<SqlDatabase>,
  clock: () => number = Date.now,
): Promise<Response> {
  try {
    const db = await getDatabase();
    const now = clock();
    const probe = await db
      .prepare("SELECT 1 AS available")
      .first<{ available: number }>();
    const worker = await db
      .prepare(
        `SELECT count(*) AS activeWorkers FROM worker_heartbeats
      WHERE last_seen_at > ? AND last_seen_at <= ?`,
      )
      .bind(now - WORKER_HEARTBEAT_TTL_MS, now)
      .first<{ activeWorkers: number }>();
    if (probe?.available === 1 && worker && worker.activeWorkers > 0)
      return json({ status: "ready" });
  } catch {
    // Availability failures deliberately share the same fixed public response.
  }
  return json({ status: "not_ready" }, 503);
}
