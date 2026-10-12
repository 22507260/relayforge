import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DeliveryQuery } from "../lib/contracts.ts";
import { SqliteDatabase } from "../lib/server/database.ts";
import { ApiError } from "../lib/server/domain.ts";
import { RelayService } from "../lib/server/service.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const query = (values: Partial<DeliveryQuery> = {}): DeliveryQuery => ({
  page: 1,
  pageSize: 20,
  search: "",
  status: "dead",
  endpointId: "all",
  ...values,
});

async function fixture(context: TestContext) {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  let now = 1_800_000_000_000;
  const service = new RelayService(
    db,
    "alice",
    () => now,
    () => 0.5,
  );
  await service.initialize();
  const endpoints = (await service.snapshot()).endpoints;
  return {
    db,
    service,
    endpoints,
    advance: () => {
      now += 10_000;
    },
    clock: () => now,
  };
}

async function exhaust(service: RelayService, advance: () => void) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await service.pump();
    advance();
  }
}

test("upgrading an existing database preserves immutable events and marks old attempts as legacy history", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-upgrade-"));
  let upgraded: SqliteDatabase | undefined = undefined;
  context.after(() => {
    upgraded?.close();
    rmSync(directory, { recursive: true });
  });
  const migrations = join(directory, "old-migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(join(process.cwd(), "drizzle"))) {
    if (/^000[012]_.*\.sql$/.test(file))
      copyFileSync(
        join(process.cwd(), "drizzle", file),
        join(migrations, file),
      );
  }
  const filename = join(directory, "queue.sqlite");
  const old = new SqliteDatabase(filename, migrations);
  old.connection.exec(`
    INSERT INTO workspaces (owner, signing_secret, created_at) VALUES ('alice', 'test-secret', 100);
    INSERT INTO endpoints (id, owner, name, description, color, mode) VALUES ('legacy-endpoint', 'alice', 'Legacy', '', '#fff', 'failing');
    INSERT INTO deliveries (id, owner, endpoint_id, event_type, payload, payload_hash, idempotency_key, status, attempts, created_at, updated_at)
      VALUES ('legacy-event', 'alice', 'legacy-endpoint', 'legacy.completed', '{"order":42}', 'unchanged-hash', 'legacy-key', 'dead', 4, 100, 200);
    INSERT INTO attempts (id, owner, event_id, number, status_code, error, created_at, finished_at)
      VALUES ('legacy-attempt', 'alice', 'legacy-event', 4, 500, 'Original error', 200, 200);
    INSERT INTO activity (id, owner, kind, event_id, message, created_at)
      VALUES ('legacy-activity', 'alice', 'dead', 'legacy-event', 'Original audit', 200);
  `);
  const original = old.connection.prepare("SELECT * FROM deliveries").get()!;
  old.close();
  upgraded = new SqliteDatabase(filename);
  const service = new RelayService(upgraded, "alice");
  const detail = await service.detail("legacy-event");
  assert.equal(detail.delivery.currentCycle, 1);
  assert.equal(detail.attempts[0].cycle, null);
  assert.equal(detail.delivery.latestAttempt?.cycle, null);
  assert.equal(detail.attempts[0].error, "Original error");
  assert.equal((await service.snapshot()).activity[0].cycle, null);
  const migrated = upgraded.connection
    .prepare("SELECT * FROM deliveries")
    .get()!;
  for (const [key, value] of Object.entries(original))
    assert.equal(migrated[key], value);
  await service.replayBatch({
    items: [{ eventId: "legacy-event", expectedCycle: 1 }],
  });
  await service.pump();
  const replayed = await service.detail("legacy-event");
  assert.equal(replayed.delivery.currentCycle, 2);
  assert.deepEqual(
    replayed.attempts.map((attempt) => attempt.cycle),
    [null, 2],
  );
  assert.equal(replayed.delivery.latestAttempt?.cycle, 2);
});

