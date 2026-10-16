import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ApiError } from "../lib/server/domain.ts";
import {
  IntegrationService,
  enqueueProducerEvent,
  ProducerRateLimitError,
} from "../lib/server/integrations.ts";
import {
  SigningKeyStore,
  SigningConfigurationError,
  loadConnectionSigningKeys,
  signConnectionBody,
} from "../lib/server/signing.ts";
import { RelayService } from "../lib/server/service.ts";
import { SqliteTestDatabase } from "./sqlite.ts";
import type { SqlDatabase, SqlStatement } from "../lib/server/sql.ts";

const event = {
  eventType: "invoice.paid",
  payload: { amount: 120, currency: "EUR" },
};
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-signing-test-"));
  const keyFile = join(directory, "master.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const db = new SqliteTestDatabase();
  let now = 1_790_000_000_000;
  await db
    .prepare(
      "INSERT INTO users(id,email,password_hash,created_at) VALUES('owner','owner@example.test','unused',?)",
    )
    .bind(now)
    .run();
  const relay = new RelayService(db, "owner", () => now);
  await relay.initialize();
  const options = {
    keyFile,
    clock: () => now,
    allowedHosts: ["hooks.example.com"],
    referenceEnabled: true,
  };
  const service = new IntegrationService(db, "owner", options);
  const cleanup = () => {
    db.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("relayforge-signing-test-"));
    rmSync(directory, { recursive: true, force: true });
  };
  return {
    db,
    service,
    options,
    keyFile,
    directory,
    relay,
    cleanup,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function connected(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.service.createConnection({
    name: "Production invoices",
    transport: "https",
    url: "https://hooks.example.com/webhooks",
  });
  const key = await f.service.createProducerKey({
    name: "Billing producer",
    endpointId: created.connection.id,
  });
  return { ...created, ...key };
}
const apiStatus = (status: number) => (error: unknown) =>
  error instanceof ApiError && error.status === status;

test("connection signing is encrypted, bound to its owner and fails closed on tampering or wrong configuration", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const row = await f.db
    .prepare(
      "SELECT encrypted_secret FROM connection_signing_keys WHERE key_id=?",
    )
    .bind(created.keyId)
    .first<{ encrypted_secret: string }>();
  assert.ok(row);
  assert.equal(row.encrypted_secret.includes(created.signingSecret), false);
  const store = new SigningKeyStore(f.options);
  assert.equal(
    store
      .decrypt(
        "owner",
        created.connection.id,
        created.keyId,
        row.encrypted_secret,
      )
      .toString("base64url"),
    created.signingSecret,
  );
  assert.throws(
    () =>
      store.decrypt(
        "other",
        created.connection.id,
        created.keyId,
        row.encrypted_secret,
      ),
    SigningConfigurationError,
  );
  const tampered = row.encrypted_secret.split(":");
  const ciphertext = Buffer.from(tampered[2], "base64url");
  ciphertext[0] ^= 0xff;
  tampered[2] = ciphertext.toString("base64url");
  assert.throws(
    () =>
      store.decrypt(
        "owner",
        created.connection.id,
        created.keyId,
        tampered.join(":"),
      ),
    SigningConfigurationError,
  );
  assert.throws(
    () =>
      store.decrypt("owner", "another", created.keyId, row.encrypted_secret),
    SigningConfigurationError,
  );
  assert.throws(
    () =>
      store.decrypt(
        "owner",
        created.connection.id,
        created.keyId,
        row.encrypted_secret.replace(/^v1:/, "v2:"),
      ),
    SigningConfigurationError,
  );
  const wrongFile = join(f.directory, "wrong.key");
  writeFileSync(wrongFile, randomBytes(32), { mode: 0o600 });
  assert.throws(
    () =>
      new SigningKeyStore({ keyFile: wrongFile }).decrypt(
        "owner",
        created.connection.id,
        created.keyId,
        row.encrypted_secret,
      ),
    SigningConfigurationError,
  );
  assert.equal(
    new SigningKeyStore({ keyFile: join(f.directory, "missing") }).available(),
    false,
  );
  assert.equal(
    new SigningKeyStore({
      keyFile: f.keyFile,
      projectDirectory: f.directory,
    }).available(),
    false,
  );
  const publicJson = JSON.stringify(await f.service.listConnections());
  assert.equal(publicJson.includes(created.signingSecret), false);
  assert.equal(publicJson.includes(row.encrypted_secret), false);
});

