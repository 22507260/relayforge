import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { OperationsReport } from "../lib/contracts.ts";
import {
  ApiError,
  EVENT_LIMIT,
  MAX_ATTEMPTS,
  WORKER_HEARTBEAT_TTL_MS,
} from "../lib/server/domain.ts";
import {
  OperationsService,
  parseOperationsQuery,
} from "../lib/server/operations.ts";
import type { SqlDatabase } from "../lib/server/sql.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const NOW = 1_800_000_000_000;

function fixture(context: TestContext) {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  db.connection.exec(`
    INSERT INTO workspaces(owner,signing_secret,created_at) VALUES
      ('alice','secret-alice',1),('bob','secret-bob',1);
    INSERT INTO endpoints(id,owner,name,description,color,mode,transport,enabled) VALUES
      ('live','alice','Production','','lime','healthy','https',1),
      ('disabled','alice','Disabled','','lime','healthy','https',0),
      ('reference','alice','Reference','','lime','healthy','reference',1),
      ('lab','alice','Lab','','lime','healthy','demo',1),
      ('foreign','bob','Foreign','','lime','healthy','https',1);
  `);
  const event = (
    id: string,
    changes: {
      owner?: string;
      endpoint?: string;
      status?: string;
      createdAt?: number;
      next?: number | null;
      lease?: string | null;
      until?: number | null;
      attempts?: number;
    } = {},
  ) =>
    db.connection
      .prepare(
        `INSERT INTO deliveries
    (id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,created_at,updated_at,next_attempt_at,lease_token,lease_until,attempts)
    VALUES(?,?,?,'private.event','{"private":"do-not-expose"}','private-hash',?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        changes.owner ?? "alice",
        changes.endpoint ?? "live",
        id,
        changes.status ?? "pending",
        changes.createdAt ?? NOW - 1_000,
        NOW,
        changes.next === undefined ? NOW : changes.next,
        changes.lease ?? null,
        changes.until ?? null,
        changes.attempts ?? 0,
      );
  const heartbeat = (id: string, lastSeen: number) =>
    db.connection
      .prepare(
        "INSERT INTO worker_heartbeats(id,started_at,last_seen_at) VALUES(?,?,?)",
      )
      .run(id, NOW - 50_000, lastSeen);
  return {
    db,
    event,
    heartbeat,
    service: new OperationsService(db, "alice", () => NOW),
  };
}

function counts(report: OperationsReport) {
  return Object.fromEntries(
    report.queue.buckets.map((bucket) => [bucket.code, bucket.count]),
  );
}

test("operations accepts only a single bounded scope parameter", async (context) => {
  const parse = (query: string) =>
    parseOperationsQuery(
      new Request(`http://localhost/api/operations${query}`),
    );
  assert.deepEqual(parse(""), { scope: "live" });
  assert.deepEqual(parse("?scope=lab"), { scope: "lab" });
  for (const query of [
    "?scope=",
    "?scope=all",
    "?scope=live&scope=live",
    "?endpointId=all",
    "?scope=lab&page=1",
    "?__proto__=x",
  ])
    assert.throws(
      () => parse(query),
      (error) => error instanceof ApiError && error.status === 400,
    );
  const { service } = fixture(context);
  await assert.rejects(
    service.read("all" as "live"),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test("queue classification is a mutually exclusive complete partition with claim precedence", async (context) => {
  const { event, service } = fixture(context);
  event("in-flight", {
    endpoint: "disabled",
    lease: "active-token",
    until: NOW + 1,
    attempts: MAX_ATTEMPTS,
    next: NOW + 500,
  });
  event("expired", {
    endpoint: "disabled",
    lease: "expired-token",
    until: NOW,
    attempts: MAX_ATTEMPTS,
  });
  event("disabled", { endpoint: "disabled", attempts: MAX_ATTEMPTS });
  event("budget", { attempts: MAX_ATTEMPTS, next: NOW + 500 });
  event("scheduled", { next: NOW + 1 });
  event("due", { next: NOW });
  event("unscheduled", { next: null });
  event("missing-lease-deadline", { lease: "unknown-token", next: NOW - 1 });
  event("dead", { status: "dead" });
  event("delivered", { status: "delivered" });
  const report = await service.read();
  assert.equal(report.queue.total, 8);
  assert.deepEqual(counts(report), {
    in_flight: 1,
    lease_recovery: 1,
    disabled: 1,
    budget_exhausted: 1,
    scheduled: 1,
    due: 1,
    unscheduled: 2,
  });
  assert.equal(
    report.queue.buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    report.queue.total,
  );
  assert.equal(report.summary.dead, 1);
  assert.equal(
    report.connections.find(
      (connection) => connection.endpointId === "disabled",
    )?.needsAttention,
    true,
  );
  assert.equal(report.queue.oldestCreatedAt, NOW - 1_000);
});

test("operations reads full scoped history and keeps capacity workspace-wide with owner isolation", async (context) => {
  const { event, service } = fixture(context);
  for (let index = 0; index < 130; index++)
    event(`live-${index}`, { createdAt: NOW - 1_000 - index });
  event("future", { createdAt: NOW + 10_000 });
  event("lab", { endpoint: "lab", status: "dead" });
  event("reference", { endpoint: "reference" });
  event("foreign", { endpoint: "foreign", owner: "bob", status: "dead" });
  const live = await service.read();
  assert.equal(live.queue.total, 132);
  assert.equal(live.queue.oldestCreatedAt, NOW - 1_129);
  assert.equal(live.workspace.acceptedEvents, 133);
  assert.equal(live.workspace.remainingEvents, EVENT_LIMIT - 133);
  assert.equal(live.summary.dead, 0);
  assert.equal(live.connections.length, 3);
  assert.equal(
    live.connections.some((connection) => connection.endpointId === "foreign"),
    false,
  );
  const lab = await service.read("lab");
  assert.equal(lab.workspace.acceptedEvents, 133);
  assert.equal(lab.queue.total, 0);
  assert.equal(lab.summary.dead, 1);
  assert.deepEqual(
    lab.connections.map((connection) => connection.endpointId),
    ["lab"],
  );
  assert.equal(lab.summary.queuedLiveRequiresWorker, false);
});

test("heartbeat freshness excludes the TTL boundary and future observations", async (context) => {
  const { heartbeat, service } = fixture(context);
  heartbeat("expired", NOW - WORKER_HEARTBEAT_TTL_MS);
  heartbeat("future", NOW + 1);
  let report = await service.read();
  assert.equal(report.worker.online, false);
  assert.equal(report.worker.activeWorkers, 0);
  assert.equal(report.worker.lastHeartbeatAt, NOW - WORKER_HEARTBEAT_TTL_MS);
  heartbeat("active", NOW - WORKER_HEARTBEAT_TTL_MS + 1);
  heartbeat("now", NOW);
  report = await service.read();
  assert.equal(report.worker.online, true);
  assert.equal(report.worker.activeWorkers, 2);
  assert.equal(report.worker.lastHeartbeatAt, NOW);
  assert.equal(report.worker.heartbeatTtlMs, WORKER_HEARTBEAT_TTL_MS);
});

test("pause is independent from queue classes and offline worker only blocks live scope", async (context) => {
  const { db, event, heartbeat, service } = fixture(context);
  event("live-due");
  event("lab-due", { endpoint: "lab" });
  let live = await service.read();
  let lab = await service.read("lab");
  assert.equal(live.summary.queuedLiveRequiresWorker, true);
  assert.equal(
    live.connections.find((connection) => connection.endpointId === "live")
      ?.needsAttention,
    true,
  );
  assert.equal(lab.summary.queuedLiveRequiresWorker, false);
  assert.equal(lab.connections[0].needsAttention, false);
  db.connection
    .prepare("UPDATE workspaces SET queue_paused=1 WHERE owner='alice'")
    .run();
  heartbeat("worker", NOW);
  live = await service.read();
  lab = await service.read("lab");
  assert.equal(live.workspace.paused, true);
  assert.equal(live.summary.queuedLiveRequiresWorker, false);
  assert.equal(counts(live).due, 1);
  assert.equal(counts(lab).due, 1);
  assert.equal(lab.connections[0].needsAttention, true);
  assert.equal(
    live.connections.find((connection) => connection.endpointId === "reference")
      ?.needsAttention,
    false,
  );
});

test("empty reports include all buckets and capacity never becomes negative", async (context) => {
  const { event, service, db } = fixture(context);
  const empty = await service.read();
  assert.equal(empty.worker.lastHeartbeatAt, null);
  assert.equal(empty.queue.oldestCreatedAt, null);
  assert.equal(empty.queue.buckets.length, 7);
  assert.ok(
    empty.queue.buckets.every(
      (bucket) => bucket.count === 0 && bucket.oldestCreatedAt === null,
    ),
  );
  assert.equal(empty.summary.disabledConnections, 1);
  for (let index = 0; index <= EVENT_LIMIT; index++)
    event(`over-limit-${index}`, { status: "delivered" });
  assert.equal((await service.read()).workspace.remainingEvents, 0);
  assert.equal(
    (await new OperationsService(db, "missing", () => NOW).read()).workspace
      .acceptedEvents,
    0,
  );
});

test("operations is read-only, uses one consistent SQL batch and redacts delivery internals", async (context) => {
  const { event, service, db } = fixture(context);
  event("lease", { lease: "private-lease-token", until: NOW - 1 });
  db.connection
    .exec(`INSERT INTO connection_signing_keys(key_id,owner,endpoint_id,encrypted_secret,created_at)
    VALUES('private-key','bob','foreign','malformed-foreign-key',1)`);
  const before = db.connection
    .prepare("SELECT total_changes() AS changes")
    .get();
  let batches = 0;
  const original = db.batch.bind(db);
  db.batch = async (...args) => {
    batches++;
    return original(...args);
  };
  const result = await service.read();
  assert.equal(batches, 1);
  assert.deepEqual(
    db.connection.prepare("SELECT total_changes() AS changes").get(),
    before,
  );
  const serialized = JSON.stringify(result);
  for (const secret of [
    "secret-alice",
    "secret-bob",
    "private.event",
    "do-not-expose",
    "private-hash",
    "private-lease-token",
    "private-key",
    "malformed-foreign-key",
  ])
    assert.equal(serialized.includes(secret), false);
});

test("connection triage is stable and prioritizes actionable queue and dead counts", async (context) => {
  const { event, heartbeat, service } = fixture(context);
  heartbeat("online", NOW);
  event("disabled-one", { endpoint: "disabled" });
  event("disabled-two", { endpoint: "disabled" });
  event("reference-dead", { endpoint: "reference", status: "dead" });
  event("ordinary-due");
  const report = await service.read();
  assert.deepEqual(
    report.connections.map((connection) => connection.endpointId),
    ["disabled", "reference", "live"],
  );
  assert.deepEqual(
    report.connections.map((connection) => connection.needsAttention),
    [true, true, false],
  );
  assert.deepEqual((await service.read()).connections, report.connections);
});

test("operations propagates storage failures rather than reporting an empty healthy queue", async () => {
  const failure = new Error("storage unavailable");
  const db = {
    prepare: () => ({
      bind() {
        return this;
      },
    }),
    batch: async () => {
      throw failure;
    },
  } as unknown as SqlDatabase;
  await assert.rejects(
    new OperationsService(db, "alice", () => NOW).read(),
    (error) => error === failure,
  );
});