test("batch replay preserves event identity and immutable data while new claims record their cycle", async (context) => {
  const { db, service, endpoints, advance } = await fixture(context);
  const endpoint = endpoints.find((row) => row.mode === "failing")!;
  const event = await service.send(
    endpoint.id,
    "order.completed",
    { order: 42 },
    "order-42",
  );
  await exhaust(service, advance);
  const original = db.connection
    .prepare(
      "SELECT id, endpoint_id, payload, payload_hash, idempotency_key, created_at FROM deliveries WHERE id = ?",
    )
    .get(event);
  const initial = await service.detail(event);
  assert.equal(initial.delivery.status, "dead");
  assert.deepEqual(
    initial.attempts.map((attempt) => attempt.cycle),
    [1, 1, 1, 1],
  );
  await service.action({
    type: "set-receiver",
    endpointId: endpoint.id,
    mode: "healthy",
  });
  const replayed = await service.replayBatch({
    items: [{ eventId: event, expectedCycle: 1 }],
  });
  assert.deepEqual(replayed.results, [
    { eventId: event, outcome: "replayed", currentCycle: 2 },
  ]);
  await service.pump();
  const recovered = await service.detail(event);
  assert.equal(recovered.delivery.status, "delivered");
  assert.equal(recovered.delivery.attempts, 1);
  assert.deepEqual(recovered.attempts.slice(0, 4), initial.attempts);
  assert.equal(recovered.attempts[4].cycle, 2);
  assert.equal(recovered.attempts[4].number, 1);
  assert.deepEqual(
    db.connection
      .prepare(
        "SELECT id, endpoint_id, payload, payload_hash, idempotency_key, created_at FROM deliveries WHERE id = ?",
      )
      .get(event),
    original,
  );
  await service.action({ type: "replay", eventId: event, expectedCycle: 2 });
  assert.equal((await service.detail(event)).delivery.currentCycle, 3);
  assert.equal((await service.detail(event)).attempts.at(-1)?.cycle, 3);
  assert.equal((await service.snapshot()).metrics.businessEffects, 1);
  const audit = (await service.snapshot()).activity.filter(
    (entry) => entry.kind === "replay",
  );
  assert.ok(audit.every((entry) => entry.cycle && entry.operationId));
});

test("mixed replay skips stale, leased, non-dead and inaccessible records without exposing another workspace", async (context) => {
  const { db, service, endpoints, advance, clock } = await fixture(context);
  const failing = endpoints.find((row) => row.mode === "failing")!;
  const healthy = endpoints.find((row) => row.mode === "healthy")!;
  const eligible = await service.send(failing.id, "eligible");
  const stale = await service.send(failing.id, "stale");
  const leased = await service.send(failing.id, "leased");
  const delivered = await service.send(healthy.id, "delivered");
  await exhaust(service, advance);
  db.connection
    .prepare("UPDATE deliveries SET current_cycle = 2 WHERE id = ?")
    .run(stale);
  db.connection
    .prepare(
      "UPDATE deliveries SET lease_token = 'active', lease_until = ? WHERE id = ?",
    )
    .run(clock() + 15_000, leased);
  const bob = new RelayService(db, "bob", clock);
  await bob.initialize();
  const foreign = await bob.send(
    (await bob.snapshot()).endpoints[0].id,
    "foreign",
  );
  const queued = await service.send(healthy.id, "queued");
  const ids = [
    eligible,
    stale,
    leased,
    delivered,
    queued,
    foreign,
    "missing-event",
  ];
  const result = await service.replayBatch({
    items: ids.map((eventId) => ({ eventId, expectedCycle: 1 })),
  });
  assert.equal(result.results[0].outcome, "replayed");
  assert.ok(
    result.results.slice(1).every((item) => item.outcome === "skipped"),
  );
  assert.equal(result.results.at(-1)?.currentCycle, null);
  assert.equal(result.results.at(-2)?.currentCycle, null);
  assert.equal((await bob.detail(foreign)).delivery.currentCycle, 1);
  const audit = (await service.snapshot()).activity.filter(
    (entry) => entry.kind === "replay",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].eventId, eligible);
});

test("a system failure rolls back the entire replay batch including its audit records", async (context) => {
  const { db, service, endpoints, advance } = await fixture(context);
  const failing = endpoints.find((row) => row.mode === "failing")!;
  const first = await service.send(failing.id, "first");
  const second = await service.send(failing.id, "second");
  await exhaust(service, advance);
  db.connection.exec(`CREATE TRIGGER reject_replay BEFORE INSERT ON activity
    WHEN NEW.kind = 'replay' AND NEW.event_id = '${second}'
    BEGIN SELECT RAISE(ABORT, 'forced replay failure'); END;`);
  await assert.rejects(
    service.replayBatch({
      items: [first, second].map((eventId) => ({ eventId, expectedCycle: 1 })),
    }),
  );
  for (const event of [first, second]) {
    const detail = await service.detail(event);
    assert.equal(detail.delivery.status, "dead");
    assert.equal(detail.delivery.currentCycle, 1);
    assert.equal(detail.delivery.attempts, 4);
    assert.equal(detail.attempts.length, 4);
  }
  assert.equal(
    (await service.snapshot()).activity.filter(
      (entry) => entry.kind === "replay",
    ).length,
    0,
  );
});

