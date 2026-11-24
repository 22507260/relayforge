import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import {
  createVerificationRuntime,
  VerificationError,
} from "../scripts/verification-runtime.mjs";

async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`The shutdown fixture did not reach ${label}.`);
}

test(
  "an exited child with descendant-held pipes has bounded shutdown and preserves its fixture",
  { timeout: 20_000 },
  async () => {
    const fixture = await createVerificationRuntime({
      prefix: "relayforge-shutdown-test-",
    });
    let descendant: number | undefined;
    let stopping: Promise<unknown> | undefined;
    try {
      // The descendant never accesses fixture files. Its own deadline is a fallback
      // if the test process is interrupted before the explicit finally cleanup.
      const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, [
        '-e', 'setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)'
      ], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      console.log(child.pid);
      child.unref();
      process.exit(0);
    `;
      const parent = fixture.launch("exited-parent-with-open-pipes", [
        "-e",
        script,
      ]);
      await eventually(
        () => parent.child.exitCode !== null && /^\d+\s*$/.test(parent.output),
        "parent exit with an owned descendant identifier",
      );
      descendant = Number(parent.output.trim());
      assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
      assert.equal(parent.child.exitCode, 0);
      assert.equal(parent.closed, false);
      assert.doesNotThrow(() => process.kill(descendant!, 0));

      const started = Date.now();
      stopping = fixture.stop(parent).then(
        () => undefined,
        (error: unknown) => error,
      );
      const overDeadline = Symbol("shutdown exceeded its bound");
      const timer = new AbortController();
      let outcome: unknown;
      try {
        outcome = await Promise.race([
          stopping,
          wait(8000, overDeadline, { signal: timer.signal }),
        ]);
      } finally {
        timer.abort();
      }
      assert.notEqual(
        outcome,
        overDeadline,
        "Shutdown must not await inherited pipes indefinitely.",
      );
      assert.ok(outcome instanceof VerificationError);
      assert.ok(Date.now() - started < 8000);
      assert.equal(parent.child.stdout?.destroyed, true);
      assert.equal(parent.child.stderr?.destroyed, true);
      await eventually(() => parent.closed, "captured pipe closure");
      assert.doesNotThrow(() => process.kill(descendant!, 0));

      await assert.rejects(() => fixture.cleanup(), VerificationError);
      assert.equal(existsSync(fixture.directory), true);
      // A later close event must not erase the earlier shutdown failure and permit
      // deletion while the known descendant is still alive.
      await assert.rejects(() => fixture.cleanup(), VerificationError);
      assert.equal(existsSync(fixture.directory), true);
    } finally {
      if (descendant !== undefined) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
          )
            throw error;
        }
        await eventually(() => {
          try {
            process.kill(descendant!, 0);
            return false;
          } catch (error) {
            return (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            );
          }
        }, "descendant exit");
      }
      await stopping;
      try {
        await fixture.cleanup();
      } catch (error) {
        if (!(error instanceof VerificationError)) throw error;
      }
      const target = resolve(fixture.directory);
      assert.equal(dirname(target), realpathSync(tmpdir()));
      assert.ok(basename(target).startsWith("relayforge-shutdown-test-"));
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  },
);
