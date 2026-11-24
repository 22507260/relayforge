import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { createVerificationRuntime } from "../scripts/verification-runtime.mjs";

const environmentNames = [
  "DATABASE_PATH",
  "RELAYFORGE_MASTER_KEY_FILE",
  "RELAYFORGE_REFERENCE_KEYS_FILE",
  "RELAYFORGE_REFERENCE_DATABASE",
  "RELAYFORGE_REFERENCE_DB_PATH",
] as const;
const probe = [
  "--input-type=module",
  "-e",
  `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(environmentNames)}.map(name => [name, process.env[name]]))));`,
];

function controlDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-runtime-control-"));
  const sentinel = join(directory, "sentinel.txt");
  writeFileSync(sentinel, "This synthetic control file must remain unchanged.");
  return {
    directory,
    sentinel,
    cleanup() {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("relayforge-runtime-control-"));
      rmSync(target, { recursive: true, force: true });
    },
  };
}

function assertInside(directory: string, filename: string) {
  assert.equal(typeof filename, "string");
  const difference = relative(resolve(directory), resolve(filename));
  assert.ok(
    difference &&
      difference !== ".." &&
      !difference.startsWith("..\\") &&
      !difference.startsWith("../") &&
      !isAbsolute(difference),
  );
}

async function eventually(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`Owned verification child did not reach ${label}.`);
}

test("verification children pin every storage alias despite ambient deployment configuration", async () => {
  const control = controlDirectory();
  const previous = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  let fixture:
    Awaited<ReturnType<typeof createVerificationRuntime>> | undefined;
  try {
    for (const name of environmentNames) process.env[name] = control.sentinel;
    fixture = await createVerificationRuntime({
      prefix: "relayforge-runtime-test-",
    });
    const child = fixture.launch("environment-probe", probe);
    const result = await child.done;
    assert.ok(result);
    assert.equal(result.code, 0);
    assert.equal(child.child.exitCode, 0);
    const environment = JSON.parse(child.output);
    for (const name of environmentNames) {
      assertInside(fixture.directory, environment[name]);
      assert.equal(environment[name], fixture.environment[name]);
      assert.notEqual(environment[name], control.sentinel);
    }
    assert.equal(
      environment.RELAYFORGE_REFERENCE_DB_PATH,
      environment.RELAYFORGE_REFERENCE_DATABASE,
    );
    assert.equal(
      readFileSync(control.sentinel, "utf8"),
      "This synthetic control file must remain unchanged.",
    );
  } finally {
    for (const name of environmentNames) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      await fixture?.cleanup();
    } finally {
      control.cleanup();
    }
  }
});

test("verification launch rejects foreign storage paths, fixed receiver overrides, and symlink escapes", async () => {
  const control = controlDirectory();
  const fixture = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    for (const name of environmentNames)
      assert.throws(() =>
        fixture.launch("foreign-path", probe, {
          environment: { [name]: control.sentinel },
        }),
      );
    const escape = join(fixture.directory, "escape");
    symlinkSync(
      control.directory,
      escape,
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const name of ["DATABASE_PATH", "RELAYFORGE_MASTER_KEY_FILE"])
      assert.throws(() =>
        fixture.launch("symlink-escape", probe, {
          environment: { [name]: join(escape, "database.sqlite") },
        }),
      );
    assert.equal(
      readFileSync(control.sentinel, "utf8"),
      "This synthetic control file must remain unchanged.",
    );
  } finally {
    await fixture.cleanup();
    control.cleanup();
  }
});

test("restore phases may select new owned database and key paths without redirecting receiver storage", async () => {
  const fixture = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    const database = join(fixture.directory, "restored.sqlite");
    const key = join(fixture.directory, "missing-master.key");
    const child = fixture.launch("restore-environment", probe, {
      environment: { DATABASE_PATH: database, RELAYFORGE_MASTER_KEY_FILE: key },
    });
    const result = await child.done;
    assert.ok(result);
    assert.equal(result.code, 0);
    assert.equal(child.child.exitCode, 0);
    const environment = JSON.parse(child.output);
    assert.equal(environment.DATABASE_PATH, database);
    assert.equal(environment.RELAYFORGE_MASTER_KEY_FILE, key);
    for (const name of environmentNames.slice(2))
      assert.equal(environment[name], fixture.environment[name]);
    assert.equal(existsSync(database), false);
    assert.equal(existsSync(key), false);
  } finally {
    await fixture.cleanup();
  }
});

test("process stop refuses another fixture's runtime and awaits the owned child's actual exit", async () => {
  const first = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  const second = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    const child = second.launch("long-running", [
      "-e",
      "console.log('ready'); setInterval(() => {}, 1000)",
    ]);
    await eventually(() => child.output.includes("ready"), "startup");
    await assert.rejects(async () => first.stop(child));
    assert.equal(child.child.exitCode, null);
    assert.equal(child.child.signalCode, null);
    await second.stop(child);
    await child.done;
    assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
    assert.throws(() => second.assertRunning(child));
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("cleanup stops active owned children, removes only its fixture, and is idempotent", async () => {
  const control = controlDirectory();
  const fixture = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    const child = fixture.launch("cleanup-child", [
      "-e",
      "console.log('ready'); setInterval(() => {}, 1000)",
    ]);
    await eventually(() => child.output.includes("ready"), "startup");
    writeFileSync(
      join(fixture.directory, "owned-data.txt"),
      "Synthetic fixture data.",
    );
    await fixture.cleanup();
    await child.done;
    assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
    assert.equal(existsSync(fixture.directory), false);
    assert.equal(
      readFileSync(control.sentinel, "utf8"),
      "This synthetic control file must remain unchanged.",
    );
    await fixture.cleanup();
  } finally {
    await fixture.cleanup();
    control.cleanup();
  }
});

test("failed and timed-out checks redact child output and leave no live owned process", async () => {
  const fixture = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    await assert.rejects(
      fixture.run("failed-check", [
        "-e",
        "console.log('synthetic-private-marker'); process.exit(7)",
      ]),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("synthetic-private-marker"),
    );
    const pidFile = join(fixture.directory, "timeout.pid");
    const script =
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); console.log('synthetic-private-marker'); setInterval(() => {}, 1000)";
    const started = Date.now();
    await assert.rejects(
      fixture.run("timed-out-check", ["-e", script, pidFile], {
        timeoutMs: 1500,
      }),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("synthetic-private-marker"),
    );
    assert.ok(
      Date.now() - started < 10_000,
      "Timeout cleanup must remain bounded.",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "ESRCH",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("captured child output remains bounded while retaining the latest startup evidence", async () => {
  const fixture = await createVerificationRuntime({
    prefix: "relayforge-runtime-test-",
  });
  try {
    const child = fixture.launch("bounded-output", [
      "-e",
      "process.stdout.write('x'.repeat(100000) + 'owned-child-finished')",
    ]);
    const result = await child.done;
    assert.ok(result);
    assert.equal(result.code, 0);
    assert.ok(child.output.length <= 16_384);
    assert.ok(child.output.endsWith("owned-child-finished"));
  } finally {
    await fixture.cleanup();
  }
});
