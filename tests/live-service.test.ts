import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { RelayService } from "../lib/server/service.ts";
import { IntegrationService } from "../lib/server/integrations.ts";
import {
  LiveTransport,
  type LiveDeliveryRequest,
  type TransportResult,
} from "../lib/server/transport.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const result = (
  statusCode: number | null,
  retryAfterMs: number | null = null,
): TransportResult => ({
  statusCode,
  retryAfterMs,
  durationMs: 47,
  error: statusCode === 200 ? null : "Fixed delivery failure",
  failureCode:
    statusCode === 200
      ? null
      : statusCode === null
        ? "timeout"
        : "http_rejected",
});
class RecordingTransport extends LiveTransport {
  requests: LiveDeliveryRequest[] = [];
  replies: TransportResult[];
  constructor(replies: TransportResult[] = [result(200)]) {
    super({ policy: { allowedHosts: [], referenceEnabled: true } });
    this.replies = replies;
  }
  async send(request: LiveDeliveryRequest): Promise<TransportResult> {
    this.requests.push(request);
    return this.replies.shift() ?? result(200);
  }
}
async function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-live-service-"));
  const keyFile = join(directory, "master.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const previous = process.env.RELAYFORGE_MASTER_KEY_FILE;
  process.env.RELAYFORGE_MASTER_KEY_FILE = keyFile;
  const db = new SqliteTestDatabase();
  let now = 1_790_000_000_000;
  await db
    .prepare(
      "INSERT INTO users(id,email,password_hash,created_at) VALUES('owner','owner@example.test','unused',?)",
    )
    .bind(now)
    .run();
  const service = new RelayService(
    db,
    "owner",
    () => now,
    () => 0.5,
  );
  await service.initialize();
  const management = new IntegrationService(db, "owner", {
    keyFile,
    referenceEnabled: true,
    clock: () => now,
  });
  const created = await management.createConnection({
    name: "Independent receiver",
    transport: "reference",
  });
  context.after(() => {
    if (previous === undefined) delete process.env.RELAYFORGE_MASTER_KEY_FILE;
    else process.env.RELAYFORGE_MASTER_KEY_FILE = previous;
    db.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("relayforge-live-service-"));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    service,
    management,
    created,
    keyFile,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("browser fallback and generated Lab events cannot send to a live connection", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    { amount: 12 },
    "producer-one",
  );
  await f.service.action({ type: "demo" });
  await f.service.pump();
  const detail = await f.service.detail(eventId);
  assert.equal(detail.delivery.attempts, 0);
  assert.equal(detail.delivery.status, "pending");
  assert.equal(detail.attempts.length, 0);
  assert.equal((await f.service.snapshot()).scopes.live.metrics.total, 1);
  assert.equal((await f.service.snapshot()).scopes.lab.metrics.total, 12);
  assert.equal(
    (await f.service.receive(f.created.connection.id, "{}", f.now(), "invalid"))
      .status,
    404,
  );
  await assert.rejects(
    f.service.action({
      type: "set-receiver",
      endpointId: f.created.connection.id,
      mode: "healthy",
    }),
    { status: 409 },
  );
});

test("live HTTP retries retain immutable bytes and explicit cycle signing metadata", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    { amount: 12 },
    "stable-key",
  );
  const transport = new RecordingTransport([result(503, 30_000), result(200)]);
  await f.service.pump({ allowLive: true, transport, limit: 1 });
  let detail = await f.service.detail(eventId);
  assert.equal(detail.delivery.status, "retrying");
  assert.equal(detail.delivery.nextAttemptAt, f.now() + 30_000);
  assert.equal(detail.attempts[0].durationMs, 47);
  assert.equal(detail.attempts[0].connectionRevision, 1);
  assert.deepEqual(detail.attempts[0].signingKeyIds, [f.created.keyId]);
  const first = transport.requests[0];
  assert.equal(
    first.signatures[0].signature,
    createHmac("sha256", Buffer.from(f.created.signingSecret, "base64url"))
      .update(`${first.timestamp}.${first.body}`)
      .digest("hex"),
  );
  f.advance(29_999);
  await f.service.pump({ allowLive: true, transport });
  assert.equal(transport.requests.length, 1);
  f.advance(1);
  await f.service.pump({ allowLive: true, transport });
  detail = await f.service.detail(eventId);
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.payload, '{"amount":12}');
  assert.equal(JSON.parse(transport.requests[1].body).eventId, eventId);
  assert.equal(
    JSON.parse(transport.requests[1].body).createdAt,
    JSON.parse(first.body).createdAt,
  );
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.scopes.live.metrics.delivered, 1);
  assert.equal(snapshot.scopes.live.metrics.businessEffects, 0);
  assert.equal(snapshot.scopes.lab.metrics.total, 0);
});

