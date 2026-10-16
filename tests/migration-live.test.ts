import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SqliteDatabase } from "../lib/server/database.ts";
import { RelayService } from "../lib/server/service.ts";

test("live integrations migration preserves existing endpoint, delivery and legacy attempt records with safe defaults", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-migration-live-"));
  const oldMigrations = join(directory, "before-live");
  mkdirSync(oldMigrations);
  for (const name of readdirSync("drizzle").filter((name) =>
    /^000[0-4]_.*\.sql$/.test(name),
  ))
    writeFileSync(
      join(oldMigrations, name),
      readFileSync(join("drizzle", name)),
    );
  const filename = join(directory, "upgrade.sqlite");
  let db: SqliteDatabase | null = new SqliteDatabase(filename, oldMigrations);
  context.after(() => {
    db?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("relayforge-migration-live-"));
    rmSync(directory, { recursive: true, force: true });
  });
  db.connection.exec(`
    INSERT INTO users(id,email,password_hash,created_at) VALUES('legacy-owner','legacy@example.test','unused',1);
    INSERT INTO workspaces(owner,signing_secret,queue_paused,duplicates_prevented,created_at) VALUES('legacy-owner','legacy-demo-secret',1,7,1);
    INSERT INTO endpoints(id,owner,name,description,color,mode,purpose) VALUES('legacy-endpoint','legacy-owner','Preserved receiver','Original description','orange','failing','standard');
    INSERT INTO deliveries(id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,attempts,current_cycle,created_at,updated_at,next_attempt_at)
      VALUES('legacy-event','legacy-owner','legacy-endpoint','invoice.paid','{"amount":120}','original-hash','original-key','dead',4,1,1,2,NULL);
    INSERT INTO attempts(id,owner,event_id,number,cycle,status_code,error,duration_ms,created_at,finished_at)
      VALUES('legacy-attempt','legacy-owner','legacy-event',4,NULL,NULL,'Worker lease expired before acknowledgment',0,1,2);
    INSERT INTO activity(id,owner,kind,event_id,message,created_at,cycle) VALUES('legacy-audit','legacy-owner','dead','legacy-event','Original history',2,NULL);
    INSERT INTO receiver_effects(id,owner,event_id,created_at) VALUES('legacy-effect','legacy-owner','legacy-event',1);
  `);
  const originalDelivery = db.connection
    .prepare("SELECT * FROM deliveries WHERE id='legacy-event'")
    .get();
  const originalWorkspace = db.connection
    .prepare("SELECT * FROM workspaces WHERE owner='legacy-owner'")
    .get();
  db.close();
  db = new SqliteDatabase(filename);
  assert.deepEqual(
    db.connection
      .prepare("SELECT * FROM deliveries WHERE id='legacy-event'")
      .get(),
    originalDelivery,
  );
  assert.deepEqual(
    db.connection
      .prepare("SELECT * FROM workspaces WHERE owner='legacy-owner'")
      .get(),
    originalWorkspace,
  );
  const endpoint = db.connection
    .prepare("SELECT * FROM endpoints WHERE id='legacy-endpoint'")
    .get()!;
  assert.equal(endpoint.transport, "demo");
  assert.equal(endpoint.enabled, 1);
  assert.equal(endpoint.revision, 1);
  assert.equal(endpoint.mode, "failing");
  assert.equal(endpoint.destination_url, null);
  assert.equal(endpoint.signing_key_id, null);
  const attempt = db.connection
    .prepare("SELECT * FROM attempts WHERE id='legacy-attempt'")
    .get()!;
  assert.equal(attempt.cycle, null);
  assert.equal(attempt.failure_code, null);
  assert.equal(attempt.signing_key_ids, null);
  assert.equal(attempt.connection_revision, null);
  assert.equal(attempt.error, "Worker lease expired before acknowledgment");
  assert.equal(attempt.finished_at, 2);
  assert.equal(
    db.connection.prepare("SELECT COUNT(*) AS count FROM activity").get()!
      .count,
    1,
  );
  assert.equal(
    db.connection
      .prepare("SELECT COUNT(*) AS count FROM receiver_effects")
      .get()!.count,
    1,
  );
  assert.equal(
    db.connection.prepare("PRAGMA integrity_check").get()!.integrity_check,
    "ok",
  );
  assert.deepEqual(db.connection.prepare("PRAGMA foreign_key_check").all(), []);
  const history = await new RelayService(db, "legacy-owner").detail(
    "legacy-event",
  );
  assert.equal(history.delivery.transport, "demo");
  assert.equal(history.attempts[0].cycle, null);
  assert.equal(history.attempts[0].failureCode, null);
  assert.deepEqual(history.attempts[0].signingKeyIds, []);
  assert.equal(history.attempts[0].connectionRevision, null);
});
