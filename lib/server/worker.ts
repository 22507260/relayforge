import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { MAX_ATTEMPTS, WORKER_HEARTBEAT_TTL_MS } from "./domain.ts";
import { RelayService } from "./service.ts";
import type { SqlDatabase } from "./sql.ts";

export const WORKER_INTERVAL_MS = 1_000;
const WORKSPACES_PER_TICK = 100;
const STALE_HEARTBEATS_PER_TICK = 100;

interface WorkerOptions {
  clock?: () => number;
  onError?: (error: unknown) => void;
}

/** A separate process schedules the same owner-scoped, lease-protected processor. */
export class RelayWorker {
  readonly id = randomUUID();
  private readonly db: SqlDatabase;
  private readonly clock: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly startedAt: number;
  private inFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopped = false;
  private running = false;

  constructor(db: SqlDatabase, options: WorkerOptions = {}) {
    this.db = db;
    this.clock = options.clock ?? Date.now;
    this.onError = options.onError ?? (() => undefined);
    this.startedAt = this.clock();
  }

  private async heartbeat(): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO worker_heartbeats (id, started_at, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .bind(this.id, this.startedAt, this.clock())
      .run();
  }

  private async processTick(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    const now = this.clock();
    await this.db
      .prepare(
        `DELETE FROM worker_heartbeats WHERE id IN (
           SELECT id FROM worker_heartbeats WHERE id != ? AND last_seen_at <= ?
           ORDER BY last_seen_at LIMIT ?
         )`,
      )
      .bind(this.id, now - WORKER_HEARTBEAT_TTL_MS, STALE_HEARTBEATS_PER_TICK)
      .run();
    await this.heartbeat();

    // Owners come only from durable server state. Browser input cannot pick one.
    const owners = await this.db
      .prepare(
        `SELECT d.owner FROM deliveries d
         JOIN workspaces w ON w.owner = d.owner
         WHERE w.queue_paused = 0 AND (
           (d.lease_token IS NOT NULL AND d.lease_until <= ?) OR
           (d.lease_token IS NULL AND d.status IN ('pending', 'retrying')
            AND d.next_attempt_at <= ? AND d.attempts < ?)
         )
         GROUP BY d.owner
         ORDER BY MIN(CASE WHEN d.lease_token IS NOT NULL THEN d.lease_until ELSE d.next_attempt_at END), d.owner
         LIMIT ?`,
      )
      .bind(now, now, MAX_ATTEMPTS, WORKSPACES_PER_TICK)
      .all<{ owner: string }>();

    for (const { owner } of owners.results) {
      if (this.stopped || signal?.aborted) break;
      await this.heartbeat();
      try {
        await new RelayService(this.db, owner, this.clock).pump();
      } catch (error) {
        // A failed workspace does not prevent other workspaces from progressing.
        this.onError(error);
      }
    }
    await this.heartbeat();
  }

  /** Calls share the current cycle; a timer cannot start an overlapping pump. */
  async tick(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return this.inFlight;
    const current = this.processTick(signal);
    this.inFlight = current;
    try {
      await current;
    } finally {
      if (this.inFlight === current) this.inFlight = null;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("This worker is already running.");
    if (this.stopped) throw new Error("This worker has stopped.");
    this.running = true;
    try {
      while (!signal.aborted && !this.stopped) {
        try {
          await this.tick(signal);
        } catch (error) {
          this.onError(error);
        }
        if (signal.aborted || this.stopped) break;
        try {
          await wait(WORKER_INTERVAL_MS, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    } finally {
      await this.stop();
      this.running = false;
    }
  }

  /** Finish the current claim before removing only this process's heartbeat. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.stopPromise = (async () => {
      await this.inFlight;
      await this.db
        .prepare("DELETE FROM worker_heartbeats WHERE id = ?")
        .bind(this.id)
        .run();
    })();
    return this.stopPromise;
  }
}