test("independent SQLite connections replay an expected cycle only once", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-replay-race-"));
  const first = new SqliteTestDatabase(join(directory, "queue.sqlite"));
  const second = new SqliteTestDatabase(join(directory, "queue.sqlite"));
  context.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true });
  });
  let now = 1_800_000_000_000;
  const a = new RelayService(first, "alice", () => now);
  const b = new RelayService(second, "alice", () => now);
  await a.initialize();
  const endpoint = (await a.snapshot()).endpoints.find(
    (row) => row.mode === "failing",
  )!;
  const event = await a.send(endpoint.id, "race");
  await exhaust(a, () => {
    now += 10_000;
  });
  const request = { items: [{ eventId: event, expectedCycle: 1 }] };
  const results = await Promise.all([
    a.replayBatch(request),
    b.replayBatch(request),
  ]);
  assert.deepEqual(
    results
      .flatMap((result) => result.results.map((item) => item.outcome))
      .sort(),
    ["replayed", "skipped"],
  );
  assert.equal((await a.detail(event)).delivery.currentCycle, 2);
  const audit = (await b.snapshot()).activity.filter(
    (entry) => entry.kind === "replay",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].cycle, 2);
});

test("paused replay waits in the queue and validates bounds before any database changes", async (context) => {
  const { service, endpoints, advance } = await fixture(context);
  const endpoint = endpoints.find((row) => row.mode === "failing")!;
  const event = await service.send(endpoint.id, "pause");
  await exhaust(service, advance);
  await service.action({ type: "pause", paused: true });
  const invalid = [
    { items: [] },
    {
      items: Array.from({ length: 21 }, (_, index) => ({
        eventId: `event-${index}`,
        expectedCycle: 1,
      })),
    },
    {
      items: [
        { eventId: event, expectedCycle: 1 },
        { eventId: event, expectedCycle: 1 },
      ],
    },
    { items: [{ eventId: event, expectedCycle: 0 }] },
    { items: [{ eventId: event, expectedCycle: 1.5 }] },
  ];
  for (const request of invalid)
    await assert.rejects(
      service.replayBatch(request),
      (error: unknown) => error instanceof ApiError && error.status === 400,
    );
  assert.equal((await service.detail(event)).delivery.currentCycle, 1);
  await service.replayBatch({ items: [{ eventId: event, expectedCycle: 1 }] });
  await service.pump();
  const paused = await service.detail(event);
  assert.equal(paused.delivery.currentCycle, 2);
  assert.equal(paused.delivery.status, "pending");
  assert.equal(paused.delivery.attempts, 0);
  assert.equal(paused.attempts.length, 4);
  await service.action({
    type: "set-receiver",
    endpointId: endpoint.id,
    mode: "healthy",
  });
  await service.action({ type: "pause", paused: false });
  await service.pump();
  assert.equal((await service.detail(event)).delivery.status, "delivered");
});

test("the dead delivery list searches beyond the snapshot limit and paginates all recovery candidates", async (context) => {
  const { db, service, endpoints } = await fixture(context);
  const endpoint = endpoints.find((row) => row.mode === "failing")!;
  const ids: string[] = [];
  for (let index = 0; index < 125; index++)
    ids.push(
      await service.send(
        endpoint.id,
        index === 0 ? "old.recovery" : "invoice.failed",
        { index },
      ),
    );
  db.connection
    .prepare(
      "UPDATE deliveries SET status = 'dead', attempts = 4, next_attempt_at = NULL WHERE owner = 'alice'",
    )
    .run();
  assert.equal((await service.snapshot()).deliveries.length, 100);
  const older = await service.listDeliveries(
    query({ search: "OLD.RECOVERY", endpointId: endpoint.id, pageSize: 10 }),
  );
  assert.equal(older.total, 1);
  assert.equal(older.deliveries[0].id, ids[0]);
  const page = await service.listDeliveries(query({ page: 7, pageSize: 20 }));
  assert.equal(page.total, 125);
  assert.equal(page.totalPages, 7);
  assert.deepEqual(
    page.deliveries.map((delivery) => delivery.id),
    ids.slice(0, 5).toReversed(),
  );
});