test("connections retain immutable targets and guard owner isolation, revision updates and audit rollback", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  await assert.rejects(
    f.service.createConnection({
      name: "Blocked",
      transport: "https",
      url: "https://evil.example/webhook",
    }),
    apiStatus(400),
  );
  await assert.rejects(
    f.service.createConnection({
      name: "Local",
      transport: "reference",
      url: "http://127.0.0.1:9999",
    }),
    apiStatus(400),
  );
  await assert.rejects(
    f.service.updateEnabled(created.connection.id, {
      enabled: false,
      expectedRevision: 1,
      url: "https://hooks.example.com/other",
    }),
    apiStatus(400),
  );
  const updated = await f.service.updateEnabled(created.connection.id, {
    enabled: false,
    expectedRevision: 1,
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.revision, 2);
  assert.equal(updated.url, created.connection.url);
  await assert.rejects(
    f.service.updateEnabled(created.connection.id, {
      enabled: true,
      expectedRevision: 1,
    }),
    apiStatus(409),
  );
  const foreign = new IntegrationService(f.db, "different", f.options);
  await assert.rejects(
    foreign.updateEnabled(created.connection.id, {
      enabled: true,
      expectedRevision: 2,
    }),
    apiStatus(404),
  );
  f.db.connection.exec(
    "CREATE TRIGGER reject_integration_audit BEFORE INSERT ON activity WHEN NEW.kind='system' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
  );
  await assert.rejects(
    f.service.updateEnabled(created.connection.id, {
      enabled: true,
      expectedRevision: 2,
    }),
  );
  const unchanged = (await f.service.listConnections()).find(
    (row) => row.id === created.connection.id,
  )!;
  assert.equal(unchanged.enabled, false);
  assert.equal(unchanged.revision, 2);
});

test("a replaced master key disables global signing configuration and cannot create mixed-key connections", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  await connected(f);
  assert.equal((await f.service.configuration()).signingAvailable, true);
  writeFileSync(f.keyFile, randomBytes(32), { mode: 0o600 });
  assert.equal((await f.service.configuration()).signingAvailable, false);
  await assert.rejects(
    f.service.createConnection({ name: "Wrong key", transport: "reference" }),
    apiStatus(409),
  );
  await f.db
    .prepare(
      "INSERT INTO users(id,email,password_hash,created_at) VALUES('second','second@example.test','unused',?)",
    )
    .bind(f.now())
    .run();
  await new RelayService(f.db, "second", f.now).initialize();
  const second = new IntegrationService(f.db, "second", f.options);
  assert.equal((await second.configuration()).signingAvailable, false);
  await assert.rejects(
    second.createConnection({
      name: "Wrong key in another workspace",
      transport: "reference",
    }),
    apiStatus(409),
  );
  assert.equal(
    (
      await f.db
        .prepare(
          "SELECT COUNT(*) AS count FROM endpoints WHERE transport IN ('https','reference')",
        )
        .first<{ count: number }>()
    )?.count,
    1,
  );
});

test("connection latency ignores interrupted history and includes measured network failures", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const acceptance = await enqueueProducerEvent(
    f.db,
    created.token,
    "latency-history",
    event,
    f.now(),
  );
  await f.db
    .prepare(
      "INSERT INTO attempts(id,owner,event_id,number,cycle,error,duration_ms,created_at,finished_at) VALUES('expired','owner',?,1,1,'Worker lease expired before acknowledgment',0,?,?)",
    )
    .bind(acceptance.eventId, f.now(), f.now())
    .run();
  assert.equal(
    (await f.service.listConnections()).find(
      (row) => row.id === created.connection.id,
    )?.lastDurationMs,
    null,
  );
  await f.db
    .prepare(
      "INSERT INTO attempts(id,owner,event_id,number,cycle,error,failure_code,duration_ms,created_at,finished_at) VALUES('network','owner',?,2,1,'Network failure','network_error',42,?,?)",
    )
    .bind(acceptance.eventId, f.now() + 1, f.now() + 43)
    .run();
  assert.equal(
    (await f.service.listConnections()).find(
      (row) => row.id === created.connection.id,
    )?.lastDurationMs,
    42,
  );
});

