import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "relayforge-http-"));
const environment = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_PATH: join(directory, "verification.sqlite"),
  RELAYFORGE_HTTP_VERIFICATION: "true",
  RELAYFORGE_MASTER_KEY_FILE: join(directory, "master.key"),
  RELAYFORGE_REFERENCE_ENABLED: "true",
  RELAYFORGE_ALLOWED_HOSTS: "hooks.example.com",
  RELAYFORGE_REFERENCE_KEYS_FILE: join(directory, "reference-keys.json"),
  RELAYFORGE_REFERENCE_DATABASE: join(directory, "receiver.sqlite"),
};
const processes = [];
let stopping = false;

function launch(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: project,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const done = new Promise((resolveDone) => {
    child.once("error", (error) => resolveDone({ error }));
    child.once("close", (code, signal) => resolveDone({ code, signal }));
  });
  const runtime = { name, child, done };
  processes.push(runtime);
  return runtime;
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveReady, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveReady);
  });
  const address = probe.address();
  await new Promise((resolveClosed, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClosed())),
  );
  if (!address || typeof address === "string")
    throw new Error("Could not select a loopback verification port.");
  return address.port;
}

async function assertReferencePortFree() {
  const probe = createServer();
  try {
    await new Promise((resolveReady, reject) => {
      probe.once("error", reject);
      probe.listen(4100, "127.0.0.1", resolveReady);
    });
  } catch {
    throw new Error(
      "Port 4100 is in use. Stop the local reference receiver before isolated HTTP verification.",
    );
  }
  await new Promise((resolveClosed, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClosed())),
  );
}

function hasExited(runtime) {
  return (
    runtime.child.pid === undefined ||
    runtime.child.exitCode !== null ||
    runtime.child.signalCode !== null
  );
}

async function ready(web, url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !stopping) {
    if (hasExited(web))
      throw new Error("Verification web server exited early.");
    try {
      const response = await fetch(new URL("/api/security", url), {
        signal: AbortSignal.timeout(1500),
      });
      await response.body?.cancel();
      if (response.status === 401 && response.headers.has("x-request-id"))
        return;
    } catch {
      // Startup can briefly refuse connections before the loopback listener opens.
    }
    await wait(250);
  }
  throw new Error(
    "Verification server did not become ready within 45 seconds.",
  );
}

async function stop(runtime) {
  if (hasExited(runtime)) return;
  runtime.child.kill("SIGTERM");
  const timeout = new AbortController();
  const settled = await Promise.race([
    runtime.done.then(() => true),
    wait(5000, false, { signal: timeout.signal }).catch(() => true),
  ]);
  timeout.abort();
  if (settled || hasExited(runtime)) return;
  runtime.child.kill("SIGKILL");
  await runtime.done;
}

const interrupt = () => {
  stopping = true;
  for (const runtime of processes)
    if (!hasExited(runtime)) runtime.child.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  await assertReferencePortFree();
  await writeFile(environment.RELAYFORGE_MASTER_KEY_FILE, randomBytes(32), {
    mode: 0o600,
  });
  await writeFile(
    environment.RELAYFORGE_REFERENCE_KEYS_FILE,
    JSON.stringify({ mode: "healthy", connections: [] }),
    { mode: 0o600 },
  );
  const reference = launch("reference", [
    "--experimental-strip-types",
    "scripts/reference-receiver.mjs",
  ]);
  const receiverDeadline = Date.now() + 10_000;
  let receiverReady = false;
  while (Date.now() < receiverDeadline && !hasExited(reference)) {
    try {
      const response = await fetch("http://127.0.0.1:4100/webhooks", {
        signal: AbortSignal.timeout(500),
      });
      await response.body?.cancel();
      if (response.status === 404) {
        receiverReady = true;
        break;
      }
    } catch {
      /* The independent listener can take a moment to start. */
    }
    await wait(100);
  }
  if (!receiverReady || hasExited(reference))
    throw new Error(
      "The isolated reference receiver could not start on port 4100.",
    );
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const web = launch("web", [
    "node_modules/next/dist/bin/next",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  await ready(web, url);
  const worker = launch("worker", [
    "--experimental-strip-types",
    "scripts/worker.mjs",
  ]);
  for (const script of [
    "smoke",
    "security-smoke",
    "request-smoke",
    "integration-smoke",
    "insights-smoke",
    "operations-smoke",
    "health-check",
  ]) {
    if (stopping || hasExited(web) || hasExited(worker) || hasExited(reference))
      throw new Error("A verification runtime stopped before checks finished.");
    const check = launch(script, [`scripts/${script}.mjs`, url]);
    const timeout = new AbortController();
    let result;
    try {
      result = await Promise.race([
        check.done,
        wait(90_000, { timedOut: true }, { signal: timeout.signal }).catch(
          () => ({ cancelled: true }),
        ),
      ]);
    } finally {
      timeout.abort();
    }
    if (result.timedOut)
      throw new Error(`${script} exceeded its 90-second limit.`);
    if (result.error || result.code !== 0)
      throw new Error(`${script} did not pass.`);
  }
  if (stopping || hasExited(web) || hasExited(worker) || hasExited(reference))
    throw new Error("A verification runtime exited unexpectedly.");
  console.log(
    "All compiled HTTP checks passed using an isolated temporary database.",
  );
} finally {
  stopping = true;
  await Promise.all(processes.map(stop));
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  const target = resolve(directory);
  if (
    dirname(target) !== temporaryRoot ||
    !basename(target).startsWith("relayforge-http-")
  )
    throw new Error("Refusing to remove an unexpected verification directory.");
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