test("the persisted recovery guide uses real fallback claims, protects managed records and restarts once", async (context) => {
  const { db, service, endpoints, advance, clock } = await fixture(context);
  await service.action({ type: "pause", paused: true });
  const [first, repeated] = await Promise.all([
    service.action({ type: "start-recovery-demo" }),
    service.action({ type: "start-recovery-demo" }),
  ]);
  assert.equal(first.recoveryDemo?.eventId, repeated.recoveryDemo?.eventId);
  assert.equal(repeated.metrics.total, 1);
  assert.equal(repeated.system.queuePaused, true);
  const demo = repeated.recoveryDemo!;
  assert.equal(demo.stage, "failing");
  assert.equal(demo.delivery.attempts, 0);
  assert.equal(
    repeated.endpoints.find((endpoint) => endpoint.id === demo.endpointId)
      ?.purpose,
    "recovery",
  );
  assert.deepEqual(
    repeated.endpoints
      .filter((endpoint) => endpoint.purpose === "standard")
      .map((endpoint) => ({ id: endpoint.id, mode: endpoint.mode })),
    endpoints.map((endpoint) => ({ id: endpoint.id, mode: endpoint.mode })),
  );
  await assert.rejects(
    service.send(demo.endpointId, "unauthorized.send"),
    ApiError,
  );
  await assert.rejects(
    service.action({
      type: "set-receiver",
      endpointId: demo.endpointId,
      mode: "healthy",
    }),
    ApiError,
  );
  await assert.rejects(
    service.action({
      type: "repair-recovery-demo",
      eventId: demo.eventId,
      expectedCycle: 1,
    }),
    ApiError,
  );
  await service.action({ type: "pause", paused: false });
  await exhaust(service, advance);
  const failed = (await service.snapshot()).recoveryDemo!;
  assert.equal(failed.stage, "awaiting-repair");
  assert.equal(failed.delivery.status, "dead");
  assert.equal((await service.detail(demo.eventId)).attempts.length, 4);
  assert.equal(
    (
      await service.replayBatch({
        items: [{ eventId: demo.eventId, expectedCycle: 1 }],
      })
    ).results[0].outcome,
    "skipped",
  );
  await assert.rejects(
    service.action({ type: "replay", eventId: demo.eventId, expectedCycle: 1 }),
    ApiError,
  );
  const reopened = new RelayService(db, "alice", clock);
  assert.equal(
    (await reopened.snapshot()).recoveryDemo?.stage,
    "awaiting-repair",
  );
  await service.action({
    type: "repair-recovery-demo",
    eventId: demo.eventId,
    expectedCycle: 1,
  });
  assert.equal(
    (await reopened.snapshot()).recoveryDemo?.stage,
    "ready-to-replay",
  );
  await service.action({ type: "pause", paused: true });
  const replayed = await service.action({
    type: "replay-recovery-demo",
    eventId: demo.eventId,
    expectedCycle: 1,
  });
  assert.equal(replayed.recoveryDemo?.stage, "recovering");
  assert.equal(replayed.recoveryDemo?.delivery.currentCycle, 2);
  await service.pump();
  assert.equal((await service.detail(demo.eventId)).attempts.length, 4);
  await service.action({ type: "pause", paused: false });
  await service.pump();
  const complete = (await reopened.snapshot()).recoveryDemo!;
  assert.equal(complete.stage, "completed");
  assert.equal(complete.eventId, demo.eventId);
  assert.equal(complete.businessEffects, 1);
  assert.deepEqual(
    (await service.detail(demo.eventId)).attempts.map(
      (attempt) => attempt.cycle,
    ),
    [1, 1, 1, 1, 2],
  );
  await assert.rejects(
    service.action({
      type: "replay-recovery-demo",
      eventId: demo.eventId,
      expectedCycle: 1,
    }),
    ApiError,
  );
  assert.equal(
    (await service.action({ type: "start-recovery-demo" })).recoveryDemo
      ?.eventId,
    demo.eventId,
  );
  await service.action({ type: "pause", paused: true });
  const restart = await service.action({
    type: "start-recovery-demo",
    previousEventId: demo.eventId,
  });
  const repeatedRestart = await service.action({
    type: "start-recovery-demo",
    previousEventId: demo.eventId,
  });
  assert.notEqual(restart.recoveryDemo?.eventId, demo.eventId);
  assert.equal(
    restart.recoveryDemo?.eventId,
    repeatedRestart.recoveryDemo?.eventId,
  );
  assert.equal(repeatedRestart.metrics.total, 2);
  assert.equal(
    repeatedRestart.endpoints.filter(
      (endpoint) => endpoint.purpose === "recovery",
    ).length,
    1,
  );
  assert.equal(
    (await service.detail(demo.eventId)).delivery.status,
    "delivered",
  );
  assert.equal((await service.detail(demo.eventId)).attempts.length, 5);
});

test("starting the guide at workspace capacity cannot leave an orphan receiver or scenario", async (context) => {
  const { db, service, endpoints } = await fixture(context);
  const endpoint = endpoints[0];
  const limit = (await service.snapshot()).system.eventLimit;
  const statement = db.connection.prepare(
    "INSERT INTO deliveries (id, owner, endpoint_id, event_type, payload, payload_hash, idempotency_key, created_at, updated_at) VALUES (?, 'alice', ?, 'capacity', '{}', 'test', ?, 100, 100)",
  );
  for (let index = 0; index < limit; index++)
    statement.run(`capacity-${index}`, endpoint.id, `capacity-${index}`);
  await assert.rejects(
    service.action({ type: "start-recovery-demo" }),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
  const snapshot = await service.snapshot();
  assert.equal(snapshot.recoveryDemo, null);
  assert.equal(snapshot.endpoints.length, endpoints.length);
  assert.equal(snapshot.metrics.total, limit);
});