test("concurrent signing rotation wins once, emits two signatures in grace and expires previous keys", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const results = await Promise.allSettled([
    f.service.rotateSigningKey(created.connection.id, { expectedRevision: 1 }),
    f.service.rotateSigningKey(created.connection.id, { expectedRevision: 1 }),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  const rotated = results.find((row) => row.status === "fulfilled")!;
  assert.equal(rotated.status, "fulfilled");
  if (rotated.status !== "fulfilled") return;
  assert.equal(rotated.value.connection.signing?.previousKeyId, created.keyId);
  const keys = await loadConnectionSigningKeys(
    f.db,
    "owner",
    created.connection.id,
    f.now(),
    f.options,
  );
  assert.equal(keys.length, 2);
  assert.equal(keys[0].keyId, rotated.value.keyId);
  await f.db
    .prepare(
      "UPDATE endpoints SET signing_key_id='missing-current-key' WHERE id=?",
    )
    .bind(created.connection.id)
    .run();
  await assert.rejects(
    loadConnectionSigningKeys(
      f.db,
      "owner",
      created.connection.id,
      f.now(),
      f.options,
    ),
    SigningConfigurationError,
  );
  await f.db
    .prepare("UPDATE endpoints SET signing_key_id=? WHERE id=?")
    .bind(rotated.value.keyId, created.connection.id)
    .run();
  assert.equal(
    signConnectionBody(keys, f.now(), JSON.stringify(event)).length,
    2,
  );
  await assert.rejects(
    f.service.rotateSigningKey(created.connection.id, { expectedRevision: 2 }),
    apiStatus(409),
  );
  f.advance(86_400_001);
  assert.equal(
    (
      await loadConnectionSigningKeys(
        f.db,
        "owner",
        created.connection.id,
        f.now(),
        f.options,
      )
    ).length,
    1,
  );
  assert.equal(
    (await f.service.listConnections()).find(
      (row) => row.id === created.connection.id,
    )?.signing?.previousKeyId,
    null,
  );
});

test("producer tokens are shown once, endpoint scoped and expiry, revocation and disabled targets are enforced", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  assert.match(created.token, /^rf_live_[A-Za-z0-9_-]{43}$/);
  const stored = await f.db
    .prepare("SELECT token_hash FROM producer_keys WHERE id=?")
    .bind(created.key.id)
    .first<{ token_hash: string }>();
  assert.ok(stored);
  assert.notEqual(stored.token_hash, created.token);
  assert.equal(
    JSON.stringify(await f.service.listProducerKeys()).includes(created.token),
    false,
  );
  const accepted = await enqueueProducerEvent(
    f.db,
    created.token,
    "request-1",
    event,
    f.now(),
  );
  const delivery = await f.db
    .prepare("SELECT endpoint_id,owner FROM deliveries WHERE id=?")
    .bind(accepted.eventId)
    .first<{ endpoint_id: string; owner: string }>();
  assert.equal(delivery?.endpoint_id, created.connection.id);
  assert.equal(delivery?.owner, "owner");
  await assert.rejects(
    enqueueProducerEvent(
      f.db,
      created.token,
      "spoof",
      { ...event, endpointId: "other" },
      f.now(),
    ),
    apiStatus(400),
  );
  await f.service.updateEnabled(created.connection.id, {
    enabled: false,
    expectedRevision: 1,
  });
  await assert.rejects(
    enqueueProducerEvent(f.db, created.token, "disabled", event, f.now()),
    apiStatus(401),
  );
  await f.service.updateEnabled(created.connection.id, {
    enabled: true,
    expectedRevision: 2,
  });
  await f.service.revokeProducerKey(created.key.id);
  await assert.rejects(
    enqueueProducerEvent(f.db, created.token, "revoked", event, f.now()),
    apiStatus(401),
  );
  const expiring = await f.service.createProducerKey({
    name: "Short lived",
    endpointId: created.connection.id,
    expiresInDays: 1,
  });
  f.advance(86_400_000);
  await assert.rejects(
    enqueueProducerEvent(f.db, expiring.token, "expired", event, f.now()),
    apiStatus(401),
  );
  await assert.rejects(
    new IntegrationService(f.db, "different", f.options).revokeProducerKey(
      expiring.key.id,
    ),
    apiStatus(404),
  );
});

