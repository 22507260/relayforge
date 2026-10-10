import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

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

await api("/api/snapshot", undefined, 401);
await api("/api/deliveries", undefined, 401);
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

const originalCookie = cookie;
await api("/api/auth/logout", {});
await api("/api/snapshot", undefined, 401);
const login = await api("/api/auth/login", credentials);
cookie = login.sessionCookies.map((value) => value.split(";")[0]).join("; ");
assert.notEqual(cookie, originalCookie, "Login must issue a fresh token");
const restored = (await api("/api/snapshot")).payload;
assert.equal(
  restored.metrics.total,
  1,
  "Logging in must restore the persisted workspace",
);
await api("/api/auth/logout", {});
console.log(
  "HTTP smoke passed: registration/login/logout, session revocation, anonymous and spoofed identity denial, same-origin protection, SQLite persistence, signed receiver effects, duplicate suppression and payload conflict.",
);
