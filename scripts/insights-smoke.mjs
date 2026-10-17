import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://localhost:3000");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  process.env.RELAYFORGE_HTTP_VERIFICATION !== "true"
) {
  throw new Error(
    "Insights HTTP verification requires an isolated loopback runner.",
  );
}

let cookie = "";
const confidential = new Set();
const privatePayload = `private-insights-payload-${randomUUID()}`;
confidential.add(privatePayload);

function assertAggregateOnly(value) {
  const serialized = JSON.stringify(value);
  for (const secret of confidential)
    assert.ok(!serialized.includes(secret), "Insights must omit private data.");
  for (const field of [
    "payload",
    "payload_hash",
    "idempotencyKey",
    "idempotency_key",
    "signingSecret",
    "signing_secret",
    "signingKeyIds",
    "encrypted_secret",
    "password_hash",
    "token_hash",
    "destination_url",
  ])
    assert.ok(
      !serialized.includes(`"${field}":`),
      "Insights must contain aggregates rather than private event metadata.",
    );
}

async function api(
  path,
  { body, expected = 200, session = cookie, method } = {},
) {
  const response = await fetch(new URL(path, base), {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      origin: base.origin,
      cookie: session,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  const value = await response.json();
  if (path.startsWith("/api/insights")) {
    assertAggregateOnly(value);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  return {
    value,
    cookie: response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; "),
  };
}

async function action(body) {
  return (await api("/api/action", { body })).value;
}

async function register(label) {
  const password = randomBytes(24).toString("base64url");
  confidential.add(password);
  const result = await api("/api/auth/register", {
    body: {
      email: `insights-${label}-${randomUUID()}@example.test`,
      password,
    },
    session: "",
    expected: 201,
  });
  assert.ok(result.cookie, "Registration must issue a session.");
  for (const field of result.cookie.split("; ")) {
    const token = field.split("=")[1];
    if (token) confidential.add(token);
  }
  return result.cookie;
}

async function insights(query = "scope=lab&window=24h") {
  return (await api(`/api/insights?${query}`)).value;
}

function assertBounds(value, duration) {
  assert.equal(value.now - value.since, duration);
  assert.ok(value.timeline.length > 0 && value.timeline.length <= 168);
  assert.equal(value.timeline[0].startAt, value.since);
  assert.equal(value.timeline.at(-1).endAt, value.now);
  let previous = value.since;
  for (const bucket of value.timeline) {
    assert.equal(bucket.startAt, previous);
    assert.ok(bucket.endAt > bucket.startAt && bucket.endAt <= value.now);
    previous = bucket.endAt;
    for (const field of ["accepted", "acknowledged", "failed"])
      assert.ok(Number.isSafeInteger(bucket[field]) && bucket[field] >= 0);
  }
}

function assertAttemptInvariants(value) {
  const attempts = value.attempts;
  assert.equal(attempts.total, attempts.completed + attempts.inFlight);
  assert.equal(
    attempts.completed,
    attempts.acknowledged + attempts.failed + attempts.unmeasuredInterrupted,
  );
  assert.equal(
    value.httpStatuses.reduce((sum, row) => sum + row.count, 0),
    attempts.measured,
  );
  assert.equal(
    value.failures.reduce((sum, row) => sum + row.count, 0),
    attempts.failed,
  );
  if (!attempts.measured) {
    assert.equal(attempts.p50Ms, null);
    assert.equal(attempts.p95Ms, null);
    assert.equal(attempts.maxMs, null);
  } else {
    assert.ok(attempts.p50Ms >= 0);
    assert.ok(attempts.p50Ms <= attempts.p95Ms);
    assert.ok(attempts.p95Ms <= attempts.maxMs);
  }
}

await api("/api/insights", { session: "", expected: 401 });
cookie = await register("primary");
const aliceCookie = cookie;
const initial = await action({ type: "initialize" });
const healthy = initial.endpoints.find(
  (endpoint) => endpoint.mode === "healthy",
);
const failing = initial.endpoints.find(
  (endpoint) => endpoint.mode === "failing",
);
assert.ok(healthy && failing);
await action({ type: "pause", paused: true });

const empty = (await api("/api/insights")).value;
assert.equal(empty.scope, "live");
assert.equal(empty.window, "24h");
assert.equal(empty.endpointId, "all");
assert.deepEqual(empty.events, {
  accepted: 0,
  acknowledged: 0,
  dead: 0,
  queued: 0,
});
assert.equal(empty.queue.paused, true);
assertAttemptInvariants(empty);
assertBounds(empty, 86_400_000);

for (const query of [
  "scope=all",
  "scope=LIVE",
  "scope=",
  "window=0",
  "window=30d",
  "window=",
  "scope=lab&scope=live",
  "window=1h&window=24h",
  "endpointId=all&endpointId=all",
  "owner=administrator",
  "since=0",
  "unexpected=true",
])
  await api(`/api/insights?${query}`, { expected: 400 });

cookie = await register("foreign");
const foreignInitial = await action({ type: "initialize" });
const foreignEndpoint = foreignInitial.endpoints[0];
await action({
  type: "send",
  endpointId: foreignEndpoint.id,
  eventType: "insights.foreign",
  payload: { private: privatePayload },
  idempotencyKey: randomUUID(),
});
cookie = aliceCookie;
const forbidden = await api(
  `/api/insights?scope=lab&endpointId=${encodeURIComponent(foreignEndpoint.id)}`,
  { expected: 404 },
);
const nonexistent = await api(
  `/api/insights?scope=lab&endpointId=missing-${randomUUID()}`,
  { expected: 404 },
);
assert.equal(forbidden.value.code, nonexistent.value.code);
assert.equal(forbidden.value.error, nonexistent.value.error);

// The paused workspace keeps worker timing out of the full-history count proof.
let queued;
for (let index = 0; index < 105; index++) {
  queued = await action({
    type: "send",
    endpointId: index === 104 ? failing.id : healthy.id,
    eventType: index === 104 ? "insights.failed" : "insights.accepted",
    payload: { private: privatePayload, index },
    idempotencyKey: randomUUID(),
  });
}
assert.equal(queued.deliveries.length, queued.system.snapshotLimit);
assert.equal(queued.deliveries.length, 100);
const pending = await insights();
assert.equal(pending.events.accepted, 105);
assert.equal(pending.events.queued, 105);
assert.equal(pending.events.acknowledged, 0);
assert.equal(pending.events.dead, 0);
assert.equal(pending.attempts.total, 0);
assert.equal(pending.queue.total, 105);
assert.equal(pending.queue.due, 105);
assert.equal(pending.queue.paused, true);
assert.ok(pending.queue.oldestCreatedAt >= pending.since);
assert.equal(
  pending.timeline.reduce((sum, bucket) => sum + bucket.accepted, 0),
  105,
);
assert.equal(
  pending.endpoints.reduce((sum, endpoint) => sum + endpoint.accepted, 0),
  105,
);
assert.equal((await insights("scope=live")).events.accepted, 0);
assert.equal(
  (await insights(`scope=lab&endpointId=${healthy.id}`)).events.accepted,
  104,
);
assert.equal(
  (await insights(`scope=lab&endpointId=${failing.id}`)).events.accepted,
  1,
);
assertAttemptInvariants(pending);

for (const [window, duration] of [
  ["1h", 3_600_000],
  ["24h", 86_400_000],
  ["7d", 604_800_000],
]) {
  const value = await insights(`scope=lab&window=${window}`);
  assert.equal(value.events.accepted, 105);
  assert.equal(value.window, window);
  assertBounds(value, duration);
}

// A disabled real connection proves Live and Lab remain separate without
// contacting any destination during this analytics verification.
const created = (
  await api("/api/connections", {
    body: { name: "Insights reference", transport: "reference" },
    expected: 201,
  })
).value;
confidential.add(created.signingSecret);
const liveEndpoint = created.connection;
await api(`/api/connections/${liveEndpoint.id}/events`, {
  body: {
    eventType: "insights.live",
    payload: { private: privatePayload },
    idempotencyKey: randomUUID(),
  },
  expected: 202,
});
await api(`/api/connections/${liveEndpoint.id}`, {
  method: "PATCH",
  body: { enabled: false, expectedRevision: liveEndpoint.revision },
});
const live = await insights("scope=live&window=24h");
assert.equal(live.events.accepted, 1);
assert.equal(live.events.queued, 1);
assert.equal(live.attempts.total, 0);
assert.equal(live.queue.total, 1);
assert.equal(live.queue.blockedDisabled, 1);
assert.equal(live.queue.due, 0);
assert.equal(live.endpoints.length, 1);
assert.equal(live.endpoints[0].endpointId, liveEndpoint.id);
assert.equal(live.endpoints[0].enabled, false);
const mismatched = await insights(`scope=live&endpointId=${healthy.id}`);
assert.equal(mismatched.events.accepted, 0);
assert.equal(mismatched.endpoints.length, 0);
assert.equal((await insights()).events.accepted, 105);

// Reading analytics must not pump the paused queue or create audit activity.
const beforeRead = (await api("/api/audit?pageSize=1")).value.total;
await insights();
await insights();
const afterRead = (await api("/api/audit?pageSize=1")).value.total;
assert.equal(afterRead, beforeRead);
const unchanged = (await api("/api/snapshot")).value;
assert.equal(unchanged.system.queuePaused, true);
assert.equal(unchanged.metrics.total, 106);
assert.equal(unchanged.metrics.queued, 106);
assert.ok(unchanged.deliveries.every((event) => event.attempts === 0));

await action({ type: "pause", paused: false });
const deadline = Date.now() + 35_000;
let completed;
while (Date.now() < deadline) {
  completed = await insights();
  if (
    completed.events.acknowledged === 104 &&
    completed.events.dead === 1 &&
    completed.events.queued === 0
  )
    break;
  await wait(200);
}
assert.equal(completed.events.accepted, 105);
assert.equal(completed.events.acknowledged, 104);
assert.equal(completed.events.dead, 1);
assert.equal(completed.events.queued, 0);
assert.equal(completed.attempts.total, 108);
assert.equal(completed.attempts.acknowledged, 104);
assert.equal(completed.attempts.failed, 4);
assert.equal(completed.attempts.measured, 108);
assert.equal(completed.queue.total, 0);
assert.equal(completed.queue.oldestCreatedAt, null);
assertAttemptInvariants(completed);
assert.equal(
  completed.timeline.reduce((sum, bucket) => sum + bucket.acknowledged, 0),
  104,
);
assert.equal(
  completed.timeline.reduce((sum, bucket) => sum + bucket.failed, 0),
  4,
);
assert.equal(
  completed.httpStatuses.find((row) => row.statusCode === 200)?.count,
  104,
);
assert.equal(
  completed.httpStatuses.find((row) => row.statusCode === 500)?.count,
  4,
);

const all = (await api("/api/deliveries?status=all&pageSize=50&page=1")).value;
assert.equal(all.total, 106);
const failures = (
  await api(`/api/deliveries?status=dead&endpointId=${failing.id}`)
).value;
assert.equal(failures.total, 1);
const failedEvent = failures.deliveries[0];
const failedDetail = (await api(`/api/deliveries/${failedEvent.id}`)).value;
assert.equal(failedDetail.attempts.length, 4);
const failedInsights = await insights(`scope=lab&endpointId=${failing.id}`);
const durations = failedDetail.attempts
  .map((attempt) => attempt.durationMs)
  .sort((a, b) => a - b);
assert.equal(failedInsights.attempts.p50Ms, durations[Math.ceil(4 * 0.5) - 1]);
assert.equal(failedInsights.attempts.p95Ms, durations[Math.ceil(4 * 0.95) - 1]);
assert.equal(failedInsights.attempts.maxMs, durations.at(-1));

// A replay changes the current event outcome while keeping old failed attempts.
await action({ type: "set-receiver", endpointId: failing.id, mode: "healthy" });
await action({
  type: "replay",
  eventId: failedEvent.id,
  expectedCycle: failedEvent.currentCycle,
});
const replayed = await insights();
assert.equal(replayed.events.accepted, 105);
assert.equal(replayed.events.acknowledged, 105);
assert.equal(replayed.events.dead, 0);
assert.equal(replayed.attempts.total, 109);
assert.equal(replayed.attempts.acknowledged, 105);
assert.equal(replayed.attempts.failed, 4);
assertAttemptInvariants(replayed);
const replayedDetail = (await api(`/api/deliveries/${failedEvent.id}`)).value;
assert.equal(replayedDetail.delivery.currentCycle, 2);
assert.equal(replayedDetail.attempts.length, 5);
assert.equal(
  replayedDetail.attempts.filter((attempt) => attempt.cycle === 1).length,
  4,
);
assert.equal(
  replayedDetail.attempts.filter((attempt) => attempt.cycle === 2).length,
  1,
);

console.log(
  "Insights HTTP verification passed: full-history aggregates, strict filters, account isolation, paused read stability, measured percentiles and replay history.",
);
