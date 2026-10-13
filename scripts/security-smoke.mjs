import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://localhost:3000");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
) {
  throw new Error(
    "The security smoke check creates isolated accounts and only accepts loopback URLs.",
  );
}
const secrets = new Set();
const account = (label) => {
  const password = randomBytes(24).toString("base64url");
  secrets.add(password);
  return {
    email: `security-smoke-${label}-${randomUUID()}@example.test`,
    password,
  };
};
const alice = account("sessions");
const bob = account("password");
const newPassword = randomBytes(24).toString("base64url");
secrets.add(newPassword);

function assertRedacted(body) {
  const serialized = JSON.stringify(body);
  for (const secret of secrets)
    assert.ok(
      !serialized.includes(secret),
      "HTTP JSON must not expose a password, session token or its hash",
    );
  for (const field of [
    '"token":',
    '"token_hash":',
    '"password_hash":',
    '"newSession":',
    '"signing_secret":',
    "scrypt$",
  ])
    assert.ok(
      !serialized.includes(field),
      "HTTP JSON must contain only public authentication fields",
    );
}
async function api(
  path,
  { value, cookie = "", expected = 200, origin = base.origin, method } = {},
) {
  const response = await fetch(new URL(path, base), {
    method: method ?? (value === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", origin, cookie },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    "Account and audit responses must not be cached",
  );
  const body = await response.json();
  assertRedacted(body);
  const setCookie = response.headers.getSetCookie();
  for (const line of setCookie) {
    const token = line.split(";")[0].split("=")[1];
    if (token) {
      secrets.add(token);
      secrets.add(createHash("sha256").update(token).digest("hex"));
      assertRedacted(body);
    }
  }
  return {
    body,
    cookie: setCookie.map((line) => line.split(";")[0]).join("; "),
    response,
    setCookie,
  };
}
async function auth(path, credentials) {
  const result = await api(path, {
    value: credentials,
    expected: path.endsWith("register") ? 201 : 200,
  });
  assert.ok(
    result.cookie,
    "Successful authentication must issue a session cookie",
  );
  assert.match(result.setCookie[0], /HttpOnly/);
  assert.match(result.setCookie[0], /SameSite=Lax/);
  return result.cookie;
}
const security = (cookie, value, expected = 200, origin = base.origin) =>
  api("/api/security", { cookie, value, expected, origin });
const action = async (cookie, value) =>
  (await api("/api/action", { cookie, value })).body;

async function waitForSnapshot(cookie, predicate, description) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const snapshot = await action(cookie, { type: "pump" });
    if (predicate(snapshot)) return snapshot;
    await wait(250);
  }
  assert.fail("Timed out waiting for " + description);
}

await api("/api/security", { expected: 401 });
await api("/api/audit", { expected: 401 });
await security("", { type: "revoke-other-sessions" }, 401);
const spoofed = await fetch(new URL("/api/security", base), {
  headers: {
    "x-user-id": "administrator",
    "x-authenticated-user-id": "administrator",
  },
});
assert.equal(
  spoofed.status,
  401,
  "Identity headers cannot authenticate account management",
);

const aliceCookie = await auth("/api/auth/register", alice);
const secondCookie = await auth("/api/auth/login", alice);
const thirdCookie = await auth("/api/auth/login", alice);
const bobCookie = await auth("/api/auth/register", bob);
const bobOtherCookie = await auth("/api/auth/login", bob);
const initial = (await security(aliceCookie)).body;
const second = (await security(secondCookie)).body;
const foreign = (await security(bobCookie)).body;
assert.equal(initial.sessionCount, 3);
assert.equal(initial.sessions[0].isCurrent, true);
assert.ok(
  initial.sessions.every((session) => session.id && !session.id.includes("=")),
);
await security(
  `relayforge_session=${initial.currentSessionId}`,
  undefined,
  401,
);
await security(
  aliceCookie,
  { type: "revoke-other-sessions" },
  403,
  "https://another-app.example",
);
for (const value of [
  { type: "revoke-session", sessionId: "../other" },
  { type: "revoke-other-sessions", owner: "administrator" },
  {
    type: "change-password",
    currentPassword: bob.password,
    newPassword: "short",
  },
  {
    type: "change-password",
    currentPassword: bob.password,
    newPassword: bob.password,
  },
])
  await security(aliceCookie, value, 400);

await security(
  aliceCookie,
  { type: "revoke-session", sessionId: initial.currentSessionId },
  409,
);
const foreignAttempt = await security(
  aliceCookie,
  { type: "revoke-session", sessionId: foreign.currentSessionId },
  404,
);
const missingAttempt = await security(
  aliceCookie,
  { type: "revoke-session", sessionId: "missing-session" },
  404,
);
assert.equal(
  foreignAttempt.body.error,
  missingAttempt.body.error,
  "Foreign session IDs and missing IDs must have the same public error",
);
const revoked = await security(aliceCookie, {
  type: "revoke-session",
  sessionId: second.currentSessionId,
});
assert.equal(revoked.body.revokedSessions, 1);
await security(secondCookie, undefined, 401);
assert.equal((await security(thirdCookie)).body.sessionCount, 2);
const others = await security(aliceCookie, { type: "revoke-other-sessions" });
assert.equal(others.body.revokedSessions, 1);
assert.equal(others.body.security.sessionCount, 1);
await security(thirdCookie, undefined, 401);
const throttled = await security(
  aliceCookie,
  { type: "revoke-other-sessions" },
  429,
);
assert.equal(throttled.response.headers.get("retry-after"), "600");
assert.equal(
  (await security(bobCookie)).body.sessionCount,
  2,
  "Another account remains unaffected by revocation and mutation limits",
);

