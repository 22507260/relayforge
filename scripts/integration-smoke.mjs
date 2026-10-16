import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile, rename, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://localhost:3000");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
  base.username ||
  base.password ||
  process.env.RELAYFORGE_HTTP_VERIFICATION !== "true"
) {
  throw new Error(
    "Integration HTTP verification requires an isolated loopback runner.",
  );
}
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function outsideFile(value) {
  if (!value || !isAbsolute(value))
    throw new Error(
      "Verification fixture paths must be absolute and outside the project.",
    );
  const actual = await realpath(value),
    difference = relative(project, actual);
  if (
    !difference ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  )
    throw new Error("Verification fixtures must stay outside the project.");
  return actual;
}
const keysFile = await outsideFile(process.env.RELAYFORGE_REFERENCE_KEYS_FILE);
const receiverFile = await outsideFile(
  process.env.RELAYFORGE_REFERENCE_DATABASE,
);
const applicationFile = await outsideFile(process.env.DATABASE_PATH);
const secrets = new Set();
let aliceCookie = "",
  bobCookie = "";
function remember(value) {
  secrets.add(value);
  secrets.add(createHash("sha256").update(value).digest("hex"));
}
async function api(
  path,
  {
    body,
    method = body === undefined ? "GET" : "POST",
    cookie = aliceCookie,
    expected = 200,
    token,
    origin = base.origin,
    idempotencyKey,
  } = {},
) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      "content-type": "application/json",
      origin,
      cookie,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`);
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  const value = await response.json();
  const serialized = JSON.stringify(value);
  for (const secret of secrets)
    assert.ok(
      !serialized.includes(secret),
      "Public HTTP responses must redact stored secrets.",
    );
  for (const field of [
    '"encrypted_secret":',
    '"token_hash":',
    '"password_hash":',
  ])
    assert.ok(
      !serialized.includes(field),
      "Private persistence fields must not leave the server.",
    );
  const cookieHeader = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { value, response, cookie: cookieHeader };
}
async function register(label) {
  const password = randomBytes(24).toString("base64url");
  remember(password);
  const result = await api("/api/auth/register", {
    cookie: "",
    body: {
      email: `integration-${label}-${randomUUID()}@example.test`,
      password,
    },
    expected: 201,
  });
  for (const field of result.cookie.split("; ")) {
    const token = field.split("=")[1];
    if (token) remember(token);
  }
  return result.cookie;
}
async function configure(connection, keyId, secret, mode, previous) {
  const configuration = {
    mode,
    connections: [
      {
        endpointId: connection.id,
        keys: [{ keyId, secret }, ...(previous ? [previous] : [])],
      },
    ],
  };
  const temporary = `${keysFile}.next`;
  await writeFile(temporary, JSON.stringify(configuration), { mode: 0o600 });
  await rename(temporary, keysFile);
}
async function detail(eventId) {
  return (await api(`/api/deliveries/${eventId}`)).value;
}
async function eventually(eventId, status) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = await detail(eventId);
    if (value.delivery.status === status) return value;
    await wait(200);
  }
  throw new Error(
    `Worker did not reach ${status} within the verification deadline.`,
  );
}
function receiverProof(endpointId, eventId) {
  const database = new DatabaseSync(receiverFile, { readOnly: true });
  try {
    return {
      effects: database
        .prepare(
          "SELECT COUNT(*) AS count FROM effects WHERE endpoint_id=? AND event_id=?",
        )
        .get(endpointId, eventId).count,
      receipts: database
        .prepare(
          "SELECT attempt,cycle,acknowledged,status_code FROM receipts WHERE endpoint_id=? AND event_id=? ORDER BY id",
        )
        .all(endpointId, eventId),
    };
  } finally {
    database.close();
  }
}

await api("/api/connections", { cookie: "", expected: 401 });
await api("/api/producer-keys", { cookie: "", expected: 401 });
aliceCookie = await register("primary");
bobCookie = await register("foreign");
await api("/api/action", { body: { type: "initialize" } });
await api("/api/action", { body: { type: "pause", paused: true } });
const configuration = (await api("/api/connections")).value.configuration;
assert.equal(configuration.referenceEnabled, true);
assert.equal(configuration.signingAvailable, true);
assert.ok(configuration.allowedHosts.includes("hooks.example.com"));
await api("/api/connections", {
  body: {
    name: "Forbidden host",
    transport: "https",
    url: "https://evil.example/webhooks",
  },
  expected: 400,
});
await api("/api/connections", {
  body: {
    name: "Private address",
    transport: "https",
    url: "https://127.0.0.1/webhooks",
  },
  expected: 400,
});
await api("/api/connections", {
  body: {
    name: "Reference override",
    transport: "reference",
    url: "http://127.0.0.1:9999/webhooks",
  },
  expected: 400,
});
await api("/api/connections", {
  body: { name: "Cross-site", transport: "reference" },
  origin: "https://other.example",
  expected: 403,
});
const created = (
  await api("/api/connections", {
    body: { name: "Reference invoices", transport: "reference" },
    expected: 201,
  })
).value;
const connection = created.connection;
remember(created.signingSecret);
assert.equal(connection.transport, "reference");
assert.equal(connection.mode, null);
assert.equal(connection.revision, 1);
await configure(
  connection,
  created.keyId,
  created.signingSecret,
  "lose-first-ack",
);
const keyCreated = (
  await api("/api/producer-keys", {
    body: { name: "Scoped billing", endpointId: connection.id },
    expected: 201,
  })
).value;
const token = keyCreated.token;
remember(token);
assert.equal(keyCreated.key.endpointId, connection.id);
assert.equal(keyCreated.key.scope, "events:write");
await api("/api/connections", { cookie: "", token, expected: 401 });
const foreignConnections = (
  await api("/api/connections", { cookie: bobCookie })
).value;
assert.equal(
  foreignConnections.connections.some((row) => row.id === connection.id),
  false,
);
await api(`/api/connections/${connection.id}`, {
  cookie: bobCookie,
  method: "PATCH",
  body: { enabled: false, expectedRevision: 1 },
  expected: 404,
});
await api(`/api/producer-keys/${keyCreated.key.id}`, {
  cookie: bobCookie,
  method: "DELETE",
  expected: 404,
});
assert.equal(
  (await api("/api/producer-keys", { cookie: bobCookie })).value.keys.length,
  0,
);
const event = {
  eventType: "invoice.paid",
  payload: { amount: 120, currency: "EUR" },
};
await api("/api/v1/events", {
  body: event,
  idempotencyKey: "cookie-only",
  expected: 401,
});
await api("/api/v1/events", { cookie: "", token, body: event, expected: 400 });
await api("/api/v1/events", {
  cookie: "",
  token,
  body: { ...event, endpointId: "spoof" },
  idempotencyKey: "spoof",
  expected: 400,
});
const original = (
  await api("/api/v1/events", {
    cookie: "",
    token,
    body: event,
    idempotencyKey: "same-invoice",
    expected: 202,
  })
).value;
assert.equal(original.duplicate, false);
const duplicate = (
  await api("/api/v1/events", {
    cookie: bobCookie,
    token,
    body: {
      eventType: event.eventType,
      payload: { currency: "EUR", amount: 120 },
    },
    idempotencyKey: "same-invoice",
    expected: 202,
  })
).value;
assert.deepEqual(duplicate, { eventId: original.eventId, duplicate: true });
await api("/api/v1/events", {
  cookie: "",
  token,
  body: { ...event, payload: { amount: 121 } },
  idempotencyKey: "same-invoice",
  expected: 409,
});
await api(`/api/connections/${connection.id}/events`, {
  body: { ...event, idempotencyKey: "same-invoice" },
  expected: 202,
});
assert.equal(
  (await detail(original.eventId)).attempts.length,
  0,
  "Pause preserves the queued event without consuming attempts.",
);
await api("/api/action", { body: { type: "pause", paused: false } });
const acknowledged = await eventually(original.eventId, "delivered");
assert.equal(acknowledged.attempts.length, 2);
assert.equal(acknowledged.attempts[0].statusCode, null);
assert.equal(acknowledged.attempts[0].failureCode, "network_error");
assert.equal(acknowledged.attempts[1].statusCode, 200);
assert.ok(
  acknowledged.attempts.every(
    (row) =>
      row.finishedAt !== null &&
      row.connectionRevision === 1 &&
      row.signingKeyIds.includes(created.keyId),
  ),
);
const proof = receiverProof(connection.id, original.eventId);
assert.equal(proof.effects, 1);
assert.equal(proof.receipts.length, 2);
assert.equal(proof.receipts[0].acknowledged, 0);
assert.equal(proof.receipts[1].acknowledged, 1);
await configure(connection, created.keyId, created.signingSecret, "failing");
const failed = (
  await api("/api/v1/events", {
    cookie: "",
    token,
    body: event,
    idempotencyKey: "recover-this",
    expected: 202,
  })
).value;
const dead = await eventually(failed.eventId, "dead");
assert.equal(dead.attempts.length, 4);
assert.equal(dead.delivery.currentCycle, 1);
assert.ok(
  dead.attempts.every((row) => row.statusCode === 503 && row.cycle === 1),
);
await api("/api/action", { body: { type: "pause", paused: true } });
const rotated = (
  await api(`/api/connections/${connection.id}/rotate`, {
    body: { expectedRevision: 1 },
  })
).value;
remember(rotated.signingSecret);
assert.equal(rotated.connection.revision, 2);
assert.equal(rotated.connection.signing.previousKeyId, created.keyId);
await api(`/api/connections/${connection.id}/rotate`, {
  body: { expectedRevision: 1 },
  expected: 409,
});
await configure(
  connection,
  rotated.keyId,
  rotated.signingSecret,
  "lose-first-ack",
  {
    keyId: created.keyId,
    secret: created.signingSecret,
    expiresAt: rotated.connection.signing.previousExpiresAt,
  },
);
await api("/api/recovery/replay", {
  body: { items: [{ eventId: failed.eventId, expectedCycle: 1 }] },
});
const queued = await detail(failed.eventId);
assert.equal(queued.delivery.currentCycle, 2);
assert.equal(queued.delivery.attempts, 0);
assert.equal(queued.attempts.length, 4);
await api("/api/action", { body: { type: "pause", paused: false } });
const recovered = await eventually(failed.eventId, "delivered");
assert.equal(recovered.delivery.id, failed.eventId);
assert.equal(recovered.delivery.payload, dead.delivery.payload);
assert.deepEqual(
  recovered.attempts.map((row) => row.cycle),
  [1, 1, 1, 1, 2, 2],
);
assert.ok(
  recovered.attempts
    .filter((row) => row.cycle === 2)
    .every(
      (row) => row.connectionRevision === 2 && row.signingKeyIds.length === 2,
    ),
);
assert.equal(receiverProof(connection.id, failed.eventId).effects, 1);
const snapshot = (await api("/api/snapshot")).value;
assert.equal(snapshot.scopes.live.metrics.total, 2);
assert.equal(snapshot.scopes.live.metrics.businessEffects, 0);
await api(`/api/connections/${connection.id}`, {
  method: "PATCH",
  body: { enabled: false, expectedRevision: 2 },
});
await api("/api/v1/events", {
  cookie: "",
  token,
  body: event,
  idempotencyKey: "disabled",
  expected: 401,
});
await api(`/api/connections/${connection.id}`, {
  method: "PATCH",
  body: { enabled: true, expectedRevision: 2 },
  expected: 409,
});
await api(`/api/connections/${connection.id}`, {
  method: "PATCH",
  body: { enabled: true, expectedRevision: 3 },
});
const expires = (
  await api("/api/producer-keys", {
    body: {
      name: "Expiry fixture",
      endpointId: connection.id,
      expiresInDays: 1,
    },
    expected: 201,
  })
).value;
remember(expires.token);
const application = new DatabaseSync(applicationFile);
try {
  application.exec("PRAGMA busy_timeout = 5000");
  application
    .prepare("UPDATE producer_keys SET expires_at=? WHERE id=?")
    .run(Date.now() - 1, expires.key.id);
} finally {
  application.close();
}
await api("/api/v1/events", {
  cookie: "",
  token: expires.token,
  body: event,
  idempotencyKey: "expired",
  expected: 401,
});
let limited = false;
if (Date.now() % 60_000 > 54_000) await wait(60_010 - (Date.now() % 60_000));
for (let request = 0; request < 61; request++) {
  const response = await fetch(new URL("/api/v1/events", base), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "same-invoice",
    },
    body: JSON.stringify(event),
  });
  await response.body?.cancel();
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    assert.ok(retry > 0 && retry <= 60);
    limited = true;
    break;
  }
  assert.equal(response.status, 202);
}
assert.equal(limited, true, "Producer HTTP quota must reject excess requests.");
await api(`/api/producer-keys/${keyCreated.key.id}`, { method: "DELETE" });
await api("/api/v1/events", {
  cookie: "",
  token,
  body: event,
  idempotencyKey: "revoked",
  expected: 401,
});
const keys = (await api("/api/producer-keys")).value.keys;
assert.ok(keys.find((row) => row.id === keyCreated.key.id)?.revokedAt);
console.log(
  "Integration HTTP checks passed: scoped producers, protected signing, live retry/replay, and one independent receiver effect.",
);
