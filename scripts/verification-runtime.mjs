import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { protectFile } from "./protected-file.mjs";

const project = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const fixedKeys = [
  "RELAYFORGE_REFERENCE_KEYS_FILE",
  "RELAYFORGE_REFERENCE_DATABASE",
  "RELAYFORGE_REFERENCE_DB_PATH",
];
export class VerificationError extends Error {}

function inside(parent, target) {
  const difference = relative(parent, target);
  return (
    !!difference &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

async function availablePort(port = 0) {
  const probe = createServer();
  try {
    await new Promise((ready, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", ready);
    });
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error();
    return address.port;
  } catch {
    throw new VerificationError(
      port === 4100
        ? "Port 4100 is in use. Stop the local reference receiver before verification."
        : "A loopback verification port could not be selected.",
    );
  } finally {
    if (probe.listening)
      await new Promise((closed, reject) =>
        probe.close((error) => (error ? reject(error) : closed())),
      );
  }
}

/** One protected fixture and an explicit registry of the processes it owns. */
export async function createVerificationRuntime({
  prefix = "relayforge-http-",
} = {}) {
  if (!/^relayforge-[a-z-]{1,40}-$/.test(prefix))
    throw new VerificationError("Invalid verification fixture prefix.");
  const temporaryRoot = realpathSync(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, prefix));
  const owned = new Set();
  const failedStops = new Set();
  let closing = false,
    cleaned = false,
    phase = "preparation";
  const receiverFile = join(directory, "receiver.sqlite");
  const environment = Object.freeze({
    ...process.env,
    NODE_ENV: "production",
    DATABASE_PATH: join(directory, "verification.sqlite"),
    RELAYFORGE_HTTP_VERIFICATION: "true",
    RELAYFORGE_RECOVERY_VERIFICATION: "true",
    RELAYFORGE_MASTER_KEY_FILE: join(directory, "master.key"),
    RELAYFORGE_REFERENCE_ENABLED: "true",
    RELAYFORGE_ALLOWED_HOSTS: "hooks.example.com",
    RELAYFORGE_REFERENCE_KEYS_FILE: join(directory, "reference-keys.json"),
    RELAYFORGE_REFERENCE_DATABASE: receiverFile,
    RELAYFORGE_REFERENCE_DB_PATH: receiverFile,
  });

  function ownedPath(value) {
    if (typeof value !== "string" || !isAbsolute(value))
      throw new VerificationError(
        "Verification paths must be absolute and inside the owned fixture.",
      );
    let ancestor = resolve(value);
    const missing = [];
    while (!existsSync(ancestor)) {
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor)
        throw new VerificationError(
          "The verification path could not be resolved.",
        );
      ancestor = parent;
    }
    const actual = join(realpathSync(ancestor), ...missing);
    if (!inside(directory, actual))
      throw new VerificationError(
        "Verification paths must remain inside the owned fixture.",
      );
    return actual;
  }

  function childEnvironment(overrides) {
    for (const key of fixedKeys)
      if (overrides[key] !== undefined && overrides[key] !== environment[key])
        throw new VerificationError(
          "Reference verification paths cannot be overridden.",
        );
    const result = { ...environment, ...overrides };
    result.DATABASE_PATH = ownedPath(result.DATABASE_PATH);
    result.RELAYFORGE_MASTER_KEY_FILE = ownedPath(
      result.RELAYFORGE_MASTER_KEY_FILE,
    );
    result.NODE_ENV = "production";
    result.RELAYFORGE_HTTP_VERIFICATION = "true";
    result.RELAYFORGE_RECOVERY_VERIFICATION = "true";
    result.RELAYFORGE_REFERENCE_ENABLED = "true";
    result.RELAYFORGE_ALLOWED_HOSTS = "hooks.example.com";
    return result;
  }

  function hasExited(runtime) {
    return (
      runtime.closed ||
      runtime.child.pid === undefined ||
      runtime.child.exitCode !== null ||
      runtime.child.signalCode !== null
    );
  }

  function launch(name, args, { environment: overrides = {} } = {}) {
    if (closing || cleaned)
      throw new VerificationError("The verification runtime is closing.");
    const env = childEnvironment(overrides);
    const child = spawn(process.execPath, args, {
      cwd: project,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      closed = false;
    /** @type {Error | undefined} */
    let processError;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-16_384);
      });
    /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null, error?: Error}>} */
    const done = new Promise((resolveDone) => {
      child.once("error", (error) => {
        processError = error;
      });
      child.once("close", (code, signal) => {
        closed = true;
        resolveDone({
          code,
          signal,
          ...(processError ? { error: processError } : {}),
        });
      });
    });
    const runtime = {
      name,
      child,
      done,
      get output() {
        return output;
      },
      get closed() {
        return closed;
      },
    };
    owned.add(runtime);
    return runtime;
  }

  async function settled(runtime, timeoutMs) {
    const timer = new AbortController();
    try {
      return await Promise.race([
        runtime.done.then(() => true),
        wait(timeoutMs, false, { signal: timer.signal }).catch(() => false),
      ]);
    } finally {
      timer.abort();
    }
  }

  async function stop(runtime) {
    if (!owned.has(runtime))
      throw new VerificationError(
        "Refusing to stop a process not owned by this verification.",
      );
    if (failedStops.has(runtime))
      throw new VerificationError(
        "An owned process had an incomplete shutdown; its fixture was preserved.",
      );
    if (runtime.closed) return;
    if (!hasExited(runtime)) runtime.child.kill("SIGTERM");
    if (await settled(runtime, 5_000)) return;
    if (!hasExited(runtime)) {
      runtime.child.kill("SIGKILL");
      if (await settled(runtime, 5_000)) return;
    }
    // An exited parent can leave pipes open in a descendant. Never wait forever
    // or delete fixtures merely because closing our pipe handles emits close.
    failedStops.add(runtime);
    runtime.child.stdout?.destroy();
    runtime.child.stderr?.destroy();
    throw new VerificationError(
      "An owned verification process did not fully close; its fixture was preserved.",
    );
  }

  function assertRunning(...runtimes) {
    if (closing || cleaned)
      throw new VerificationError("Verification was interrupted.");
    for (const runtime of runtimes)
      if (!owned.has(runtime) || hasExited(runtime))
        throw new VerificationError(
          "An expected verification process is not running.",
        );
  }

  async function waitFor(
    description,
    condition,
    { timeoutMs = 20_000, runtimes = [] } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertRunning(...runtimes);
      const result = await condition();
      if (result) return result;
      await wait(200);
    }
    throw new VerificationError(`Verification timed out: ${description}.`);
  }

  async function run(
    name,
    args,
    { environment: overrides = {}, timeoutMs = 90_000 } = {},
  ) {
    const runtime = launch(name, args, { environment: overrides });
    if (!(await settled(runtime, timeoutMs))) {
      await stop(runtime);
      throw new VerificationError(
        `${name} exceeded its verification deadline.`,
      );
    }
    const result = await runtime.done;
    if (result.error || result.code !== 0) {
      await stop(runtime);
      throw new VerificationError(`${name} did not pass.`);
    }
    return result;
  }

  async function startWeb(overrides = {}) {
    if (!existsSync(join(project, ".next", "BUILD_ID")))
      throw new VerificationError(
        "Build the application with npm run build before verification.",
      );
    const port = await availablePort(),
      url = `http://127.0.0.1:${port}`;
    const runtime = launch(
      "web",
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { environment: overrides },
    );
    await waitFor(
      "compiled web startup",
      async () => {
        if (!runtime.output.includes("Ready in")) return false;
        try {
          const response = await fetch(new URL("/api/security", url), {
            signal: AbortSignal.timeout(1500),
          });
          await response.body?.cancel();
          return (
            response.status === 401 && response.headers.has("x-request-id")
          );
        } catch {
          return false;
        }
      },
      { timeoutMs: 45_000, runtimes: [runtime] },
    );
    return { runtime, url };
  }

  function startWorker(overrides = {}) {
    return launch(
      "worker",
      ["--experimental-strip-types", "scripts/worker.mjs"],
      { environment: overrides },
    );
  }

  async function startReference() {
    await availablePort(4100);
    const runtime = launch("reference", [
      "--experimental-strip-types",
      "scripts/reference-receiver.mjs",
      "--keys-file",
      environment.RELAYFORGE_REFERENCE_KEYS_FILE,
      "--database",
      receiverFile,
    ]);
    await waitFor(
      "owned reference receiver startup",
      () =>
        runtime.output.includes(
          "Reference receiver listening at http://127.0.0.1:4100/webhooks",
        ),
      { timeoutMs: 10_000, runtimes: [runtime] },
    );
    return runtime;
  }

  const interrupt = () => {
    closing = true;
    for (const runtime of owned)
      if (!hasExited(runtime)) runtime.child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  async function cleanup() {
    if (cleaned) return;
    closing = true;
    const results = await Promise.allSettled([...owned].map(stop));
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (results.some((result) => result.status === "rejected"))
      throw new VerificationError(
        "An owned process could not be stopped; verification files were preserved.",
      );
    const target = resolve(directory);
    if (
      dirname(target) !== temporaryRoot ||
      !basename(target).startsWith(prefix)
    )
      throw new VerificationError(
        "Refusing to remove an unexpected verification directory.",
      );
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    cleaned = true;
  }

  try {
    if (inside(project, directory))
      throw new VerificationError(
        "Verification fixtures must stay outside the checkout.",
      );
    protectFile(directory);
    await writeFile(environment.RELAYFORGE_MASTER_KEY_FILE, randomBytes(32), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      environment.RELAYFORGE_REFERENCE_KEYS_FILE,
      JSON.stringify({ mode: "healthy", connections: [] }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    directory,
    environment,
    launch,
    stop,
    run,
    cleanup,
    assertRunning,
    waitFor,
    startWeb,
    startWorker,
    startReference,
    stage(label) {
      phase = label;
      console.log(`Verification: ${label}`);
    },
    get phase() {
      return phase;
    },
  };
}
