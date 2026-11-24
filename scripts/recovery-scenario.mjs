import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { protectFile } from "./protected-file.mjs";

const same = (actual, expected, message) =>
  assert.ok(JSON.stringify(actual) === JSON.stringify(expected), message);

async function digest(filename) {
  return createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
}

async function databaseFingerprint(filename) {
  const files = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      files[suffix] = await digest(`${filename}${suffix}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      files[suffix] = null;
    }
  }
  return files;
}

/** Exercise real processes while keeping credentials inside the private fixture. */
export async function runRecoveryScenario(fixture) {
  const directory = resolve(fixture.directory);
  const environment = fixture.environment;
  const fixturePath = (filename) => {
    assert.ok(isAbsolute(filename), "Recovery fixture paths must be absolute.");
    const actual = resolve(filename);
    const difference = relative(directory, actual);
    assert.ok(
      difference &&
        difference !== ".." &&
        !difference.startsWith(`..${sep}`) &&
        !isAbsolute(difference),
      "Recovery fixture files must stay inside the private directory.",
    );
    return actual;
  };
  const sourceFile = fixturePath(environment.DATABASE_PATH);
  const originalKey = fixturePath(environment.RELAYFORGE_MASTER_KEY_FILE);
  const receiverFile = fixturePath(environment.RELAYFORGE_REFERENCE_DATABASE);
  const receiverKeys = fixturePath(environment.RELAYFORGE_REFERENCE_KEYS_FILE);
  assert.ok(
    !environment.RELAYFORGE_REFERENCE_DB_PATH ||
      resolve(environment.RELAYFORGE_REFERENCE_DB_PATH) === receiverFile,
    "Receiver database aliases must select the same isolated fixture.",
  );
  const backupFile = join(directory, "recovery-point.sqlite");
  const restoredFile = join(directory, "restored.sqlite");
  const missingKey = join(directory, "missing-master.key");
  const wrongKey = join(directory, "wrong-master.key");
  const originalKeyDigest = await digest(originalKey);
  const wrongBytes = randomBytes(32);
  assert.ok(
    createHash("sha256").update(wrongBytes).digest("hex") !== originalKeyDigest,
    "The wrong-key fixture must differ from the original master key.",
  );
  await writeFile(wrongKey, wrongBytes, { mode: 0o600, flag: "wx" });
  protectFile(wrongKey);

  const secrets = new Set();
  let cookie = "";
  const remember = (value) => {
    assert.ok(
      typeof value === "string" && value.length > 0,
      "A fixture credential was not returned.",
    );
    secrets.add(value);
    secrets.add(createHash("sha256").update(value).digest("hex"));
  };
  async function api(web, path, options = {}) {
    const {
      body,
      method = body === undefined ? "GET" : "POST",
      expected = 200,
      token,
      idempotencyKey,
      session = cookie,
    } = options;
    const base = new URL(web.url);
    assert.ok(
      base.protocol === "http:" && base.hostname === "127.0.0.1",
      "Recovery requests must use the owned loopback web server.",
    );
    fixture.assertRunning(web.runtime);
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        "content-type": "application/json",
        origin: base.origin,
        cookie: session,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(
      allowed.includes(response.status),
      "Unexpected HTTP status during recovery verification.",
    );
    assert.ok(
      /^[a-f0-9-]{36}$/.test(response.headers.get("x-request-id") ?? ""),
      "Recovery API responses must retain server-generated request IDs.",
    );
    const value = await response.json();
    const serialized = JSON.stringify(value);
    for (const secret of secrets)
      assert.ok(
        !serialized.includes(secret),
        "A public recovery response exposed fixture credentials.",
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
    return {
      value,
      status: response.status,
      cookie: response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; "),
    };
  }
  const detail = async (web, eventId) =>
    (await api(web, `/api/deliveries/${eventId}`)).value;
  const operations = async (web) =>
    (await api(web, "/api/operations?scope=live")).value;
  const pause = async (web, paused) => {
    const response = await api(web, "/api/action", {
      body: { type: "pause", paused },
    });
    assert.ok(
      response.value.system.queuePaused === paused,
      "The workspace pause state did not persist.",
    );
  };
  const delivered = (web, worker, eventId) =>
    fixture.waitFor(
      "a signed reference delivery acknowledgement",
      async () => {
        const value = await detail(web, eventId);
        return value.delivery.status === "delivered" && value;
      },
      { timeoutMs: 25_000, runtimes: [web.runtime, worker] },
    );
  const health = async (web, expected) => {
    const response = await api(web, "/api/health/ready", {
      expected: [200, 503],
      session: "",
    });
    same(
      response.value,
      { status: response.status === 200 ? "ready" : "not_ready" },
      "Readiness must retain its minimal public response.",
    );
    return response.status === expected;
  };
  function receiverProof(connectionId, eventId) {
    const database = new DatabaseSync(receiverFile, {
      readOnly: true,
      timeout: 5000,
    });
    try {
      return {
        effects: database
          .prepare(
            "SELECT payload_hash,event_type,created_at FROM effects WHERE endpoint_id=? AND event_id=?",
          )
          .all(connectionId, eventId),
        receipts: database
          .prepare(
            "SELECT attempt,cycle,acknowledged,status_code FROM receipts WHERE endpoint_id=? AND event_id=? ORDER BY id",
          )
          .all(connectionId, eventId),
      };
    } finally {
      database.close();
    }
  }

  fixture.stage(
    "Preparing signed delivery history and a queued recovery point",
  );
  const sourceWeb = await fixture.startWeb();
  const password = randomBytes(24).toString("base64url");
  remember(password);
  const registered = await api(sourceWeb, "/api/auth/register", {
    session: "",
    body: { email: `recovery-${randomUUID()}@example.test`, password },
    expected: 201,
  });
  cookie = registered.cookie;
  for (const part of cookie.split("; ")) {
    const token = part.slice(part.indexOf("=") + 1);
    if (token) remember(token);
  }
  assert.ok(
    cookie.length > 0,
    "Registration must establish the isolated fixture session.",
  );
  await api(sourceWeb, "/api/action", { body: { type: "initialize" } });
  await pause(sourceWeb, true);
  const created = (
    await api(sourceWeb, "/api/connections", {
      body: { name: "Recovery reference", transport: "reference" },
      expected: 201,
    })
  ).value;
  remember(created.signingSecret);
  const connectionId = created.connection.id;
  const nextConfiguration = `${receiverKeys}.next`;
  await writeFile(
    nextConfiguration,
    JSON.stringify({
      mode: "lose-first-ack",
      connections: [
        {
          endpointId: connectionId,
          keys: [{ keyId: created.keyId, secret: created.signingSecret }],
        },
      ],
    }),
    { mode: 0o600, flag: "wx" },
  );
  protectFile(nextConfiguration);
  await rename(nextConfiguration, receiverKeys);
  const producer = (
    await api(sourceWeb, "/api/producer-keys", {
      body: { name: "Recovery producer", endpointId: connectionId },
      expected: 201,
    })
  ).value;
  remember(producer.token);
  const event = (label) => ({
    eventType: "invoice.paid",
    payload: { invoice: label, amount: 120, currency: "EUR" },
  });
  const produce = async (web, idempotencyKey, body, expected = 202) =>
    (
      await api(web, "/api/v1/events", {
        body,
        session: "",
        token: producer.token,
        idempotencyKey,
        expected,
      })
    ).value;
  const historyEvent = event("history");
  const historical = await produce(sourceWeb, "history", historyEvent);
  const sourceWorker = await fixture.startWorker();
  await pause(sourceWeb, false);
  const firstHistory = await delivered(
    sourceWeb,
    sourceWorker,
    historical.eventId,
  );
  same(
    firstHistory.attempts.map((attempt) => attempt.failureCode),
    ["network_error", null],
    "The history event must record its real lost acknowledgement and retry.",
  );
  await pause(sourceWeb, true);
  await api(sourceWeb, "/api/action", {
    body: { type: "replay", eventId: historical.eventId, expectedCycle: 1 },
  });
  const replayQueued = await detail(sourceWeb, historical.eventId);
  assert.ok(
    replayQueued.delivery.currentCycle === 2 &&
      replayQueued.delivery.attempts === 0,
    "A paused replay must open a new cycle without consuming an attempt.",
  );
  same(
    replayQueued.attempts,
    firstHistory.attempts,
    "Replay must retain the first delivery cycle.",
  );
  await pause(sourceWeb, false);
  const savedHistory = await delivered(
    sourceWeb,
    sourceWorker,
    historical.eventId,
  );
  same(
    savedHistory.attempts.map((attempt) => attempt.cycle),
    [1, 1, 2],
    "History must include both persisted delivery cycles.",
  );
  const historicalEffect = receiverProof(connectionId, historical.eventId);
  assert.ok(
    historicalEffect.effects.length === 1 &&
      historicalEffect.receipts.length === 3,
    "The historical retry and replay must retain one independent receiver effect.",
  );
  await pause(sourceWeb, true);
  const queuedEvent = event("snapshot-pending");
  const queued = await produce(sourceWeb, "snapshot-pending", queuedEvent);
  const savedPending = await detail(sourceWeb, queued.eventId);
  assert.ok(
    savedPending.delivery.status === "pending" &&
      savedPending.delivery.attempts === 0 &&
      savedPending.attempts.length === 0,
    "The recovery point must contain an unattempted live event.",
  );
  assert.ok(
    receiverProof(connectionId, queued.eventId).effects.length === 0,
    "The queued event must not have a receiver effect before its recovery point.",
  );
  await fixture.run("recovery-point-backup", [
    "scripts/database-maintenance.mjs",
    "backup",
    "--database",
    sourceFile,
    "--output",
    backupFile,
  ]);
  await fixture.run("recovery-point-check", [
    "scripts/database-maintenance.mjs",
    "check",
    "--database",
    backupFile,
  ]);
  const savedBackupFingerprint = await databaseFingerprint(backupFile);

  fixture.stage(
    "Advancing the source while preserving the independent receiver",
  );
  await pause(sourceWeb, false);
  const sourceAcknowledged = await delivered(
    sourceWeb,
    sourceWorker,
    queued.eventId,
  );
  same(
    sourceAcknowledged.attempts.map((attempt) => attempt.statusCode),
    [null, 200],
    "The original queue must deliver through the real reference receiver.",
  );
  const originalEffect = receiverProof(connectionId, queued.eventId);
  assert.ok(
    originalEffect.effects.length === 1 && originalEffect.receipts.length === 2,
    "The source delivery must create one receiver effect across two requests.",
  );
  await pause(sourceWeb, true);
  const later = await produce(
    sourceWeb,
    "accepted-after-snapshot",
    event("accepted-after-snapshot"),
  );
  const laterDetail = await detail(sourceWeb, later.eventId);
  assert.ok(
    laterDetail.delivery.status === "pending",
    "The source must retain an event accepted after the recovery point.",
  );
  await fixture.stop(sourceWorker);
  await fixture.stop(sourceWeb.runtime);
  const stoppedSourceFingerprint = await databaseFingerprint(sourceFile);

  fixture.stage(
    "Restoring to a separate database and observing the stopped worker",
  );
  await fixture.run("restored-database-backup", [
    "scripts/database-maintenance.mjs",
    "backup",
    "--database",
    backupFile,
    "--output",
    restoredFile,
  ]);
  await fixture.run("restored-database-check", [
    "scripts/database-maintenance.mjs",
    "check",
    "--database",
    restoredFile,
  ]);
  const missingEnvironment = {
    DATABASE_PATH: restoredFile,
    RELAYFORGE_MASTER_KEY_FILE: missingKey,
  };
  const missingWeb = await fixture.startWeb(missingEnvironment);
  same(
    (await api(missingWeb, "/api/health/live", { session: "" })).value,
    { status: "alive" },
    "The restored web process must remain live without a worker.",
  );
  await fixture.waitFor(
    "stopped-worker readiness after the saved heartbeat expires",
    () => health(missingWeb, 503),
    { timeoutMs: 20_000, runtimes: [missingWeb.runtime] },
  );
  same(
    (await detail(missingWeb, historical.eventId)).attempts,
    savedHistory.attempts,
    "Restoring must preserve the earlier attempt IDs and cycles.",
  );
  same(
    await detail(missingWeb, queued.eventId),
    savedPending,
    "Restoring must recover the saved pending delivery without invented attempts.",
  );
  await api(missingWeb, `/api/deliveries/${later.eventId}`, { expected: 404 });
  same(
    await produce(missingWeb, "snapshot-pending", queuedEvent),
    { eventId: queued.eventId, duplicate: true },
    "Restored producer authority and idempotency must return the saved event.",
  );
  await produce(
    missingWeb,
    "snapshot-pending",
    { ...queuedEvent, payload: { amount: 121 } },
    409,
  );
  await pause(missingWeb, false);

  async function blockedByKey(web, worker, label) {
    const configuration = (await api(web, "/api/connections")).value
      .configuration;
    assert.ok(
      configuration.referenceEnabled && !configuration.signingAvailable,
      "An unusable master key must disable signing while reference policy remains enabled.",
    );
    const firstHeartbeat = await fixture.waitFor(
      `${label} worker heartbeat`,
      async () => {
        const report = await operations(web);
        return report.worker.online && report.worker.lastHeartbeatAt;
      },
      { timeoutMs: 15_000, runtimes: [web.runtime, worker] },
    );
    await fixture.waitFor(
      `${label} worker progress without a delivery claim`,
      async () => {
        const current = await detail(web, queued.eventId);
        same(
          current.attempts,
          [],
          "An unusable signing key must not consume an attempt.",
        );
        assert.ok(
          current.delivery.status === "pending" &&
            current.delivery.attempts === 0,
          "A missing or wrong key must leave the restored event pending.",
        );
        same(
          receiverProof(connectionId, queued.eventId),
          originalEffect,
          "A blocked signing configuration must not contact or alter the receiver.",
        );
        const report = await operations(web);
        assert.ok(
          !report.workspace.paused,
          "Bad-key verification requires an unpaused eligible queue.",
        );
        return (
          report.worker.online && report.worker.lastHeartbeatAt > firstHeartbeat
        );
      },
      { timeoutMs: 15_000, runtimes: [web.runtime, worker] },
    );
    assert.ok(
      await health(web, 200),
      "A fresh worker can satisfy readiness even when connection signing is unavailable.",
    );
  }

  fixture.stage(
    "Checking a missing master key with an active standalone worker",
  );
  const missingWorker = await fixture.startWorker(missingEnvironment);
  await blockedByKey(missingWeb, missingWorker, "missing-key");
  await fixture.stop(missingWorker);
  await fixture.stop(missingWeb.runtime);

  fixture.stage(
    "Checking a different protected master key without consuming attempts",
  );
  const wrongEnvironment = {
    DATABASE_PATH: restoredFile,
    RELAYFORGE_MASTER_KEY_FILE: wrongKey,
  };
  const wrongWeb = await fixture.startWeb(wrongEnvironment);
  const wrongWorker = await fixture.startWorker(wrongEnvironment);
  await blockedByKey(wrongWeb, wrongWorker, "wrong-key");
  await fixture.stop(wrongWorker);
  await fixture.stop(wrongWeb.runtime);

  fixture.stage(
    "Recovering with the original key and the retained receiver effect",
  );
  const recoveredEnvironment = {
    DATABASE_PATH: restoredFile,
    RELAYFORGE_MASTER_KEY_FILE: originalKey,
  };
  const recoveredWeb = await fixture.startWeb(recoveredEnvironment);
  assert.ok(
    (await api(recoveredWeb, "/api/connections")).value.configuration
      .signingAvailable,
    "The original protected master key must decrypt the restored signing data.",
  );
  const recoveredWorker = await fixture.startWorker(recoveredEnvironment);
  const recovered = await delivered(
    recoveredWeb,
    recoveredWorker,
    queued.eventId,
  );
  assert.ok(
    recovered.delivery.id === queued.eventId &&
      recovered.delivery.currentCycle === 1 &&
      recovered.delivery.payload === savedPending.delivery.payload,
    "A restored delivery must retain its event identity, cycle, and payload.",
  );
  assert.ok(
    recovered.attempts.length === 1 &&
      recovered.attempts[0].statusCode === 200 &&
      recovered.attempts[0].failureCode === null,
    "The retained receiver effect must acknowledge the first restored request.",
  );
  same(
    recovered.attempts[0].signingKeyIds,
    [created.keyId],
    "Restored delivery must use the original connection signing key.",
  );
  same(
    (await detail(recoveredWeb, historical.eventId)).attempts,
    savedHistory.attempts,
    "Recovering the pending event must preserve earlier history cycles.",
  );
  await api(recoveredWeb, `/api/deliveries/${later.eventId}`, {
    expected: 404,
  });
  same(
    await produce(recoveredWeb, "snapshot-pending", queuedEvent),
    { eventId: queued.eventId, duplicate: true },
    "Producer deduplication must remain stable after the restored acknowledgement.",
  );
  const recoveredEffect = receiverProof(connectionId, queued.eventId);
  same(
    receiverProof(connectionId, historical.eventId),
    historicalEffect,
    "Restoring must not redeliver an event already acknowledged in the snapshot.",
  );
  same(
    recoveredEffect.effects,
    originalEffect.effects,
    "The receiver's committed effect must remain unchanged across application restore.",
  );
  assert.ok(
    recoveredEffect.receipts.length === originalEffect.receipts.length + 1,
    "Restore must add one actual receiver request without another effect.",
  );
  same(
    recoveredEffect.receipts.at(-1),
    { attempt: 1, cycle: 1, acknowledged: 1, status_code: 200 },
    "The restored request must be independently recorded by the receiver.",
  );
  const snapshot = (await api(recoveredWeb, "/api/snapshot")).value;
  assert.ok(
    snapshot.scopes.live.metrics.total === 2 &&
      snapshot.scopes.live.metrics.delivered === 2 &&
      snapshot.scopes.live.metrics.businessEffects === 0,
    "Application observations must retain two restored events without claiming external business effects.",
  );
  assert.ok(
    await health(recoveredWeb, 200),
    "The recovered web process and worker must satisfy readiness.",
  );
  same(
    await databaseFingerprint(sourceFile),
    stoppedSourceFingerprint,
    "The stopped original database and sidecars must remain unchanged.",
  );
  same(
    await databaseFingerprint(backupFile),
    savedBackupFingerprint,
    "The recovery-point backup and sidecars must remain unchanged.",
  );
  assert.ok(
    (await digest(originalKey)) === originalKeyDigest,
    "The original protected master-key file must remain unchanged.",
  );
  fixture.assertRunning(recoveredWeb.runtime, recoveredWorker);

  return {
    status: "passed",
    historyAttemptsPreserved: savedHistory.attempts.length,
    historyCyclesPreserved: 2,
    restoredEventAttempts: recovered.attempts.length,
    recoveredEventReceiverEffects: recoveredEffect.effects.length,
    receiverRequestsBeforeRestore: originalEffect.receipts.length,
    receiverRequestsAfterRestore: recoveredEffect.receipts.length,
    missingKeyBlocked: true,
    wrongKeyBlocked: true,
    stoppedWorkerNotReady: true,
    liveWebWithoutWorker: true,
    producerIdempotencyPreserved: true,
    postSnapshotEventAbsent: true,
    sourceAndBackupPreserved: true,
  };
}
