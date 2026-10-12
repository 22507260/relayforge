import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
  throw new Error(
    "The smoke check creates test accounts and only accepts loopback URLs.",
  );
}
let cookie = "";
async function api(path, value, expectedStatus = 200, origin = base.origin) {
  const response = await fetch(new URL(path, base), {
    method: value === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    path + ": unexpected HTTP status: " + text.slice(0, 300),
  );
  const payload = JSON.parse(text);
  const sessionCookies = response.headers.getSetCookie();
  return { payload, sessionCookies };
}
async function action(value, expectedStatus = 200, origin = base.origin) {
  return (await api("/api/action", value, expectedStatus, origin)).payload;
}

async function waitForSnapshot(condition, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const snapshot = await action({ type: "pump" });
    if (condition(snapshot)) return snapshot;
    await wait(250);
  }
  assert.fail("Timed out waiting for " + description);
}

await api("/api/snapshot", undefined, 401);
await api("/api/deliveries", undefined, 401);
await api(
  "/api/recovery/replay",
  { items: [{ eventId: "missing", expectedCycle: 1 }] },
  401,
);
const spoofed = await fetch(new URL("/api/snapshot", base), {
  headers: {
    "x-user-id": "administrator",
    "x-authenticated-user-id": "administrator",
  },
});
assert.equal(
  spoofed.status,
  401,
  "Client-supplied identity headers must not authenticate",
);
await api("/api/auth/register", { email: "invalid", password: "short" }, 400);
const credentials = {
  email: "smoke-" + randomUUID() + "@example.test",
  password: randomBytes(24).toString("base64url"),
};
const registered = await api("/api/auth/register", credentials, 201);
assert.ok(
  registered.sessionCookies.length,
  "Registration must issue a session",
);
assert.match(registered.sessionCookies[0], /HttpOnly/);
assert.match(registered.sessionCookies[0], /SameSite=Lax/);
cookie = registered.sessionCookies
  .map((value) => value.split(";")[0])
  .join("; ");

const initial = await action({ type: "initialize" });
assert.equal(initial.endpoints.length, 3);
assert.equal(initial.user.email, credentials.email);
assert.equal(initial.system.eventLimit, 500);
await action({ type: "pump" }, 403, "https://another-app.example");
const endpoint = initial.endpoints.find((item) => item.mode === "healthy");
assert.ok(endpoint);
const idempotencyKey = "smoke-" + randomUUID();
const event = {
  type: "send",
  endpointId: endpoint.id,
  eventType: "smoke.completed",
  payload: { check: "real-http", run: idempotencyKey },
  idempotencyKey,
};
const accepted = await action(event);
assert.equal(accepted.metrics.total, 1);
assert.equal(accepted.metrics.businessEffects, 1);
const duplicate = await action(event);
assert.equal(duplicate.metrics.total, accepted.metrics.total);
assert.equal(
  duplicate.metrics.businessEffects,
  accepted.metrics.businessEffects,
);
assert.equal(
  duplicate.metrics.duplicatesPrevented,
  accepted.metrics.duplicatesPrevented + 1,
);
await action({ ...event, payload: { check: "changed" } }, 409);
const delivery = duplicate.deliveries.find((item) =>
  item.payload.includes(idempotencyKey),
);
assert.ok(delivery);
const detail = (await api("/api/deliveries/" + delivery.id)).payload;
assert.equal(detail.delivery.latestAttempt.statusCode, 200);
assert.equal(typeof detail.delivery.latestAttempt.finishedAt, "number");
const list = (
  await api(
    "/api/deliveries?search=SMOKE.COMPLETED&status=delivered&pageSize=1",
  )
).payload;
assert.equal(list.total, 1);
assert.equal(list.deliveries[0].id, delivery.id);
assert.equal(list.deliveries[0].latestAttempt.statusCode, 200);
await api("/api/deliveries?owner=administrator", undefined, 400);
await api("/api/deliveries?pageSize=51", undefined, 400);
await api("/api/deliveries?page=1&page=2", undefined, 400);
assert.equal(detail.delivery.status, "delivered");
assert.equal(detail.attempts.length, 1);
assert.equal(detail.delivery.currentCycle, 1);
assert.equal(detail.attempts[0].cycle, 1);

