import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { InsightsQuery } from "../lib/contracts.ts";
import { ApiError } from "../lib/server/domain.ts";
import { InsightsService, parseInsightsQuery } from "../lib/server/insights.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const query = (changes: Partial<InsightsQuery> = {}): InsightsQuery => ({
  window: "1h",
  scope: "live",
  endpointId: "all",
  ...changes,
});

function fixture(context: TestContext) {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  db.connection.exec(`
    INSERT INTO workspaces(owner,signing_secret,created_at) VALUES
      ('alice','private-workspace-key',1),('bob','foreign-key',1);
    INSERT INTO endpoints(id,owner,name,description,color,mode,transport,enabled) VALUES
      ('live-a','alice','Production','','#fff','healthy','https',1),
      ('live-b','alice','Reference','','#fff','healthy','reference',1),
      ('lab-a','alice','Lab','','#fff','healthy','demo',1),
      ('foreign-a','bob','Foreign','','#fff','healthy','https',1);
  `);
  const event = (
    id: string,
    values: {
      endpointId?: string;
      owner?: string;
      createdAt?: number;
      status?: string;
      nextAttemptAt?: number | null;
      leaseToken?: string | null;
      leaseUntil?: number | null;
      attempts?: number;
    } = {},
  ) => {
    db.connection
      .prepare(
        `INSERT INTO deliveries
      (id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,created_at,updated_at,next_attempt_at,lease_token,lease_until,attempts)
      VALUES (?,?,?,'insights.test','{"private":"payload-must-not-leak"}','private-payload-hash',?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        values.owner ?? "alice",
        values.endpointId ?? "live-a",
        id,
        values.status ?? "pending",
        values.createdAt ?? NOW - 1_000,
        NOW,
        values.nextAttemptAt === undefined ? NOW - 1 : values.nextAttemptAt,
        values.leaseToken ?? null,
        values.leaseUntil ?? null,
        values.attempts ?? 0,
      );
  };
  const attempt = (
    id: string,
    eventId: string,
    values: {
      owner?: string;
      createdAt?: number;
      finishedAt?: number | null;
      statusCode?: number | null;
      duration?: number;
      failureCode?: string | null;
    } = {},
  ) => {
    db.connection
      .prepare(
        `INSERT INTO attempts
      (id,owner,event_id,number,cycle,status_code,error,duration_ms,created_at,finished_at,failure_code)
      VALUES (?,?,?,1,1,?,'private-error-must-not-leak',?,?,?,?)`,
      )
      .run(
        id,
        values.owner ?? "alice",
        eventId,
        values.statusCode === undefined ? 204 : values.statusCode,
        values.duration ?? 10,
        values.createdAt ?? NOW - 500,
        values.finishedAt === undefined ? NOW - 400 : values.finishedAt,
        values.failureCode ?? null,
      );
  };
  return {
    db,
    event,
    attempt,
    service: new InsightsService(db, "alice", () => NOW),
  };
}

test("insights parses bounded strict filters and rejects duplicate or unknown parameters", () => {
  const parse = (params: string) =>
    parseInsightsQuery(new Request(`http://localhost/api/insights${params}`));
  assert.deepEqual(parse(""), {
    window: "24h",
    scope: "live",
    endpointId: "all",
  });
  assert.deepEqual(parse("?window=7d&scope=lab&endpointId=lab-a"), {
    window: "7d",
    scope: "lab",
    endpointId: "lab-a",
  });
  for (const params of [
    "?window=1d",
    "?window=",
    "?scope=all",
    "?endpointId=",
    "?endpointId=a.b",
    "?endpointId=" + "a".repeat(101),
    "?limit=100",
    "?window=1h&window=7d",
    "?scope=live&%73cope=lab",
    "?__proto__=live",
    "?constructor=live",
    "?owner=bob",
  ])
    assert.throws(
      () => parse(params),
      (error) => error instanceof ApiError && error.status === 400,
      params,
    );
});

test("insights counts all owned history beyond the snapshot limit and splits Live from Lab", async (context) => {
  const f = fixture(context);
  for (let index = 0; index < 130; index++) {
    f.event(`owned-${index}`, {
      status: index < 100 ? "delivered" : index < 120 ? "dead" : "retrying",
    });
    f.attempt(`owned-attempt-${index}`, `owned-${index}`);
  }
  f.event("reference", { endpointId: "live-b", status: "delivered" });
  f.event("lab", { endpointId: "lab-a", status: "delivered" });
  f.event("foreign", { endpointId: "foreign-a", owner: "bob", status: "dead" });
  f.attempt("foreign-attempt", "foreign", { owner: "bob", statusCode: 500 });
  const live = await f.service.read(query());
  assert.deepEqual(live.events, {
    accepted: 131,
    acknowledged: 101,
    dead: 20,
    queued: 10,
  });
  assert.equal(live.attempts.total, 130);
  assert.deepEqual(
    live.endpoints.map((endpoint) => endpoint.endpointId),
    ["live-a", "live-b"],
  );
  assert.equal(live.endpoints[0].accepted, 130);
  assert.equal(live.endpoints[0].enabled, true);
  const lab = await f.service.read(query({ scope: "lab" }));
  assert.deepEqual(lab.events, {
    accepted: 1,
    acknowledged: 1,
    dead: 0,
    queued: 0,
  });
  assert.deepEqual(
    lab.endpoints.map((endpoint) => endpoint.endpointId),
    ["lab-a"],
  );
  const filtered = await f.service.read(query({ endpointId: "live-b" }));
  assert.equal(filtered.events.accepted, 1);
  assert.equal(filtered.endpoints.length, 1);
  assert.equal(filtered.attempts.total, 0);
  assert.equal(
    (await f.service.read(query({ endpointId: "lab-a" }))).events.accepted,
    0,
  );
});

test("foreign and missing connection filters have the same generic response", async (context) => {
  const { service } = fixture(context);
  for (const endpointId of ["foreign-a", "missing-a"])
    await assert.rejects(
      service.read(query({ endpointId })),
      (error) =>
        error instanceof ApiError &&
        error.status === 404 &&
        error.message === "Connection not found.",
    );
  await assert.rejects(
    service.read(query({ window: "invalid" as InsightsQuery["window"] })),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test("nearest-rank latency includes measured zero and excludes unfinished and unmeasured history", async (context) => {
  const f = fixture(context);
  f.event("measured", { status: "delivered" });
  for (let index = 0; index < 20; index++)
    f.attempt(`latency-${index}`, "measured", { duration: index * 10 });
  f.attempt("unfinished", "measured", {
    finishedAt: null,
    statusCode: null,
    duration: 99_999,
  });
  f.attempt("unmeasured", "measured", { statusCode: null, duration: 0 });
  const result = await f.service.read(query());
  assert.deepEqual(result.attempts, {
    total: 22,
    completed: 21,
    acknowledged: 20,
    failed: 0,
    inFlight: 1,
    unmeasuredInterrupted: 1,
    measured: 20,
    p50Ms: 90,
    p95Ms: 180,
    maxMs: 190,
  });
  assert.equal(result.endpoints[0].p95Ms, 180);
  assert.deepEqual(result.httpStatuses, [{ statusCode: 204, count: 20 }]);
  const reference = result.endpoints.find(
    (endpoint) => endpoint.endpointId === "live-b",
  )!;
  assert.equal(reference.p95Ms, null);
  f.event("zero-event", { endpointId: "live-b" });
  f.attempt("zero-attempt", "zero-event", {
    duration: 0,
    statusCode: null,
    failureCode: "timeout",
  });
  const zero = await f.service.read(query({ endpointId: "live-b" }));
  assert.equal(zero.attempts.p50Ms, 0);
  assert.equal(zero.attempts.p95Ms, 0);
  assert.equal(zero.attempts.failed, 1);
});

test("HTTP and network outcomes remain distinct and arbitrary failure text is redacted", async (context) => {
  const f = fixture(context);
  f.event("outcomes");
  f.attempt("ok", "outcomes", { statusCode: 200 });
  f.attempt("redirect", "outcomes", {
    statusCode: 302,
    failureCode: "http_rejected",
  });
  f.attempt("limited", "outcomes", { statusCode: 429 });
  f.attempt("unavailable", "outcomes", { statusCode: 503 });
  f.attempt("timeout", "outcomes", {
    statusCode: null,
    failureCode: "timeout",
  });
  f.attempt("dns", "outcomes", { statusCode: null, failureCode: "dns_failed" });
  f.attempt("unknown", "outcomes", {
    statusCode: null,
    failureCode: "private-failure-code-must-not-leak",
  });
  f.attempt("interrupted", "outcomes", { statusCode: null });
  f.attempt("inflight", "outcomes", { statusCode: null, finishedAt: null });
  const result = await f.service.read(query());
  assert.equal(result.attempts.total, 9);
  assert.equal(result.attempts.completed, 8);
  assert.equal(result.attempts.failed, 6);
  assert.equal(result.attempts.measured, 7);
  assert.deepEqual(result.httpStatuses, [
    { statusCode: 200, count: 1 },
    { statusCode: 302, count: 1 },
    { statusCode: 429, count: 1 },
    { statusCode: 503, count: 1 },
    { statusCode: null, count: 3 },
  ]);
  assert.deepEqual(result.failures.map((row) => row.category).sort(), [
    "dns_failed",
    "http_3xx",
    "http_4xx",
    "http_5xx",
    "timeout",
    "unclassified",
  ]);
  const serialized = JSON.stringify(result);
  for (const secret of [
    "private-workspace-key",
    "payload-must-not-leak",
    "private-payload-hash",
    "private-error-must-not-leak",
    "private-failure-code-must-not-leak",
  ])
    assert.equal(serialized.includes(secret), false);
});

test("event cohorts and attempt windows use inclusive UTC bounds with twelve non-overlapping buckets", async (context) => {
  const f = fixture(context);
  const since = NOW - HOUR;
  f.event("before", { createdAt: since - 1, status: "delivered" });
  f.event("start", { createdAt: since, status: "delivered" });
  f.event("boundary", { createdAt: since + HOUR / 12, status: "delivered" });
  f.event("end", { createdAt: NOW, status: "dead" });
  f.event("future", { createdAt: NOW + 1, status: "delivered" });
  f.attempt("old-attempt", "before", { createdAt: since - 1 });
  f.attempt("old-event-new-attempt", "before", { createdAt: since });
  f.attempt("start-attempt", "start", { createdAt: since });
  f.attempt("boundary-attempt", "boundary", {
    createdAt: since + HOUR / 12,
    statusCode: 429,
  });
  f.attempt("end-attempt", "end", {
    createdAt: NOW,
    statusCode: null,
    failureCode: "timeout",
  });
  f.attempt("future-attempt", "end", { createdAt: NOW + 1 });
  f.attempt("future-event-attempt", "future", { createdAt: NOW });
  const result = await f.service.read(query());
  assert.equal(result.since, since);
  assert.equal(result.now, NOW);
  assert.equal(result.events.accepted, 3);
  assert.equal(result.attempts.total, 4);
  assert.equal(result.timeline.length, 12);
  assert.deepEqual(result.timeline[0], {
    startAt: since,
    endAt: since + HOUR / 12,
    accepted: 1,
    acknowledged: 2,
    failed: 0,
  });
  assert.deepEqual(result.timeline[1], {
    startAt: since + HOUR / 12,
    endAt: since + (HOUR * 2) / 12,
    accepted: 1,
    acknowledged: 0,
    failed: 1,
  });
  assert.equal(result.timeline[11].accepted, 1);
  assert.equal(result.timeline[11].failed, 1);
  assert.equal(result.timeline[11].endAt, NOW);
  assert.equal(
    result.timeline.reduce((sum, bucket) => sum + bucket.accepted, 0),
    result.events.accepted,
  );
  assert.equal(
    result.timeline.reduce((sum, bucket) => sum + bucket.acknowledged, 0),
    result.attempts.acknowledged,
  );
  assert.equal(
    result.timeline.reduce((sum, bucket) => sum + bucket.failed, 0),
    result.attempts.failed,
  );
  for (let index = 1; index < 12; index++)
    assert.equal(
      result.timeline[index - 1].endAt,
      result.timeline[index].startAt,
    );
});

test("queue observes all ages and exposes schedule, disabled connections and pause separately", async (context) => {
  const f = fixture(context);
  f.db.connection.exec(
    "UPDATE workspaces SET queue_paused=1 WHERE owner='alice'; UPDATE endpoints SET enabled=0 WHERE id='live-b'",
  );
  f.event("old-due", { createdAt: NOW - 10 * HOUR });
  f.event("future-schedule", {
    createdAt: NOW - 9 * HOUR,
    nextAttemptAt: NOW + 1,
  });
  f.event("disabled", { endpointId: "live-b", createdAt: NOW - 8 * HOUR });
  f.event("leased", {
    createdAt: NOW - 7 * HOUR,
    leaseToken: "old-lease",
    leaseUntil: NOW - 1,
  });
  f.event("budget-spent", { createdAt: NOW - 6 * HOUR, attempts: 4 });
  f.event("unscheduled", { createdAt: NOW - 5 * HOUR, nextAttemptAt: null });
  f.event("completed", { status: "delivered" });
  f.event("dead", { status: "dead" });
  f.event("future-record", { createdAt: NOW + 1 });
  const result = await f.service.read(query());
  assert.deepEqual(result.queue, {
    total: 6,
    due: 1,
    oldestCreatedAt: NOW - 10 * HOUR,
    paused: true,
    blockedDisabled: 1,
  });
  assert.equal(result.events.queued, 0);
  assert.equal(
    (await f.service.read(query({ endpointId: "live-b" }))).queue.total,
    1,
  );
});

test("all supported windows are bounded and empty aggregates use null latency", async (context) => {
  const f = fixture(context);
  f.event("hour", { createdAt: NOW - HOUR });
  f.event("day", { createdAt: NOW - 24 * HOUR });
  f.event("week", { createdAt: NOW - 7 * 24 * HOUR });
  f.event("older", { createdAt: NOW - 7 * 24 * HOUR - 1 });
  assert.equal(
    (await f.service.read(query({ window: "1h" }))).events.accepted,
    1,
  );
  assert.equal(
    (await f.service.read(query({ window: "24h" }))).events.accepted,
    2,
  );
  assert.equal(
    (await f.service.read(query({ window: "7d" }))).events.accepted,
    3,
  );
  const empty = await f.service.read(query({ scope: "lab" }));
  assert.deepEqual(empty.events, {
    accepted: 0,
    acknowledged: 0,
    dead: 0,
    queued: 0,
  });
  assert.deepEqual(empty.attempts, {
    total: 0,
    completed: 0,
    acknowledged: 0,
    failed: 0,
    inFlight: 0,
    unmeasuredInterrupted: 0,
    measured: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
  });
  assert.deepEqual(empty.queue, {
    total: 0,
    due: 0,
    oldestCreatedAt: null,
    paused: false,
    blockedDisabled: 0,
  });
  assert.ok(
    empty.timeline.every(
      (bucket) =>
        bucket.accepted === 0 &&
        bucket.failed === 0 &&
        bucket.acknowledged === 0,
    ),
  );
});

test("insights uses one consistent aggregate batch without mutating database records", async (context) => {
  const f = fixture(context);
  f.event("read-only");
  f.attempt("read-only-attempt", "read-only");
  const changesBefore = f.db.connection
    .prepare("SELECT total_changes() AS count")
    .get()!.count;
  let batches = 0;
  const readOnly = new InsightsService(
    {
      prepare: (sql) => {
        assert.match(sql.trim(), /^(SELECT|WITH RECURSIVE)\b/);
        return f.db.prepare(sql);
      },
      batch: async (statements) => {
        batches++;
        return f.db.batch(statements);
      },
    },
    "alice",
    () => NOW,
  );
  await readOnly.read(query());
  assert.equal(batches, 1);
  assert.equal(
    f.db.connection.prepare("SELECT total_changes() AS count").get()!.count,
    changesBefore,
  );
});