await security(
  bobCookie,
  {
    type: "change-password",
    currentPassword: randomBytes(24).toString("base64url"),
    newPassword,
  },
  401,
);
assert.equal(
  (await security(bobCookie)).body.sessionCount,
  2,
  "An incorrect current password must not change active sessions",
);
const changed = await security(bobCookie, {
  type: "change-password",
  currentPassword: bob.password,
  newPassword,
});
assert.ok(
  changed.cookie && changed.cookie !== bobCookie,
  "Password changes must rotate the HttpOnly session cookie",
);
assert.match(changed.setCookie[0], /HttpOnly; SameSite=Lax/);
assert.equal(changed.body.revokedSessions, 2);
assert.equal(changed.body.security.sessionCount, 1);
assert.ok(
  changed.body.security.events.some(
    (event) => event.kind === "password-changed",
  ),
);
await security(bobCookie, undefined, 401);
await security(bobOtherCookie, undefined, 401);
await api("/api/auth/login", { value: bob, expected: 401 });
const bobFreshCookie = await auth("/api/auth/login", {
  ...bob,
  password: newPassword,
});
assert.equal((await security(changed.cookie)).body.user.email, bob.email);
assert.equal((await security(aliceCookie)).body.user.email, alice.email);

// Produce enough real delivery history to exceed the thirty-entry activity snapshot.
const workspace = await action(aliceCookie, { type: "initialize" });
const endpoint = workspace.endpoints.find((item) => item.mode === "healthy");
assert.ok(endpoint);
for (let index = 0; index < 20; index++)
  await action(aliceCookie, {
    type: "send",
    endpointId: endpoint.id,
    eventType: `security-smoke.completed`,
    payload: { index },
    idempotencyKey: `audit-smoke-${randomUUID()}`,
  });
const settled = await waitForSnapshot(
  aliceCookie,
  (snapshot) =>
    snapshot.metrics.total === 20 &&
    snapshot.metrics.delivered === 20 &&
    snapshot.metrics.queued === 0,
  "all twenty audit smoke events to finish their real queue claims",
);
const event = settled.deliveries[0];
await action(aliceCookie, {
  type: "replay",
  eventId: event.id,
  expectedCycle: 1,
});
await waitForSnapshot(
  aliceCookie,
  (snapshot) => {
    const delivery = snapshot.deliveries.find((item) => item.id === event.id);
    return (
      delivery?.currentCycle === 2 &&
      delivery.status === "delivered" &&
      snapshot.metrics.queued === 0
    );
  },
  "the replay to finish before traversing its stable audit history",
);
const auditFirst = (
  await api("/api/audit?pageSize=10", { cookie: aliceCookie })
).body;
assert.ok(auditFirst.total > 30);
const records = [...auditFirst.records];
for (let page = 2; page <= auditFirst.totalPages; page++) {
  const next = (
    await api(`/api/audit?pageSize=10&page=${page}`, { cookie: aliceCookie })
  ).body;
  assert.equal(next.total, auditFirst.total);
  records.push(...next.records);
}
assert.equal(records.length, auditFirst.total);
assert.equal(
  new Set(records.map((record) => `${record.category}:${record.id}`)).size,
  records.length,
  "Stable pagination must not repeat audit entries",
);
assert.ok(records.some((record) => record.category === "delivery"));
assert.ok(records.some((record) => record.category === "security"));
const replay = (
  await api(`/api/audit?category=delivery&kind=replay&eventId=${event.id}`, {
    cookie: aliceCookie,
  })
).body;
assert.equal(replay.total, 1);
const operationId = replay.records[0].operationId;
assert.ok(operationId);
const grouped = (
  await api(`/api/audit?operationId=${operationId}`, { cookie: aliceCookie })
).body;
assert.equal(grouped.total, 1);
assert.equal(grouped.records[0].eventId, event.id);
const timestamp = replay.records[0].createdAt;
const exactDate = (
  await api(
    `/api/audit?eventId=${event.id}&kind=replay&from=${timestamp}&to=${timestamp}`,
    { cookie: aliceCookie },
  )
).body;
assert.equal(exactDate.total, 1);
const searched = (
  await api(
    "/api/audit?search=SECURITY-SMOKE.COMPLETED&category=delivery&pageSize=50",
    { cookie: aliceCookie },
  )
).body;
assert.ok(searched.total >= 20);
assert.ok(searched.records.every((record) => record.category === "delivery"));
const foreignEventAudit = (
  await api(`/api/audit?eventId=${event.id}`, { cookie: bobFreshCookie })
).body;
assert.equal(
  foreignEventAudit.total,
  0,
  "Audit queries must not expose another account's events",
);
const passwordAudit = (
  await api("/api/audit?category=security&kind=password-changed", {
    cookie: bobFreshCookie,
  })
).body;
assert.equal(passwordAudit.total, 1);
assert.equal(passwordAudit.records[0].eventId, null);
for (const query of [
  "owner=administrator",
  "page=1&page=2",
  "pageSize=51",
  "category=unknown",
  "kind=unknown",
  "from=1&to=0",
  "from=",
  "operationId=../secret",
])
  await api("/api/audit?" + query, { cookie: aliceCookie, expected: 400 });

for (const cookie of [aliceCookie, changed.cookie, bobFreshCookie])
  await api("/api/auth/logout", { cookie, value: {} });
console.log(
  "Security HTTP smoke passed: private account APIs, same-origin and strict input checks, public session IDs, owner-scoped revocation, mutation throttling, password verification and cookie rotation, stale-cookie rejection, JSON redaction, full audit pagination, operation/date/text filters and account isolation.",
);