// Exercise the real recovery HTTP contract on this isolated smoke workspace.
const replayItem = { eventId: delivery.id, expectedCycle: 1 };
for (const value of [
  { items: [] },
  { items: [replayItem, replayItem] },
  {
    items: Array.from({ length: 21 }, (_, index) => ({
      eventId: `missing-${index}`,
      expectedCycle: 1,
    })),
  },
  { items: [{ ...replayItem, expectedCycle: 0 }] },
  { items: [{ ...replayItem, expectedCycle: 1.5 }] },
  { items: [replayItem], owner: "administrator" },
])
  await api("/api/recovery/replay", value, 400);
await api(
  "/api/recovery/replay",
  { items: [replayItem] },
  403,
  "https://another-app.example",
);

// A second real account proves foreign and nonexistent events have the same result.
const aliceCookie = cookie;
const otherAccount = await api(
  "/api/auth/register",
  {
    email: "smoke-isolation-" + randomUUID() + "@example.test",
    password: randomBytes(24).toString("base64url"),
  },
  201,
);
cookie = otherAccount.sessionCookies
  .map((value) => value.split(";")[0])
  .join("; ");
const other = await action({ type: "initialize" });
const otherAccepted = await action({
  type: "send",
  endpointId: other.endpoints.find((item) => item.mode === "healthy").id,
  eventType: "foreign.completed",
});
const foreignId = otherAccepted.deliveries[0].id;
await api("/api/auth/logout", {});
cookie = aliceCookie;
await api("/api/deliveries/" + foreignId, undefined, 404);

await action({ type: "pause", paused: true });
const failing = initial.endpoints.find((item) => item.mode === "failing");
const failedSnapshot = await action({
  type: "send",
  endpointId: failing.id,
  eventType: "smoke.failed",
  payload: { immutable: "recovery-check" },
  idempotencyKey: "recovery-" + randomUUID(),
});
const failedEvent = failedSnapshot.deliveries.find(
  (item) => item.eventType === "smoke.failed",
);
const started = await action({ type: "start-recovery-demo" });
const guide = started.recoveryDemo;
assert.ok(guide);
assert.equal(guide.delivery.attempts, 0);
assert.equal(started.system.queuePaused, true);
assert.equal(
  (await action({ type: "start-recovery-demo" })).recoveryDemo.eventId,
  guide.eventId,
);
assert.equal((await api("/api/snapshot")).payload.metrics.total, 3);
await action(
  { type: "set-receiver", endpointId: guide.endpointId, mode: "healthy" },
  409,
);
await action(
  { type: "send", endpointId: guide.endpointId, eventType: "blocked.send" },
  409,
);
await action(
  { type: "repair-recovery-demo", eventId: guide.eventId, expectedCycle: 1 },
  409,
);
await action({ type: "pause", paused: false });
const exhausted = await waitForSnapshot(
  (snapshot) =>
    snapshot.recoveryDemo?.stage === "awaiting-repair" &&
    snapshot.deliveries.find((item) => item.id === failedEvent.id)?.status ===
      "dead",
  "four failed attempts and the persisted recovery guide",
);
assert.equal(exhausted.recoveryDemo.delivery.currentCycle, 1);
assert.equal(exhausted.recoveryDemo.businessEffects, 0);
const failedHistory = (await api("/api/deliveries/" + failedEvent.id)).payload;
assert.deepEqual(
  failedHistory.attempts.map((attempt) => attempt.cycle),
  [1, 1, 1, 1],
);
const deadList = (
  await api(
    `/api/deliveries?status=dead&search=SMOKE.FAILED&endpointId=${failing.id}&pageSize=10`,
  )
).payload;
assert.equal(deadList.total, 1);
assert.equal(deadList.deliveries[0].id, failedEvent.id);

