import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SqliteDatabase } from "../lib/server/database.ts";
import { IntegrationService } from "../lib/server/integrations.ts";
import { RelayService } from "../lib/server/service.ts";
import {
  LiveTransport,
  type LiveDeliveryRequest,
  type TransportResult,
} from "../lib/server/transport.ts";
import {
  backupDatabase,
  checkDatabase,
} from "../scripts/database-maintenance.mjs";

function fixture(context: TestContext, migrationsDirectory?: string) {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-backup-test-"));
  const filename = join(directory, "source.sqlite");
  const db = new SqliteDatabase(filename, migrationsDirectory);
  context.after(() => {
    db.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("relayforge-backup-test-"));
    rmSync(target, { recursive: true, force: true });
  });
  return { directory, filename, db };
}

class ControlledTransport extends LiveTransport {
  requests: LiveDeliveryRequest[] = [];
  code = 400;
  constructor() {
    super({ policy: { allowedHosts: [], referenceEnabled: true } });
  }
  async send(request: LiveDeliveryRequest): Promise<TransportResult> {
    this.requests.push(request);
    return {
      statusCode: this.code,
      durationMs: 12,
      retryAfterMs: null,
      failureCode: this.code === 200 ? null : "http_rejected",
      error: this.code === 200 ? null : "Controlled rejection",
    };
  }
}

