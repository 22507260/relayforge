import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKER_HEARTBEAT_TTL_MS } from "../lib/server/domain.ts";
import { livenessResponse, readinessResponse } from "../lib/server/health.ts";
import { route } from "../lib/server/http.ts";
import type { SqlDatabase } from "../lib/server/sql.ts";
import { SqliteTestDatabase } from "./sqlite.ts";

const NOW = 1_800_000_000_000;

test("public liveness is independent of storage and returns only fixed status", async () => {
  const response = await route(async () => livenessResponse());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "alive" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("x-request-id")!, /^[0-9a-f-]{36}$/);
});

test("public readiness requires a database and a worker strictly within heartbeat TTL", async (context) => {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  const ready = () =>
    readinessResponse(
      () => db,
      () => NOW,
    );
  let response = await ready();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "not_ready" });
  db.connection
    .prepare(
      "INSERT INTO worker_heartbeats(id,started_at,last_seen_at) VALUES('worker',?,?)",
    )
    .run(NOW - 50_000, NOW - WORKER_HEARTBEAT_TTL_MS);
  assert.equal((await ready()).status, 503);
  db.connection
    .prepare("UPDATE worker_heartbeats SET last_seen_at=?")
    .run(NOW + 1);
  assert.equal((await ready()).status, 503);
  db.connection
    .prepare("UPDATE worker_heartbeats SET last_seen_at=?")
    .run(NOW - WORKER_HEARTBEAT_TTL_MS + 1);
  response = await route(ready);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.has("x-request-id"));
});

test("readiness failures are minimal and do not disclose database or exception information", async () => {
  const factoryError = await readinessResponse(() => {
    throw new Error("private-database-path-and-key");
  });
  assert.equal(factoryError.status, 503);
  assert.deepEqual(await factoryError.json(), { status: "not_ready" });
  const failingDb = {
    prepare: () => {
      throw new Error("private-table-and-query");
    },
  } as unknown as SqlDatabase;
  const queryError = await readinessResponse(async () => failingDb);
  assert.equal(queryError.status, 503);
  assert.deepEqual(await queryError.json(), { status: "not_ready" });
});

test("readiness is read-only and independent of workspace pause and signing configuration", async (context) => {
  const db = new SqliteTestDatabase();
  context.after(() => db.close());
  db.connection
    .exec(`INSERT INTO workspaces(owner,signing_secret,queue_paused,created_at) VALUES('private-owner','private-secret',1,1);
    INSERT INTO worker_heartbeats(id,started_at,last_seen_at) VALUES('private-worker',1,${NOW});`);
  const before = db.connection
    .prepare("SELECT total_changes() AS changes")
    .get();
  const response = await readinessResponse(
    () => db,
    () => NOW,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.deepEqual(
    db.connection.prepare("SELECT total_changes() AS changes").get(),
    before,
  );
});
