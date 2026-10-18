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
    "Operations HTTP verification requires an isolated loopback runner.",
  );
}

let cookie = "";
const confidential = new Set();
const privatePayload = `private-operations-payload-${randomUUID()}`;
confidential.add(privatePayload);
const queueCodes = [
  "in_flight",
  "lease_recovery",
  "disabled",
  "budget_exhausted",
  "scheduled",
  "due",
  "unscheduled",
];

function assertDiagnosticOnly(value) {
  const serialized = JSON.stringify(value);
  for (const secret of confidential)
    assert.ok(!serialized.includes(secret), "Diagnostics must omit secrets.");
  for (const field of [
    "payload",
    "payload_hash",
    "idempotencyKey",
    "idempotency_key",
    "signingSecret",
    "signing_secret",
    "encrypted_secret",
    "password_hash",
    "token_hash",
    "destination_url",
  ])
    assert.ok(
      !serialized.includes(`"${field}":`),
      "Operations must omit private event and destination data.",
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
  if (path.startsWith("/api/operations") || path.startsWith("/api/health/")) {
    assertDiagnosticOnly(value);
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
      email: `operations-${label}-${randomUUID()}@example.test`,
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

async function operations(scope) {
  return (await api(`/api/operations${scope ? `?scope=${scope}` : ""}`)).value;
}

function assertQueuePartition(value) {
  assert.deepEqual(
    value.queue.buckets.map((bucket) => bucket.code).sort(),
    [...queueCodes].sort(),
  );
  assert.equal(
    value.queue.buckets.reduce((total, bucket) => total + bucket.count, 0),
    value.queue.total,
  );
  assert.equal(
    value.connections.reduce(
      (total, connection) => total + connection.queued,
      0,
    ),
    value.queue.total,
  );
  for (const bucket of value.queue.buckets) {
    assert.ok(Number.isSafeInteger(bucket.count) && bucket.count >= 0);
    assert.equal(bucket.oldestCreatedAt === null, bucket.count === 0);
    if (bucket.oldestCreatedAt !== null)
      assert.ok(bucket.oldestCreatedAt <= value.now);
  }
  assert.equal(value.queue.oldestCreatedAt === null, value.queue.total === 0);
  assert.equal(value.workspace.eventLimit, 500);
  assert.equal(
    value.workspace.remainingEvents,
    Math.max(0, value.workspace.eventLimit - value.workspace.acceptedEvents),
  );
  assert.equal(value.worker.heartbeatTtlMs, 10_000);
  assert.equal(value.worker.online, value.worker.activeWorkers > 0);
}

// Public probes deliberately reveal only process or deployment readiness.
assert.deepEqual((await api("/api/health/live", { session: "" })).value, {
  status: "alive",
});
const readinessDeadline = Date.now() + 15_000;
let ready = false;
while (Date.now() < readinessDeadline) {
  const response = await fetch(new URL("/api/health/ready", base), {
    signal: AbortSignal.timeout(2000),
  });
  assert.ok([200, 503].includes(response.status));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  const value = await response.json();
  assert.deepEqual(value, {
    status: response.status === 200 ? "ready" : "not_ready",
  });
  if (response.status === 200) {
    ready = true;
    break;
  }
  await wait(200);
}
assert.equal(
  ready,
  true,
  "The isolated database and worker must become ready.",
);

await api("/api/operations", { session: "", expected: 401 });
cookie = await register("primary");
const primaryCookie = cookie;
const initial = await action({ type: "initialize" });
const healthy = initial.endpoints.find(
  (endpoint) => endpoint.mode === "healthy",
);
const failing = initial.endpoints.find(
  (endpoint) => endpoint.mode === "failing",
);
assert.ok(healthy && failing);
await action({ type: "pause", paused: true });

const empty = await operations();
assert.equal(empty.scope, "live");
assert.equal(empty.workspace.paused, true);
assert.equal(empty.workspace.acceptedEvents, 0);
assert.equal(empty.queue.total, 0);
assert.equal(empty.connections.length, 0);
assertQueuePartition(empty);
for (const query of [
  "scope=all",
  "scope=LIVE",
  "scope=",
  "scope=live&scope=lab",
  "scope=lab&scope=lab",
  "endpointId=all",
  "window=24h",
  "owner=administrator",
])
  await api(`/api/operations?${query}`, { expected: 400 });

cookie = await register("foreign");
const foreign = await action({ type: "initialize" });
await action({ type: "pause", paused: true });
await action({
  type: "send",
  endpointId: foreign.endpoints[0].id,
  eventType: "operations.foreign",
  payload: { private: privatePayload },
  idempotencyKey: randomUUID(),
});
assert.equal((await operations("lab")).queue.total, 1);
cookie = primaryCookie;
assert.equal((await operations("lab")).queue.total, 0);
assert.equal((await operations("lab")).workspace.acceptedEvents, 0);
assert.ok(
  !(await operations("lab")).connections.some((connection) =>
    foreign.endpoints.some((endpoint) => endpoint.id === connection.endpointId),
  ),
);

let queued;
for (let index = 0; index < 105; index++)
  queued = await action({
    type: "send",
    endpointId: index === 104 ? failing.id : healthy.id,
    eventType: "operations.accepted",
    payload: { private: privatePayload, index },
    idempotencyKey: randomUUID(),
  });
assert.equal(queued.deliveries.length, 100);
const pausedLab = await operations("lab");
assert.equal(pausedLab.scope, "lab");
assert.equal(pausedLab.queue.total, 105);
assert.equal(
  pausedLab.queue.buckets.find((bucket) => bucket.code === "due").count,
  105,
);
assert.equal(pausedLab.workspace.paused, true);
assert.equal(pausedLab.workspace.acceptedEvents, 105);
assert.equal(pausedLab.workspace.remainingEvents, 395);
assert.equal(pausedLab.summary.dead, 0);
assertQueuePartition(pausedLab);
assert.equal((await operations("live")).queue.total, 0);

// A disabled fixed reference connection proves Live separation without sending
// any network request or changing receiver configuration in this smoke.
const created = (
  await api("/api/connections", {
    body: { name: "Operations reference", transport: "reference" },
    expected: 201,
  })
).value;
confidential.add(created.signingSecret);
const liveEndpoint = created.connection;
await api(`/api/connections/${liveEndpoint.id}/events`, {
  body: {
    eventType: "operations.live",
    payload: { private: privatePayload },
    idempotencyKey: randomUUID(),
  },
  expected: 202,
});
await api(`/api/connections/${liveEndpoint.id}`, {
  method: "PATCH",
  body: { enabled: false, expectedRevision: liveEndpoint.revision },
});
const pausedLive = await operations("live");
assert.equal(pausedLive.queue.total, 1);
assert.equal(
  pausedLive.queue.buckets.find((bucket) => bucket.code === "disabled").count,
  1,
);
assert.equal(
  pausedLive.queue.buckets.find((bucket) => bucket.code === "due").count,
  0,
);
assert.equal(pausedLive.connections.length, 1);
assert.equal(pausedLive.connections[0].endpointId, liveEndpoint.id);
assert.equal(pausedLive.connections[0].enabled, false);
assert.equal(pausedLive.connections[0].needsAttention, true);
assert.equal(pausedLive.summary.disabledConnections, 1);
assert.equal(pausedLive.workspace.acceptedEvents, 106);
assert.equal(pausedLive.workspace.remainingEvents, 394);
assertQueuePartition(pausedLive);
const sameCapacity = await operations("lab");
assert.equal(sameCapacity.queue.total, 105);
assert.deepEqual(sameCapacity.workspace, pausedLive.workspace);

// Report reads leave delivery and audit state intact, even with due work.
const before = (await api("/api/audit?pageSize=1")).value.total;
await operations("live");
await operations("lab");
assert.equal((await api("/api/audit?pageSize=1")).value.total, before);
const unchanged = (await api("/api/snapshot")).value;
assert.equal(unchanged.system.queuePaused, true);
assert.equal(unchanged.metrics.total, 106);
assert.equal(unchanged.metrics.queued, 106);
assert.ok(unchanged.deliveries.every((event) => event.attempts === 0));

await action({ type: "pause", paused: false });
const deadline = Date.now() + 35_000;
let completed;
while (Date.now() < deadline) {
  completed = await operations("lab");
  if (completed.queue.total === 0 && completed.summary.dead === 1) break;
  await wait(200);
}
assert.equal(completed.workspace.paused, false);
assert.equal(completed.queue.total, 0);
assert.equal(completed.summary.dead, 1);
assertQueuePartition(completed);
const failedConnection = completed.connections.find(
  (connection) => connection.endpointId === failing.id,
);
assert.equal(failedConnection.dead, 1);
assert.equal(failedConnection.needsAttention, true);
const stillDisabled = await operations("live");
assert.equal(stillDisabled.queue.total, 1);
assert.equal(
  stillDisabled.queue.buckets.find((bucket) => bucket.code === "disabled")
    .count,
  1,
);
assert.equal(stillDisabled.workspace.acceptedEvents, 106);
assertQueuePartition(stillDisabled);
assert.deepEqual((await api("/api/health/live", { session: "" })).value, {
  status: "alive",
});

console.log(
  "Operations HTTP verification passed: public probes, strict scopes, full-history queue partition, account isolation, owner-wide capacity and read-only diagnostics.",
);
