import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { IntegrationService } from "../lib/server/integrations.ts";
import { RelayService } from "../lib/server/service.ts";
import { RelayWorker, WORKER_NETWORK_CONCURRENCY } from "../lib/server/worker.ts";
import { LiveTransport } from "../lib/server/transport.ts";
import type { LiveDeliveryRequest, TransportResult } from "../lib/server/transport.ts";
import { LEASE_MS } from "../lib/server/domain.ts";
import { SigningKeyStore } from "../lib/server/signing.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const target = "https://hooks.relayforge.test/webhooks";
const accepted: TransportResult = { statusCode: 202, failureCode: null, error: null, durationMs: 10, retryAfterMs: null };

class ControlledTransport extends LiveTransport {
  calls: LiveDeliveryRequest[] = [];
  active = 0;
  peak = 0;
  private handler: (delivery: LiveDeliveryRequest) => Promise<TransportResult>;
  constructor(handler: (delivery: LiveDeliveryRequest) => Promise<TransportResult>) {
    super({ policy: { allowedHosts: ["hooks.relayforge.test"], referenceEnabled: true } });
    this.handler = handler;
  }
  override async send(delivery: LiveDeliveryRequest): Promise<TransportResult> {
    this.calls.push(delivery);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try { return await this.handler(delivery); }
    finally { this.active--; }
  }
}

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-live-worker-"));
  const masterFile = join(directory, "master.key");
  const master = randomBytes(32);
  writeFileSync(masterFile, master, { mode: 0o600 });
  const previous = process.env.RELAYFORGE_MASTER_KEY_FILE;
  process.env.RELAYFORGE_MASTER_KEY_FILE = masterFile;
  const db = new SqliteTestDatabase();
  const workers: RelayWorker[] = [];
  context.after(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    db.close();
    if (previous === undefined) delete process.env.RELAYFORGE_MASTER_KEY_FILE;
    else process.env.RELAYFORGE_MASTER_KEY_FILE = previous;
    rmSync(directory, { recursive: true });
  });
  return {
    db, master, masterFile,
    worker: (transport: LiveTransport) => { const worker = new RelayWorker(db, { transport }); workers.push(worker); return worker; },
    connection: async (owner: string, url = target) => {
      const service = new RelayService(db, owner);
      await service.initialize();
      const integration = new IntegrationService(db, owner, { allowedHosts: ["hooks.relayforge.test", "blocked.relayforge.test"], referenceEnabled: true });
      const created = await integration.createConnection({ name: "Production webhook", transport: "https", url });
      return { service, integration, endpointId: created.connection.id };
    },
  };
}

async function eventually(condition: () => boolean | Promise<boolean>, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await wait(5); }
  assert.fail("The expected worker state did not arrive.");
}

test("live worker admits four calls, shares overlapping ticks, and heartbeats during acknowledgements", async (context) => {
  const { db, connection, worker } = fixture(context);
  const services: { service: RelayService; event: string }[] = [];
  for (let index = 0; index < 8; index++) {
    const created = await connection(`owner-${index}`);
    services.push({ service: created.service, event: await created.service.send(created.endpointId, "invoice.paid", { index }) });
  }
  const completions: ((result: TransportResult) => void)[] = [];
  const transport = new ControlledTransport(() => new Promise((resolve) => completions.push(resolve)));
  const liveWorker = worker(transport);
  const processing = liveWorker.tick();
  const overlapping = liveWorker.tick();
  await eventually(() => transport.calls.length === WORKER_NETWORK_CONCURRENCY);
  const first = await db.prepare("SELECT last_seen_at FROM worker_heartbeats WHERE id=?").bind(liveWorker.id).first<{ last_seen_at: number }>();
  await wait(2_200);
  const renewed = await db.prepare("SELECT last_seen_at FROM worker_heartbeats WHERE id=?").bind(liveWorker.id).first<{ last_seen_at: number }>();
  assert.ok(first && renewed && renewed.last_seen_at >= first.last_seen_at + 1_900);
  assert.equal(transport.calls.length, 4);
  assert.equal(transport.peak, 4);
  for (const complete of completions.splice(0)) complete(accepted);
  await eventually(() => transport.calls.length === 8);
  assert.equal(transport.peak, 4);
  for (const complete of completions.splice(0)) complete(accepted);
  await Promise.all([processing, overlapping]);
  for (const { service, event } of services) {
    const detail = await service.detail(event);
    assert.equal(detail.delivery.status, "delivered");
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.attempts[0].statusCode, 202);
  }
  await liveWorker.stop();
  assert.equal(await db.prepare("SELECT id FROM worker_heartbeats WHERE id=?").bind(liveWorker.id).first(), null);
});

