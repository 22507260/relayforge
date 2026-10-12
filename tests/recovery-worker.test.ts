import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { RelayService } from "../lib/server/service.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

async function eventually(
  condition: () => Promise<boolean>,
  description: string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test(
  "a standalone child worker completes the recovery guide through real retry delays without browser pumps",
  { timeout: 30_000 },
  async (context) => {
    const directory = mkdtempSync(
      join(tmpdir(), "relayforge-recovery-worker-"),
    );
    const filename = join(directory, "queue.sqlite");
    const db = new SqliteTestDatabase(filename);
    const service = new RelayService(db, "alice");
    await service.initialize();
    await service.action({ type: "pause", paused: true });
    const initial = await service.action({ type: "start-recovery-demo" });
    const event = initial.recoveryDemo!.eventId;
    const worker = spawn(
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
    worker.stdout?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4_000);
    });
    worker.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4_000);
    });
    const exited = new Promise<void>((resolve, reject) => {
      worker.once("exit", () => resolve());
      worker.once("error", reject);
    });
    context.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await exited;
      db.close();
      rmSync(directory, { recursive: true });
    });
    await eventually(
      async () => (await service.snapshot()).system.worker.activeWorkers >= 1,
      "worker heartbeat",
    );
    assert.equal((await service.detail(event)).attempts.length, 0);
    // Raw pause updates deliberately avoid action()/pump(): only the child processes this run.
    db.connection
      .prepare("UPDATE workspaces SET queue_paused = 0 WHERE owner = 'alice'")
      .run();
    await eventually(
      async () =>
        (await service.snapshot()).recoveryDemo?.stage === "awaiting-repair",
      "four autonomous failed claims",
    );
    const failed = await service.detail(event);
    assert.deepEqual(
      failed.attempts.map((attempt) => attempt.statusCode),
      [500, 500, 500, 500],
    );
    assert.deepEqual(
      failed.attempts.map((attempt) => attempt.cycle),
      [1, 1, 1, 1],
    );
    assert.equal(failed.delivery.status, "dead");
    assert.equal((await service.snapshot()).recoveryDemo?.businessEffects, 0);
    db.connection
      .prepare("UPDATE workspaces SET queue_paused = 1 WHERE owner = 'alice'")
      .run();
    await service.action({
      type: "repair-recovery-demo",
      eventId: event,
      expectedCycle: 1,
    });
    const queued = await service.action({
      type: "replay-recovery-demo",
      eventId: event,
      expectedCycle: 1,
    });
    assert.equal(queued.recoveryDemo?.stage, "recovering");
    assert.equal((await service.detail(event)).attempts.length, 4);
    db.connection
      .prepare("UPDATE workspaces SET queue_paused = 0 WHERE owner = 'alice'")
      .run();
    await eventually(
      async () =>
        (await service.snapshot()).recoveryDemo?.stage === "completed",
      "autonomous replay acknowledgement",
    );
    const complete = (await service.snapshot()).recoveryDemo!;
    assert.equal(complete.eventId, event);
    assert.equal(complete.delivery.currentCycle, 2);
    assert.equal(complete.businessEffects, 1);
    const recovered = await service.detail(event);
    assert.equal(recovered.attempts.length, 5);
    assert.equal(recovered.attempts[4].statusCode, 200);
    assert.equal(recovered.attempts[4].cycle, 2);
    assert.deepEqual(recovered.attempts.slice(0, 4), failed.attempts);
    assert.match(output, /worker started/);
  },
);