test("online backup includes committed WAL data, retains history, and leaves the source unchanged", async (context) => {
  const f = fixture(context);
  f.db.connection.exec(`
    PRAGMA wal_autocheckpoint = 0;
    INSERT INTO users VALUES ('owner', 'synthetic@example.test', 'unused', 1);
    INSERT INTO workspaces VALUES ('owner', 'synthetic-private-marker', 1, 0, 1);
    INSERT INTO endpoints(id,owner,name,description,color,mode) VALUES ('endpoint','owner','Receiver','','blue','healthy');
    INSERT INTO deliveries(id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,attempts,current_cycle,created_at,updated_at)
      VALUES ('event','owner','endpoint','invoice.paid','{"amount":12}','hash','stable-key','dead',1,2,1,2);
    INSERT INTO attempts(id,owner,event_id,number,cycle,status_code,duration_ms,created_at,finished_at)
      VALUES ('attempt','owner','event',1,1,400,12,1,2);
    INSERT INTO activity(id,owner,kind,event_id,message,created_at,cycle)
      VALUES ('activity','owner','dead','event','Retained history',2,1);
  `);
  assert.ok(statSync(`${f.filename}-wal`).size > 0);
  const original = readFileSync(f.filename);
  const expected = new Map(
    ["workspaces", "deliveries", "attempts", "activity"].map((table) => [
      table,
      f.db.connection.prepare(`SELECT * FROM ${table}`).all(),
    ]),
  );
  const output = join(f.directory, "completed.sqlite");
  const report = await backupDatabase(f.filename, output);
  assert.deepEqual(report.migrations, { applied: 6, pending: 0 });
  assert.equal(report.integrity, "ok");
  assert.equal(report.foreignKeys, "ok");
  assert.equal(report.bytes, statSync(output).size);
  assert.equal(
    report.sha256,
    createHash("sha256").update(readFileSync(output)).digest("hex"),
  );
  assert.deepEqual(readFileSync(f.filename), original);
  const restored = new DatabaseSync(output, { readOnly: true });
  try {
    for (const [table, rows] of expected)
      assert.deepEqual(restored.prepare(`SELECT * FROM ${table}`).all(), rows);
  } finally {
    restored.close();
  }
  assert.deepEqual(
    readdirSync(f.directory).filter((name) =>
      name.startsWith(".relayforge-backup-"),
    ),
    [],
  );
  if (process.platform !== "win32")
    assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("a restored queue preserves replay and idempotency and requires its original master key", async (context) => {
  const f = fixture(context);
  const keyFile = join(f.directory, "master.key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const previousKey = process.env.RELAYFORGE_MASTER_KEY_FILE;
  process.env.RELAYFORGE_MASTER_KEY_FILE = keyFile;
  context.after(() => {
    if (previousKey === undefined)
      delete process.env.RELAYFORGE_MASTER_KEY_FILE;
    else process.env.RELAYFORGE_MASTER_KEY_FILE = previousKey;
  });
  f.db.connection.exec(
    "INSERT INTO users VALUES ('owner', 'synthetic@example.test', 'unused', 1)",
  );
  const service = new RelayService(f.db, "owner");
  await service.initialize();
  const management = new IntegrationService(f.db, "owner", {
    keyFile,
    referenceEnabled: true,
  });
  const created = await management.createConnection({
    name: "Recovery fixture",
    transport: "reference",
  });
  const eventId = await service.send(
    created.connection.id,
    "invoice.paid",
    { amount: 12 },
    "stable-key",
  );
  const transport = new ControlledTransport();
  assert.equal(await service.pump({ allowLive: true, transport }), 1);
  assert.equal((await service.detail(eventId)).delivery.status, "dead");
  await service.replayBatch({ items: [{ eventId, expectedCycle: 1 }] });
  const history = await service.detail(eventId);
  const output = join(f.directory, "restored.sqlite");
  await backupDatabase(f.filename, output);
  const restored = new SqliteDatabase(output);
  try {
    const recovery = new RelayService(restored, "owner");
    assert.deepEqual(await recovery.detail(eventId), history);
    assert.equal(
      await recovery.send(
        created.connection.id,
        "invoice.paid",
        { amount: 12 },
        "stable-key",
      ),
      eventId,
    );
    await assert.rejects(
      recovery.send(
        created.connection.id,
        "invoice.paid",
        { amount: 13 },
        "stable-key",
      ),
      { status: 409 },
    );
    const originalKey = readFileSync(keyFile);
    delete process.env.RELAYFORGE_MASTER_KEY_FILE;
    assert.equal(await recovery.pump({ allowLive: true, transport }), 0);
    process.env.RELAYFORGE_MASTER_KEY_FILE = keyFile;
    writeFileSync(keyFile, randomBytes(32));
    assert.equal(await recovery.pump({ allowLive: true, transport }), 0);
    assert.equal((await recovery.detail(eventId)).delivery.attempts, 0);
    assert.equal(transport.requests.length, 1);
    writeFileSync(keyFile, originalKey);
    transport.code = 200;
    assert.equal(await recovery.pump({ allowLive: true, transport }), 1);
    const detail = await recovery.detail(eventId);
    assert.equal(detail.delivery.status, "delivered");
    assert.equal(detail.delivery.currentCycle, 2);
    assert.deepEqual(
      detail.attempts.map((attempt) => attempt.cycle),
      [1, 2],
    );
    assert.equal(JSON.parse(transport.requests[1].body).eventId, eventId);
    assert.deepEqual(
      (await service.detail(eventId)).delivery,
      history.delivery,
    );
  } finally {
    restored.close();
  }
});

test("backup and check accept an older migration prefix without applying pending migrations", async (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "relayforge-backup-migrations-"),
  );
  const legacy = join(directory, "legacy");
  mkdirSync(legacy);
  const name = readdirSync("drizzle")
    .filter((file) => file.endsWith(".sql"))
    .sort()[0];
  writeFileSync(join(legacy, name), readFileSync(join("drizzle", name)));
  context.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("relayforge-backup-migrations-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture(context, legacy);
  assert.deepEqual(checkDatabase(f.filename).migrations, {
    applied: 1,
    pending: 5,
  });
  const report = await backupDatabase(
    f.filename,
    join(f.directory, "legacy-copy.sqlite"),
  );
  assert.deepEqual(report.migrations, { applied: 1, pending: 5 });
  assert.equal(
    f.db.connection
      .prepare("SELECT COUNT(*) AS n FROM relayforge_migrations")
      .get()!.n,
    1,
  );
  assert.equal(
    f.db.connection
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'users'")
      .get(),
    undefined,
  );
});

test("maintenance rejects missing, corrupt, and unrelated databases without creating output", async (context) => {
  const f = fixture(context);
  const missing = join(f.directory, "missing.sqlite");
  assert.throws(() => checkDatabase(missing), /existing regular database/);
  assert.equal(existsSync(missing), false);
  const corrupt = join(f.directory, "corrupt.sqlite");
  writeFileSync(corrupt, "synthetic-private-marker is not a database");
  const unrelated = join(f.directory, "unrelated.sqlite");
  const other = new DatabaseSync(unrelated);
  other.exec("CREATE TABLE unrelated(id INTEGER)");
  other.close();
  for (const filename of [missing, corrupt, unrelated]) {
    const output = join(f.directory, "must-not-exist.sqlite");
    await assert.rejects(backupDatabase(filename, output));
    assert.equal(existsSync(output), false);
  }
  assert.deepEqual(
    readdirSync(f.directory).filter((name) =>
      name.startsWith(".relayforge-backup-"),
    ),
    [],
  );
});

test("checks reject invalid foreign keys and incompatible migration ledgers", async (context) => {
  const f = fixture(context);
  f.db.connection.exec(
    "PRAGMA foreign_keys = OFF; INSERT INTO endpoints(id,owner,name,description,color,mode) VALUES ('bad','private-owner-marker','Bad','','red','healthy')",
  );
  assert.throws(() => checkDatabase(f.filename), /foreign-key validation/);
  f.db.connection.exec(
    "DELETE FROM endpoints WHERE id = 'bad'; PRAGMA foreign_keys = ON",
  );
  const migration = f.db.connection
    .prepare(
      "SELECT name,checksum FROM relayforge_migrations ORDER BY name LIMIT 1",
    )
    .get()!;
  f.db.connection
    .prepare(
      "UPDATE relayforge_migrations SET checksum = 'altered' WHERE name = ?",
    )
    .run(migration.name!);
  assert.throws(() => checkDatabase(f.filename), /checksum does not match/);
  f.db.connection
    .prepare("UPDATE relayforge_migrations SET checksum = ? WHERE name = ?")
    .run(migration.checksum!, migration.name!);
  f.db.connection.exec(
    "DELETE FROM relayforge_migrations WHERE name LIKE '0002_%'",
  );
  assert.throws(
    () => checkDatabase(f.filename),
    /migration history is incompatible/,
  );
});

test("backup refuses existing files, aliases, source sidecars, and destination sidecars", async (context) => {
  const f = fixture(context);
  const existing = join(f.directory, "existing.sqlite");
  writeFileSync(existing, "retain this file");
  const orphan = join(f.directory, "orphan.sqlite");
  writeFileSync(`${orphan}-wal`, "retain this sidecar");
  for (const output of [
    f.filename,
    `${f.filename}-wal`,
    `${f.filename}-shm`,
    `${f.filename}-journal`,
    existing,
    orphan,
    join(f.directory, "missing", "copy.sqlite"),
  ])
    await assert.rejects(backupDatabase(f.filename, output));
  assert.equal(readFileSync(existing, "utf8"), "retain this file");
  assert.equal(readFileSync(`${orphan}-wal`, "utf8"), "retain this sidecar");
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(
    readdirSync(f.directory).filter((name) =>
      name.startsWith(".relayforge-backup-"),
    ),
    [],
  );
});

test("hard-linked source names are rejected because they can select different WAL sidecars", async (context) => {
  const f = fixture(context);
  const alias = join(f.directory, "source-alias.sqlite");
  linkSync(f.filename, alias);
  const output = join(f.directory, "must-not-exist.sqlite");
  for (const source of [f.filename, alias]) {
    assert.throws(() => checkDatabase(source), /Hard-linked source/);
    await assert.rejects(backupDatabase(source, output), /Hard-linked source/);
  }
  assert.equal(existsSync(output), false);
});

test("a destination created during backup is never overwritten and unpublished staging is removed", async (context) => {
  const f = fixture(context);
  const output = join(f.directory, "racing.sqlite");
  const pending = backupDatabase(f.filename, output);
  writeFileSync(output, "a competing writer owns this file", { flag: "wx" });
  await assert.rejects(pending, /already exists/);
  assert.equal(
    readFileSync(output, "utf8"),
    "a competing writer owns this file",
  );
  assert.deepEqual(
    readdirSync(f.directory).filter((name) =>
      name.startsWith(".relayforge-backup-"),
    ),
    [],
  );
});

test("CLI emits bounded metadata, respects an explicit database, and fails without leaking stored content", (context) => {
  const f = fixture(context);
  f.db.connection.exec(
    "INSERT INTO workspaces VALUES ('owner', 'synthetic-private-marker', 0, 0, 1)",
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/database-maintenance.mjs", ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        DATABASE_PATH: join(f.directory, "unused.sqlite"),
      },
    });
  const checked = run("check", "--database", f.filename);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).operation, "check");
  const output = join(f.directory, "cli-copy.sqlite");
  const copied = run("backup", "--database", f.filename, "--output", output);
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(JSON.parse(copied.stdout).sha256.length, 64);
  assert.ok(!copied.stdout.includes("synthetic-private-marker"));
  assert.ok(!copied.stdout.includes("owner"));
  assert.equal(existsSync(join(f.directory, "unused.sqlite")), false);
  for (const args of [
    ["backup"],
    ["check", "--output", output],
    ["check", "--unknown"],
    ["check", "--database", ""],
  ]) {
    const failed = run(...args);
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.ok(!failed.stderr.includes("synthetic-private-marker"));
    assert.ok(!failed.stderr.includes(" at "));
  }
});
