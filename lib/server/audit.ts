import type { AuditPage, AuditQuery, AuditRecord } from "../contracts.ts";
import type { SqlDatabase } from "./sql.ts";

type AuditRow = {
  id: string;
  category: AuditRecord["category"];
  kind: AuditRecord["kind"];
  event_id: string | null;
  cycle: number | null;
  operation_id: string | null;
  message: string;
  created_at: number;
};

/** Security events belong to an account even before its relay workspace exists. */
export class AuditService {
  private db: SqlDatabase;
  private owner: string;
  constructor(db: SqlDatabase, owner: string) {
    this.db = db;
    this.owner = owner;
  }

  async list(query: AuditQuery): Promise<AuditPage> {
    const clauses: string[] = [];
    const filters: unknown[] = [this.owner, this.owner];
    if (query.category !== "all") {
      clauses.push("category = ?");
      filters.push(query.category);
    }
    if (query.kind !== "all") {
      clauses.push("kind = ?");
      filters.push(query.kind);
    }
    if (query.eventId !== "all") {
      clauses.push("event_id = ?");
      filters.push(query.eventId);
    }
    if (query.operationId !== "all") {
      clauses.push("operation_id = ?");
      filters.push(query.operationId);
    }
    if (query.from !== null) {
      clauses.push("created_at >= ?");
      filters.push(query.from);
    }
    if (query.to !== null) {
      clauses.push("created_at <= ?");
      filters.push(query.to);
    }
    if (query.search) {
      clauses.push(
        "instr(lower(id || ' ' || message || ' ' || coalesce(event_id, '') || ' ' || coalesce(operation_id, '')), lower(?)) > 0",
      );
      filters.push(query.search);
    }
    const filtered = `WITH records AS (
      SELECT id, 'delivery' AS category, kind, event_id, cycle, operation_id, message, created_at
      FROM activity WHERE owner = ?
      UNION ALL
      SELECT id, 'security' AS category, kind, NULL AS event_id, NULL AS cycle, NULL AS operation_id, message, created_at
      FROM security_events WHERE owner = ?
    ), filtered AS (SELECT * FROM records ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""})`;
    // Both count and rows observe the same transaction, including a clamped page.
    const results = await this.db.batch<AuditRow | { total: number }>([
      this.db
        .prepare(`${filtered} SELECT count(*) AS total FROM filtered`)
        .bind(...filters),
      this.db
        .prepare(
          `${filtered} SELECT * FROM filtered
        ORDER BY created_at DESC, category ASC, id DESC LIMIT ?
        OFFSET min(?, max(0, (SELECT (count(*) - 1) / ? FROM filtered)) * ?)`,
        )
        .bind(
          ...filters,
          query.pageSize,
          (query.page - 1) * query.pageSize,
          query.pageSize,
          query.pageSize,
        ),
    ]);
    const total = (results[0].results[0] as { total: number }).total;
    const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    return {
      total,
      totalPages,
      page: Math.min(query.page, totalPages),
      pageSize: query.pageSize,
      records: (results[1].results as AuditRow[]).map((row) => ({
        id: row.id,
        category: row.category,
        kind: row.kind,
        eventId: row.event_id,
        cycle: row.cycle,
        operationId: row.operation_id,
        message: row.message,
        createdAt: row.created_at,
      })),
    };
  }
}
