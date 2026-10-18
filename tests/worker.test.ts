import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  WORKER_HEARTBEAT_TTL_MS,
} from "../lib/server/domain.ts";
import { RelayService } from "../lib/server/service.ts";
import { RelayWorker } from "../lib/server/worker.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

interface WorkerProcess {
  child: ChildProcess;
  exited: Promise<void>;
  output: () => string;
}

async function eventually(
  condition: () => Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function startProcess(filename: string): WorkerProcess {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      join(process.cwd(), "scripts", "worker.mjs"),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_PATH: filename },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8_000);
    });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
  return { child, exited, output: () => output };
}

async function killProcess(worker: WorkerProcess): Promise<void> {
  if (worker.child.exitCode === null && worker.child.signalCode === null)
    worker.child.kill("SIGKILL");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Worker did not exit after termination.")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function diskFixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-worker-"));
  const filename = join(directory, "queue.sqlite");
  const db = new SqliteTestDatabase(filename);
  const processes: WorkerProcess[] = [];
  context.after(async () => {
    await Promise.all(processes.map(killProcess));
    db.close();
    rmSync(directory, { recursive: true });
  });
  return {
    db,
    start: () => {
      const worker = startProcess(filename);
      processes.push(worker);
      return worker;
    },
  };
}

test("standalone process retries without HTTP or browser pumps and respects workspace pause", async (context) => {
  const { db, start } = diskFixture(context);
  const alice = new RelayService(db, "alice");
  const bob = new RelayService(db, "bob");
  await alice.initialize();
  await bob.initialize();
  const flaky = (await alice.snapshot()).endpoints.find(
    (endpoint) => endpoint.mode === "flaky",
  )!;
  const healthy = (await bob.snapshot()).endpoints.find(
    (endpoint) => endpoint.mode === "healthy",
  )!;
  await bob.action({ type: "pause", paused: true });
  // send() persists only: neither request-driven actions nor pumps run after this.
  const event = await alice.send(flaky.id, "invoice.paid", { invoice: 42 });
  const paused = await bob.send(healthy.id, "order.completed", { order: 7 });
  const worker = start();
  await eventually(
    async () => (await alice.detail(event)).delivery.status === "delivered",
    "autonomous flaky receiver delivery",
  );
  const detail = await alice.detail(event);
  assert.deepEqual(
    detail.attempts.map((attempt) => attempt.statusCode),
    [503, 503, 200],
  );
  assert.equal((await alice.snapshot()).metrics.businessEffects, 1);
  assert.equal((await bob.detail(paused)).attempts.length, 0);
  assert.equal((await bob.snapshot()).metrics.businessEffects, 0);
  assert.ok((await alice.snapshot()).system.worker.activeWorkers >= 1);
  assert.match(worker.output(), /worker started/);

  await db
    .prepare("UPDATE workspaces SET queue_paused = 0 WHERE owner = ?")
    .bind("bob")
    .run();
  await eventually(
    async () => (await bob.detail(paused)).delivery.status === "delivered",
    "autonomous delivery after resume",
  );
  assert.equal((await bob.detail(paused)).attempts.length, 1);
  assert.equal((await bob.snapshot()).metrics.businessEffects, 1);
  assert.equal((await alice.snapshot()).metrics.total, 1);
  assert.equal((await bob.snapshot()).metrics.total, 1);
});

test("heartbeat expiry and per-worker shutdown preserve other observed workers", async (context) => {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  let now = 1_800_000_000_000;
  const service = new RelayService(db, "alice", () => now);
  await service.initialize();
  const first = new RelayWorker(db, { clock: () => now });
  const second = new RelayWorker(db, { clock: () => now });
  await first.tick();
  await second.tick();
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 2);
  await first.stop();
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 1);

  now += WORKER_HEARTBEAT_TTL_MS + 1;
  const stale = await service.snapshot();
  assert.equal(stale.system.worker.activeWorkers, 0);
  assert.equal(stale.system.processor, "request-driven");
  const replacement = new RelayWorker(db, { clock: () => now });
  await replacement.tick();
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 1);
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) AS count FROM worker_heartbeats")
      .first<{ count: number }>())!.count,
    1,
  );
  await second.stop();
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 1);
  await replacement.stop();
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 0);
});

test("snapshot heartbeat observations reject future records and expire at the exact freshness boundary", async (context) => {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  let now = 1_800_000_000_000;
  const service = new RelayService(db, "alice", () => now);
  await service.initialize();
  const heartbeat = db.connection.prepare(
    "INSERT INTO worker_heartbeats(id,started_at,last_seen_at) VALUES (?,?,?)",
  );
  heartbeat.run("future", now + 1, now + 1);
  let observation = (await service.snapshot()).system;
  assert.equal(observation.worker.activeWorkers, 0);
  assert.equal(observation.worker.lastHeartbeatAt, null);
  assert.equal(observation.processor, "request-driven");
  heartbeat.run(
    "boundary",
    now - WORKER_HEARTBEAT_TTL_MS,
    now - WORKER_HEARTBEAT_TTL_MS,
  );
  observation = (await service.snapshot()).system;
  assert.equal(observation.worker.activeWorkers, 0);
  assert.equal(
    observation.worker.lastHeartbeatAt,
    now - WORKER_HEARTBEAT_TTL_MS,
  );
  now += 1;
  observation = (await service.snapshot()).system;
  assert.equal(observation.worker.activeWorkers, 1);
  assert.equal(observation.worker.lastHeartbeatAt, now);
  assert.equal(observation.processor, "worker");
});