test("network timeouts record measured duration with no fabricated HTTP status", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    {},
  );
  await f.service.pump({
    allowLive: true,
    transport: new RecordingTransport([result(null)]),
  });
  const detail = await f.service.detail(eventId);
  assert.equal(detail.delivery.latestAttempt?.statusCode, null);
  assert.equal(detail.delivery.latestAttempt?.failureCode, "timeout");
  assert.equal(detail.delivery.latestAttempt?.durationMs, 47);
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.scopes.live.metrics.avgLatency, 47);
  assert.equal(
    snapshot.scopes.live.chart.reduce((n, b) => n + b.failed, 0),
    1,
  );
  assert.equal(
    snapshot.endpoints.find((e) => e.id === f.created.connection.id)
      ?.lastDurationMs,
    47,
  );
});

test("terminal redirects and ordinary client errors stop before using the retry budget", async (context) => {
  const f = await fixture(context);
  for (const code of [301, 400, 401, 404, 422]) {
    const eventId = await f.service.send(
      f.created.connection.id,
      "invoice.paid",
      { code },
    );
    await f.service.pump({
      allowLive: true,
      transport: new RecordingTransport([result(code)]),
    });
    const detail = await f.service.detail(eventId);
    assert.equal(detail.delivery.status, "dead");
    assert.equal(detail.delivery.attempts, 1);
    assert.equal(detail.delivery.nextAttemptAt, null);
  }
});

test("pause, disabled transport and missing or mismatched master keys consume no attempt", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    {},
  );
  const transport = new RecordingTransport();
  await f.service.action({ type: "pause", paused: true });
  await f.service.pump({ allowLive: true, transport });
  await f.service.action({ type: "pause", paused: false });
  delete process.env.RELAYFORGE_MASTER_KEY_FILE;
  await f.service.pump({ allowLive: true, transport });
  process.env.RELAYFORGE_MASTER_KEY_FILE = f.keyFile;
  const original = readFileSync(f.keyFile);
  writeFileSync(f.keyFile, randomBytes(32));
  await f.service.pump({ allowLive: true, transport });
  writeFileSync(f.keyFile, original);
  await f.management.updateEnabled(f.created.connection.id, {
    enabled: false,
    expectedRevision: 1,
  });
  await f.service.pump({ allowLive: true, transport });
  assert.equal((await f.service.detail(eventId)).delivery.attempts, 0);
  assert.equal(transport.requests.length, 0);
  await f.management.updateEnabled(f.created.connection.id, {
    enabled: true,
    expectedRevision: 2,
  });
  await f.service.pump({ allowLive: true, transport });
  assert.equal((await f.service.detail(eventId)).delivery.status, "delivered");
});

test("replay resets the four-attempt budget while retaining prior live cycles", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    { amount: 12 },
    "immutable-replay",
  );
  const transport = new RecordingTransport([
    result(500),
    result(500),
    result(500),
    result(500),
    result(200),
  ]);
  for (let i = 0; i < 4; i++) {
    await f.service.pump({ allowLive: true, transport });
    f.advance(20_000);
  }
  assert.equal((await f.service.detail(eventId)).delivery.status, "dead");
  await f.service.replayBatch({ items: [{ eventId, expectedCycle: 1 }] });
  assert.equal((await f.service.detail(eventId)).delivery.attempts, 0);
  await f.service.pump({ allowLive: true, transport });
  const detail = await f.service.detail(eventId);
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.currentCycle, 2);
  assert.equal(detail.attempts.filter((a) => a.cycle === 1).length, 4);
  assert.equal(detail.attempts.filter((a) => a.cycle === 2).length, 1);
  assert.ok(
    transport.requests.every((r) => JSON.parse(r.body).eventId === eventId),
  );
  assert.ok(
    transport.requests.every(
      (r) => JSON.stringify(JSON.parse(r.body).payload) === '{"amount":12}',
    ),
  );
});

test("scope summaries and recent live events remain independent of the latest100 Lab events", async (context) => {
  const f = await fixture(context);
  const eventId = await f.service.send(
    f.created.connection.id,
    "invoice.paid",
    {},
  );
  f.advance(1000);
  const lab = (await f.service.snapshot()).endpoints.find(
    (e) => e.transport === "demo" && e.purpose === "standard",
  )!;
  for (let i = 0; i < 105; i++)
    await f.service.send(lab.id, "lab.sample", { i });
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.deliveries.length, 100);
  assert.ok(snapshot.deliveries.every((d) => d.transport === "demo"));
  assert.equal(snapshot.scopes.live.metrics.total, 1);
  assert.equal(snapshot.scopes.live.deliveries[0].id, eventId);
  assert.equal(snapshot.scopes.lab.metrics.total, 105);
});