await action({ type: "replay", eventId: guide.eventId, expectedCycle: 1 }, 409);
await action({ type: "set-receiver", endpointId: failing.id, mode: "healthy" });
await action({ type: "pause", paused: true });
const selection = {
  items: [
    { eventId: failedEvent.id, expectedCycle: 1 },
    replayItem,
    { eventId: guide.eventId, expectedCycle: 1 },
    { eventId: foreignId, expectedCycle: 1 },
    { eventId: "missing-event", expectedCycle: 1 },
  ],
};
const bulk = (await api("/api/recovery/replay", selection)).payload;
assert.deepEqual(bulk.results[0], {
  eventId: failedEvent.id,
  outcome: "replayed",
  currentCycle: 2,
});
assert.ok(bulk.results.slice(1).every((item) => item.outcome === "skipped"));
assert.equal(bulk.results.at(-1).currentCycle, null);
assert.equal(bulk.results.at(-2).currentCycle, null);
assert.equal(bulk.snapshot.system.queuePaused, true);
const stillPaused = (await api("/api/deliveries/" + failedEvent.id)).payload;
assert.equal(stillPaused.delivery.attempts, 0);
assert.deepEqual(stillPaused.attempts, failedHistory.attempts);
assert.equal(
  (
    await api("/api/recovery/replay", {
      items: [{ eventId: failedEvent.id, expectedCycle: 1 }],
    })
  ).payload.results[0].outcome,
  "skipped",
);

await action({
  type: "repair-recovery-demo",
  eventId: guide.eventId,
  expectedCycle: 1,
});
assert.equal(
  (await api("/api/snapshot")).payload.recoveryDemo.stage,
  "ready-to-replay",
);
await action({
  type: "replay-recovery-demo",
  eventId: guide.eventId,
  expectedCycle: 1,
});
const recovering = (await api("/api/snapshot")).payload.recoveryDemo;
assert.equal(recovering.stage, "recovering");
assert.equal(recovering.delivery.attempts, 0);
await action({ type: "pause", paused: false });
const recovered = await waitForSnapshot(
  (snapshot) =>
    snapshot.recoveryDemo?.stage === "completed" &&
    snapshot.deliveries.find((item) => item.id === failedEvent.id)?.status ===
      "delivered",
  "successful replay of both real events",
);
assert.equal(recovered.recoveryDemo.eventId, guide.eventId);
assert.equal(recovered.recoveryDemo.businessEffects, 1);
assert.equal(recovered.metrics.businessEffects, 3);
const finalHistory = (await api("/api/deliveries/" + failedEvent.id)).payload;
assert.equal(finalHistory.delivery.payload, failedEvent.payload);
assert.equal(finalHistory.delivery.currentCycle, 2);
assert.deepEqual(finalHistory.attempts.slice(0, 4), failedHistory.attempts);
assert.deepEqual(
  finalHistory.attempts.map((attempt) => attempt.cycle),
  [1, 1, 1, 1, 2],
);
assert.deepEqual(
  (await api("/api/deliveries/" + guide.eventId)).payload.attempts.map(
    (attempt) => attempt.cycle,
  ),
  [1, 1, 1, 1, 2],
);

const originalCookie = cookie;
await api("/api/auth/logout", {});
await api("/api/snapshot", undefined, 401);
const login = await api("/api/auth/login", credentials);
cookie = login.sessionCookies.map((value) => value.split(";")[0]).join("; ");
assert.notEqual(cookie, originalCookie, "Login must issue a fresh token");
const restored = (await api("/api/snapshot")).payload;
assert.equal(
  restored.metrics.total,
  3,
  "Logging in must restore the persisted workspace",
);
assert.equal(restored.recoveryDemo.eventId, guide.eventId);
assert.equal(restored.recoveryDemo.stage, "completed");
assert.equal(restored.recoveryDemo.businessEffects, 1);
await api("/api/auth/logout", {});
console.log(
  "HTTP smoke passed: authentication and session revocation, same-origin protection, owner isolation, signed receiver effects, idempotency, bounded bulk replay and stale selections, immutable cycle history, paused queue, and persisted recovery guide through four failures, repair and successful replay.",
);