test("producer idempotency preserves the original event and rejects changed payloads atomically", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const original = await enqueueProducerEvent(
    f.db,
    created.token,
    "same",
    event,
    f.now(),
  );
  const duplicate = await enqueueProducerEvent(
    f.db,
    created.token,
    "same",
    { eventType: event.eventType, payload: { currency: "EUR", amount: 120 } },
    f.now(),
  );
  assert.equal(original.duplicate, false);
  assert.deepEqual(duplicate, { eventId: original.eventId, duplicate: true });
  await assert.rejects(
    enqueueProducerEvent(
      f.db,
      created.token,
      "same",
      { ...event, payload: { amount: 121 } },
      f.now(),
    ),
    apiStatus(409),
  );
  const count = await f.db
    .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE endpoint_id=?")
    .bind(created.connection.id)
    .first<{ count: number }>();
  assert.equal(count?.count, 1);
  const snapshot = await f.relay.snapshot();
  assert.equal(snapshot.metrics.duplicatesPrevented, 1);
  assert.equal((await f.service.listProducerKeys())[0].lastUsedAt, f.now());
});

test("producer quotas allow 60 requests per key and 240 per workspace, then reset at the minute boundary", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const keys = [created];
  for (let i = 0; i < 4; i++)
    keys.push({
      ...created,
      ...(await f.service.createProducerKey({
        name: `Producer ${i}`,
        endpointId: created.connection.id,
      })),
    });
  for (let index = 0; index < 240; index++)
    await enqueueProducerEvent(
      f.db,
      keys[Math.floor(index / 60)].token,
      "same",
      event,
      f.now(),
    );
  await assert.rejects(
    enqueueProducerEvent(f.db, created.token, "same", event, f.now()),
    (error) =>
      error instanceof ProducerRateLimitError &&
      error.retryAfter > 0 &&
      error.retryAfter <= 60,
  );
  await assert.rejects(
    enqueueProducerEvent(f.db, keys[4].token, "same", event, f.now()),
    apiStatus(429),
  );
  f.advance(60_000);
  assert.equal(
    (await enqueueProducerEvent(f.db, created.token, "same", event, f.now()))
      .duplicate,
    true,
  );
});

test("producer authorization is rechecked inside the transaction when a key is revoked after parsing", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  const revoking: SqlDatabase = {
    prepare: (sql: string) => f.db.prepare(sql),
    batch: async <T>(statements: SqlStatement[]) => {
      await f.db
        .prepare("UPDATE producer_keys SET revoked_at=? WHERE id=?")
        .bind(f.now(), created.key.id)
        .run();
      return f.db.batch<T>(statements);
    },
  };
  await assert.rejects(
    enqueueProducerEvent(revoking, created.token, "race", event, f.now()),
    apiStatus(401),
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE endpoint_id=?")
        .bind(created.connection.id)
        .first<{ count: number }>()
    )?.count,
    0,
  );
});

test("producer event, quota and usage writes roll back together if durable audit fails", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  f.db.connection.exec(
    "CREATE TRIGGER reject_accepted BEFORE INSERT ON activity WHEN NEW.kind='accepted' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;",
  );
  await assert.rejects(
    enqueueProducerEvent(f.db, created.token, "rollback", event, f.now()),
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE endpoint_id=?")
        .bind(created.connection.id)
        .first<{ count: number }>()
    )?.count,
    0,
  );
  assert.equal(
    (
      await f.db
        .prepare("SELECT COUNT(*) AS count FROM producer_rate_limits")
        .first<{ count: number }>()
    )?.count,
    0,
  );
  assert.equal((await f.service.listProducerKeys())[0].lastUsedAt, null);
});

test("producer key creation enforces 10 active keys while expired or revoked keys release capacity", async (context) => {
  const f = await fixture();
  context.after(f.cleanup);
  const created = await connected(f);
  for (let i = 0; i < 9; i++)
    await f.service.createProducerKey({
      name: `Producer ${i}`,
      endpointId: created.connection.id,
    });
  await assert.rejects(
    f.service.createProducerKey({
      name: "Overflow",
      endpointId: created.connection.id,
    }),
    apiStatus(409),
  );
  await f.service.revokeProducerKey(created.key.id);
  assert.ok(
    (
      await f.service.createProducerKey({
        name: "Replacement",
        endpointId: created.connection.id,
      })
    ).token,
  );
});