test("live events wait for a worker; pause and missing or mismatched configuration consume no attempts", async (context) => {
  const { db, master, masterFile, connection, worker } = fixture(context);
  const { service, endpointId } = await connection("alice");
  const event = await service.send(endpointId, "invoice.paid", { invoice: 42 });
  await service.pump();
  assert.equal((await service.detail(event)).attempts.length, 0);
  const transport = new ControlledTransport(async () => accepted);
  const liveWorker = worker(transport);
  await service.action({ type: "pause", paused: true });
  await liveWorker.tick();
  assert.equal(transport.calls.length, 0);
  assert.equal((await service.detail(event)).attempts.length, 0);
  await service.action({ type: "pause", paused: false });
  writeFileSync(masterFile, randomBytes(32), { mode: 0o600 });
  await liveWorker.tick();
  assert.equal(transport.calls.length, 0);
  assert.equal((await service.detail(event)).attempts.length, 0);
  writeFileSync(masterFile, master, { mode: 0o600 });
  const blockedWorker = worker(new LiveTransport({ policy: { allowedHosts: [], referenceEnabled: false } }));
  await blockedWorker.tick();
  assert.equal((await service.detail(event)).attempts.length, 0);
  await liveWorker.tick();
  assert.equal(transport.calls.length, 1);
  assert.equal((await service.detail(event)).delivery.status, "delivered");
  assert.equal((await service.snapshot()).metrics.businessEffects, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM receiver_effects").first<{ count: number }>())!.count, 0);
});

test("a slow live acknowledgement cannot overwrite a replacement after its lease expires", async (context) => {
  const { db, connection } = fixture(context);
  const { service, endpointId } = await connection("alice");
  const event = await service.send(endpointId, "invoice.paid", { invoice: 99 });
  let finishOld: ((result: TransportResult) => void) | undefined;
  const oldTransport = new ControlledTransport(() => new Promise((resolve) => { finishOld = resolve; }));
  const stalePump = service.pump({ allowLive: true, limit: 1, transport: oldTransport });
  await eventually(() => oldTransport.calls.length === 1);
  await db.prepare("UPDATE deliveries SET lease_until=? WHERE owner=? AND id=?").bind(Date.now() - 1, "alice", event).run();
  const currentTransport = new ControlledTransport(async () => accepted);
  await service.pump({ allowLive: true, limit: 1, transport: currentTransport });
  assert.equal((await service.detail(event)).delivery.status, "delivered");
  assert.ok(finishOld);
  finishOld({ statusCode: 503, failureCode: "http_rejected", error: "The receiver returned an unsuccessful HTTP status.", durationMs: LEASE_MS + 1, retryAfterMs: null });
  await stalePump;
  const detail = await service.detail(event);
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0].statusCode, null);
  assert.match(detail.attempts[0].error!, /lease expired/);
  assert.equal(detail.attempts[1].statusCode, 202);
});

test("a cursor advances beyond one hundred blocked workspaces without spending their retry budgets", async (context) => {
  const { db, connection, worker } = fixture(context);
  const created = await connection("owner-100");
  const ready = { service: created.service, event: await created.service.send(created.endpointId, "x", { ready: true }) };
  const now = Date.now();
  const signing = new SigningKeyStore();
  const blockedRows = Array.from({ length: 100 }, (_, index) => {
    const owner = `owner-${String(index).padStart(3, "0")}`;
    const endpointId = `blocked-${index}`;
    const keyId = `blocked-key-${index}`;
    const key = signing.create(owner, endpointId, keyId);
    return [
      db.prepare("INSERT INTO workspaces(owner,signing_secret,queue_paused,duplicates_prevented,created_at) VALUES(?, 'lab-only',0,0,?)").bind(owner, now),
      db.prepare("INSERT INTO endpoints(id,owner,name,description,color,mode,transport,destination_url,signing_key_id) VALUES(?,?,'Blocked destination','','lime','healthy','https','https://blocked.relayforge.test/webhooks',?)").bind(endpointId, owner, keyId),
      db.prepare("INSERT INTO connection_signing_keys(key_id,owner,endpoint_id,encrypted_secret,created_at,expires_at) VALUES(?,?,?,?,?,NULL)").bind(keyId, owner, endpointId, key.encryptedSecret, now),
      db.prepare("INSERT INTO deliveries(id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,attempts,current_cycle,created_at,updated_at,next_attempt_at) VALUES(?,?,?,'x','{}','blocked',?,'pending',0,1,?,?,?)").bind(`blocked-event-${index}`, owner, endpointId, `blocked-${index}`, now, now, now),
    ];
  }).flat();
  await db.batch(blockedRows);
  const transport = new ControlledTransport(async () => accepted);
  const liveWorker = worker(transport);
  await liveWorker.tick();
  assert.equal(transport.calls.length, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM attempts").first<{ count: number }>())!.count, 0);
  await liveWorker.tick();
  assert.equal(transport.calls.length, 1);
  assert.equal((await ready.service.detail(ready.event)).delivery.status, "delivered");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM attempts").first<{ count: number }>())!.count, 1);
});