test("stopping an idle run loop is idempotent before its database is closed", async (context) => {
  const db = new SqliteTestDatabase();
  let closed = false;
  context.after(() => {
    if (!closed) db.close();
  });
  const controller = new AbortController();
  const worker = new RelayWorker(db);
  const running = worker.run(controller.signal);
  await worker.tick();
  await worker.stop();
  await worker.stop();
  assert.equal(
    (await db
      .prepare("SELECT COUNT(*) AS count FROM worker_heartbeats")
      .first<{ count: number }>())!.count,
    0,
  );
  db.close();
  closed = true;
  // run() reaches its own finally after the caller has safely closed the DB.
  await running;
});

test("two standalone processes and an API pump cannot claim healthy events twice", async (context) => {
  const { db, start } = diskFixture(context);
  const service = new RelayService(db, "alice");
  await service.initialize();
  const endpoint = (await service.snapshot()).endpoints.find(
    (row) => row.mode === "healthy",
  )!;
  start();
  start();
  await eventually(
    async () => (await service.snapshot()).system.worker.activeWorkers === 2,
    "both standalone worker heartbeats",
  );
  for (let index = 0; index < 36; index++)
    await service.send(endpoint.id, "invoice.paid", { index });
  await service.pump();
  await eventually(
    async () => (await service.snapshot()).metrics.delivered === 36,
    "concurrent worker delivery",
  );
  const snapshot = await service.snapshot();
  assert.equal(snapshot.metrics.businessEffects, 36);
  for (const event of snapshot.deliveries) {
    const detail = await service.detail(event.id);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.delivery.attempts, 1);
  }
});

test(
  "terminating a claimed process recovers the actual expired lease on restart",
  { timeout: 30_000 },
  async (context) => {
    const { db, start } = diskFixture(context);
    const service = new RelayService(db, "alice");
    await service.initialize();
    const endpoint = (await service.snapshot()).endpoints.find(
      (row) => row.mode === "healthy",
    )!;
    await service.action({
      type: "set-receiver",
      endpointId: endpoint.id,
      mode: "timeout",
    });
    const event = await service.send(endpoint.id, "invoice.paid", {
      invoice: 99,
    });
    const interrupted = start();
    await eventually(
      async () => (await service.detail(event)).attempts.length === 1,
      "worker lease claim",
    );
    await killProcess(interrupted);
    const claimed = await service.detail(event);
    assert.equal(claimed.attempts[0].finishedAt, null);
    assert.equal(claimed.attempts[0].statusCode, null);
    const lease = await db
      .prepare("SELECT lease_until FROM deliveries WHERE owner = ? AND id = ?")
      .bind("alice", event)
      .first<{ lease_until: number }>();
    assert.ok(lease && lease.lease_until > Date.now());
    await service.action({
      type: "set-receiver",
      endpointId: endpoint.id,
      mode: "healthy",
    });
    start();
    // No timestamp edits: the replacement must wait for the real 15-second lease.
    await eventually(
      async () => (await service.detail(event)).delivery.status === "delivered",
      "delivery after the interrupted lease expires",
      LEASE_MS + 5_000,
    );
    const detail = await service.detail(event);
    assert.equal(detail.attempts.length, 2);
    assert.equal(detail.attempts[0].statusCode, null);
    assert.match(detail.attempts[0].error!, /lease expired/);
    assert.equal(detail.attempts[1].statusCode, 200);
    assert.ok(detail.attempts[1].createdAt >= lease!.lease_until);
    assert.equal((await service.snapshot()).metrics.businessEffects, 1);
  },
);

test("graceful stop finishes an active claim and expired final claims still become dead", async (context) => {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  const service = new RelayService(db, "alice");
  await service.initialize();
  const endpoint = (await service.snapshot()).endpoints.find(
    (row) => row.mode === "healthy",
  )!;
  await service.action({
    type: "set-receiver",
    endpointId: endpoint.id,
    mode: "timeout",
  });
  const event = await service.send(endpoint.id, "invoice.paid");
  const controller = new AbortController();
  const worker = new RelayWorker(db);
  const running = worker.run(controller.signal);
  await eventually(
    async () => (await service.detail(event)).attempts.length === 1,
    "active claim before graceful abort",
  );
  controller.abort();
  await running;
  const detail = await service.detail(event);
  assert.equal(detail.attempts[0].statusCode, 504);
  assert.notEqual(detail.attempts[0].finishedAt, null);
  assert.equal((await service.snapshot()).system.worker.activeWorkers, 0);

  await db.batch([
    db
      .prepare(
        "UPDATE deliveries SET attempts = ?, lease_token = 'last-crashed-claim', lease_until = ? WHERE owner = ? AND id = ?",
      )
      .bind(MAX_ATTEMPTS, Date.now() - 1, "alice", event),
    db
      .prepare(
        "INSERT INTO attempts (id, owner, event_id, number, created_at) VALUES ('last-crashed-claim', ?, ?, ?, ?)",
      )
      .bind("alice", event, MAX_ATTEMPTS, Date.now() - LEASE_MS),
  ]);
  const replacement = new RelayWorker(db);
  await replacement.tick();
  assert.equal((await service.detail(event)).delivery.status, "dead");
  assert.match(
    (await service.detail(event)).attempts.find(
      (attempt) => attempt.id === "last-crashed-claim",
    )!.error!,
    /lease expired/,
  );
  await replacement.stop();
});
