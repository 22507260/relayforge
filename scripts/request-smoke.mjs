import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const base = new URL(
  process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000",
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
  !["http:", "https:"].includes(base.protocol) ||
  base.username ||
  base.password
) {
  throw new Error(
    "Request smoke checks create isolated accounts and only accept loopback URLs.",
  );
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const secrets = new Set();
const ids = new Set();
const fixture = (label) => {
  const password = randomBytes(24).toString("base64url");
  secrets.add(password);
  return {
    email: `request-smoke-${label}-${randomUUID()}@example.test`,
    password,
  };
};
const alice = fixture("primary");
const bob = fixture("foreign");
const incorrectPassword = randomBytes(24).toString("base64url");
const replacementPassword = randomBytes(24).toString("base64url");
secrets.add(incorrectPassword);
secrets.add(replacementPassword);

async function api(
  path,
  {
    value,
    raw,
    cookie = "",
    expected = 200,
    code,
    origin = base.origin,
    contentType = "application/json",
    extraHeaders = {},
  } = {},
) {
  const clientId = randomUUID();
  const response = await fetch(new URL(path, base), {
    method: value !== undefined || raw !== undefined ? "POST" : "GET",
    headers: {
      origin,
      cookie,
      "content-type": contentType,
      "x-request-id": clientId,
      ...extraHeaders,
    },
    body: raw ?? (value === undefined ? undefined : JSON.stringify(value)),
  });
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
  const requestId = response.headers.get("x-request-id");
  assert.match(
    requestId ?? "",
    uuid,
    "The server must issue a UUID request ID",
  );
  assert.notEqual(requestId, clientId, "Incoming request IDs must be ignored");
  assert.ok(
    !ids.has(requestId),
    "Every HTTP request must have a new server ID",
  );
  ids.add(requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const body = await response.json();
  if (code) {
    assert.deepEqual(Object.keys(body).sort(), ["code", "error", "requestId"]);
    assert.equal(body.code, code, `${path}: unexpected API error code`);
    assert.equal(
      body.requestId,
      requestId,
      "Error JSON and header IDs must match",
    );
    assert.equal(typeof body.error, "string");
    assert.ok(
      body.error.length > 0,
      "Legacy error explanations remain present",
    );
  }
  const setCookie = response.headers.getSetCookie();
  for (const line of setCookie) {
    const token = line.split(";")[0].split("=")[1];
    if (token) {
      secrets.add(token);
      secrets.add(createHash("sha256").update(token).digest("hex"));
    }
  }
  const serialized = JSON.stringify(body);
  for (const secret of secrets)
    assert.ok(
      !serialized.includes(secret),
      "HTTP bodies must redact authentication secrets",
    );
  for (const field of [
    '"token":',
    '"token_hash":',
    '"password_hash":',
    '"newSession":',
    "scrypt$",
  ])
    assert.ok(
      !serialized.includes(field),
      "HTTP bodies must expose only public authentication fields",
    );
  return {
    body,
    response,
    cookie: setCookie.map((line) => line.split(";")[0]).join("; "),
  };
}

for (const path of [
  "/api/snapshot",
  "/api/security",
  "/api/audit",
  "/api/deliveries",
])
  await api(path, { expected: 401, code: "auth_required" });
await api("/api/auth/register", {
  value: alice,
  expected: 403,
  code: "forbidden",
  origin: "https://another-app.example",
});
await api("/api/auth/register", {
  raw: "{}",
  contentType: "text/plain",
  expected: 415,
  code: "unsupported_media_type",
});
await api("/api/auth/register", {
  raw: "{}",
  extraHeaders: { "content-length": "2" },
  expected: 400,
  code: "invalid_request",
});
await api("/api/auth/register", {
  raw: "{" + " ".repeat(16_384),
  expected: 413,
  code: "payload_too_large",
});
const registered = await api("/api/auth/register", {
  value: alice,
  expected: 201,
});
const aliceCookie = registered.cookie;
assert.ok(aliceCookie, "Registration must create a session");
const secondCookie = (await api("/api/auth/login", { value: alice })).cookie;
const bobCookie = (
  await api("/api/auth/register", { value: bob, expected: 201 })
).cookie;
const original = (await api("/api/security", { cookie: aliceCookie })).body;
assert.equal(original.sessionCount, 2);
const bobSecurity = (await api("/api/security", { cookie: bobCookie })).body;

const badLogin = await api("/api/auth/login", {
  value: { ...alice, password: incorrectPassword },
  expected: 401,
  code: "invalid_credentials",
});
assert.equal(
  badLogin.cookie,
  "",
  "Incorrect credentials cannot replace a current session",
);
await api("/api/security", {
  cookie: aliceCookie,
  value: {
    type: "change-password",
    currentPassword: incorrectPassword,
    newPassword: replacementPassword,
  },
  expected: 401,
  code: "current_password_incorrect",
});
const afterWrongPassword = (await api("/api/security", { cookie: aliceCookie }))
  .body;
assert.equal(afterWrongPassword.currentSessionId, original.currentSessionId);
assert.equal(afterWrongPassword.sessionCount, original.sessionCount);
assert.ok(
  !afterWrongPassword.events.some((event) => event.kind === "password-changed"),
);

for (const query of ["page=0", "page=1&page=2", "owner=administrator"])
  await api("/api/audit?" + query, {
    cookie: aliceCookie,
    expected: 400,
    code: "invalid_request",
  });
await api("/api/action", {
  cookie: aliceCookie,
  value: { type: "pause", paused: false, owner: bobSecurity.user.id },
  expected: 400,
  code: "invalid_request",
});
await api("/api/recovery/replay", {
  cookie: aliceCookie,
  value: {
    items: [
      { eventId: "duplicate", expectedCycle: 1 },
      { eventId: "duplicate", expectedCycle: 1 },
    ],
  },
  expected: 400,
  code: "invalid_request",
});
await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-other-sessions", owner: bobSecurity.user.id },
  expected: 400,
  code: "invalid_request",
});
const foreign = await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-session", sessionId: bobSecurity.currentSessionId },
  expected: 404,
  code: "not_found",
});
const missing = await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-session", sessionId: "missing-session" },
  expected: 404,
  code: "not_found",
});
assert.equal(
  foreign.body.error,
  missing.body.error,
  "Ownership failures must not disclose foreign session existence",
);
await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-session", sessionId: original.currentSessionId },
  expected: 409,
  code: "conflict",
});
const revoked = await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-other-sessions" },
});
assert.equal(revoked.body.revokedSessions, 1);
assert.equal(revoked.body.security.sessionCount, 1);
await api("/api/security", {
  cookie: secondCookie,
  expected: 401,
  code: "auth_required",
});
const throttled = await api("/api/security", {
  cookie: aliceCookie,
  value: { type: "revoke-other-sessions" },
  expected: 429,
  code: "rate_limited",
});
assert.equal(throttled.response.headers.get("retry-after"), "600");
assert.equal(
  (await api("/api/security", { cookie: aliceCookie })).body.currentSessionId,
  original.currentSessionId,
);
assert.equal(
  (await api("/api/security", { cookie: bobCookie })).body.sessionCount,
  1,
);
for (const cookie of [aliceCookie, bobCookie])
  await api("/api/auth/logout", { cookie, value: {} });
console.log(
  "Request HTTP smoke passed: server-owned unique IDs, matching error JSON/headers, safe error codes, no-store/nosniff, distinct credential and password failures without session drift, strict schemas, owner-safe errors and unchanged security Retry-After.",
);
