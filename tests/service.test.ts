import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiError,
  canonicalJson,
  LEASE_MS,
  signPayload,
} from "../lib/server/domain.ts";
import { RelayService } from "../lib/server/service.ts";
import { SqliteTestDatabase } from "./sqlite.ts";
import type { DeliveryQuery } from "../lib/contracts.ts";

const deliveryQuery = (values: Partial<DeliveryQuery> = {}): DeliveryQuery => ({
  page: 1,
  pageSize: 20,
  search: "",
  status: "all",
  endpointId: "all",
  ...values,
});

test("pagination searches the full durable history in stable order beyond the snapshot limit", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const ids: string[] = [];
  const healthy = endpoints.find((row) => row.mode === "healthy")!;
  for (let index = 0; index < 125; index++) {
    ids.push(
      await service.send(
        index === 0 ? healthy.id : endpoints[0].id,
        index === 0 ? "older.unique" : "invoice.paid",
        { index },
      ),
    );
    if (index === 0) await service.pump();
  }
  const snapshot = await service.snapshot();
  assert.equal(snapshot.deliveries.length, 100);
  assert.equal(snapshot.metrics.total, 125);
  assert.equal(snapshot.system.eventLimit, 500);
  assert.equal(snapshot.system.snapshotLimit, 100);
  assert.equal(
    snapshot.deliveries.some((row) => row.id === ids[0]),
    false,
  );
  assert.equal(
    snapshot.endpoints.find((row) => row.id === healthy.id)?.lastDurationMs,
    (await service.detail(ids[0])).delivery.latestAttempt?.durationMs,
  );
  assert.notEqual(
    snapshot.endpoints.find((row) => row.id === healthy.id)?.lastDurationMs,
    null,
  );
  const all: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await service.listDeliveries(
      deliveryQuery({ page, pageSize: 25 }),
    );
    assert.equal(result.total, 125);
    assert.equal(result.totalPages, 5);
    assert.equal(result.page, page);
    all.push(...result.deliveries.map((row) => row.id));
  }
  assert.deepEqual(all, ids.toReversed());
  assert.equal(new Set(all).size, 125);
  const older = await service.listDeliveries(
    deliveryQuery({ search: "OLDER.UNIQUE" }),
  );
  assert.equal(older.total, 1);
  assert.equal(older.deliveries[0].id, ids[0]);
});

test("delivery filters combine status and endpoint without exposing another owner's records or interpreting SQL search text", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const healthy = endpoints.find((row) => row.mode === "healthy")!;
  const failing = endpoints.find((row) => row.mode === "failing")!;
  await service.send(healthy.id, "invoice.paid");
  await service.send(healthy.id, "invoice.paid");
  const expected = await service.send(failing.id, "literal_underscore");
  await service.pump();
  assert.equal((await service.snapshot()).metrics.successRate, 66.7);
  const bob = new RelayService(db, "bob");
  await bob.initialize();
  await bob.send((await bob.snapshot()).endpoints[0].id, "literal_underscore");
  const result = await service.listDeliveries(
    deliveryQuery({
      status: "retrying",
      endpointId: failing.id,
      search: "notifications",
    }),
  );
  assert.equal(result.total, 1);
  assert.equal(result.deliveries[0].id, expected);
  assert.equal(
    (await service.listDeliveries(deliveryQuery({ search: "_" }))).total,
    1,
  );
  assert.equal(
    (await service.listDeliveries(deliveryQuery({ search: "%" }))).total,
    0,
  );
  assert.equal(
    (await service.listDeliveries(deliveryQuery({ search: "' OR 1=1 --" })))
      .total,
    0,
  );
  assert.equal(
    (await bob.listDeliveries(deliveryQuery({ endpointId: failing.id }))).total,
    0,
  );
  const empty = await service.listDeliveries(deliveryQuery({ status: "dead" }));
  assert.equal(empty.total, 0);
  assert.equal(empty.totalPages, 1);
});

test("latest attempt follows replay insertion order at equal timestamps and identifies unfinished claims", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const healthy = endpoints.find((row) => row.mode === "healthy")!;
  const event = await service.send(healthy.id, "invoice.paid");
  assert.equal((await service.detail(event)).delivery.latestAttempt, null);
  await service.pump();
  assert.equal(
    (await service.detail(event)).delivery.latestAttempt?.statusCode,
    200,
  );
  await service.action({
    type: "set-receiver",
    endpointId: healthy.id,
    mode: "failing",
  });
  await service.action({ type: "replay", eventId: event });
  const detail = await service.detail(event);
  assert.deepEqual(
    detail.attempts.map((row) => row.statusCode),
    [200, 500],
  );
  assert.equal(detail.delivery.latestAttempt?.statusCode, 500);
  assert.equal(
    detail.delivery.latestAttempt?.finishedAt,
    detail.delivery.latestAttempt?.createdAt,
  );
  assert.equal(
    (await service.listDeliveries(deliveryQuery())).deliveries[0].latestAttempt
      ?.statusCode,
    500,
  );
  const now = (await service.snapshot()).system.now;
  await db
    .prepare(
      "INSERT INTO attempts (id, owner, event_id, number, created_at) VALUES ('unfinished', 'alice', ?, 2, ?)",
    )
    .bind(event, now)
    .run();
  const unfinished = await service.detail(event);
  assert.equal(unfinished.delivery.latestAttempt?.finishedAt, null);
  assert.equal(unfinished.delivery.latestAttempt?.durationMs, null);
  assert.equal(unfinished.attempts.at(-1)?.finishedAt, null);
  await db
    .prepare("UPDATE attempts SET duration_ms = 27 WHERE id = ?")
    .bind(detail.attempts.at(-1)!.id)
    .run();
  await db
    .prepare(
      "UPDATE attempts SET finished_at = ?, error = 'Interrupted claim' WHERE id = 'unfinished'",
    )
    .bind(now)
    .run();
  assert.equal(
    (await service.detail(event)).delivery.latestAttempt?.durationMs,
    null,
  );
  assert.equal(
    (await service.snapshot()).endpoints.find((row) => row.id === healthy.id)
      ?.lastDurationMs,
    27,
  );
});

async function fixture() {
  const db = new SqliteTestDatabase();
  let now = 1_800_000_000_000;
  const service = new RelayService(
    db,
    "alice",
    () => now,
    () => 0.5,
  );
  await service.initialize();
  const endpoints = (await service.snapshot()).endpoints;
  return {
    db,
    service,
    endpoints,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

test("durable acceptance deduplicates equal payloads and rejects changed payload or event type", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  const original = await service.send(
    endpoint.id,
    "invoice.paid",
    { amount: 42, currency: "USD" },
    "invoice-42",
  );
  assert.equal(
    await service.send(
      endpoint.id,
      "invoice.paid",
      { currency: "USD", amount: 42 },
      "invoice-42",
    ),
    original,
  );
  await assert.rejects(
    service.send(endpoint.id, "invoice.paid", { amount: 43 }, "invoice-42"),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await assert.rejects(
    service.send(
      endpoint.id,
      "invoice.refunded",
      { amount: 42, currency: "USD" },
      "invoice-42",
    ),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  const snapshot = await service.snapshot();
  assert.equal(snapshot.metrics.total, 1);
  assert.equal(snapshot.metrics.duplicatesPrevented, 1);
  assert.equal(snapshot.metrics.businessEffects, 0);
  assert.equal(JSON.stringify(snapshot).includes("signing_secret"), false);
});

test("tenant checks block cross-workspace reads, sends and endpoint changes", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const bob = new RelayService(db, "bob");
  await bob.initialize();
  const event = await service.send(endpoints[0].id, "user.created");
  await assert.rejects(
    bob.detail(event),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await assert.rejects(
    bob.send(endpoints[0].id, "user.created"),
    (error: unknown) => error instanceof ApiError && error.status === 404,
  );
  await assert.rejects(
    bob.action({
      type: "set-receiver",
      endpointId: endpoints[0].id,
      mode: "healthy",
    }),
    ApiError,
  );
  assert.equal((await bob.snapshot()).metrics.total, 0);
  assert.notEqual((await bob.snapshot()).endpoints[0].id, endpoints[0].id);
});

test("overlapping pumps on independent SQLite connections claim each event once", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-test-"));
  const first = new SqliteTestDatabase(join(directory, "queue.sqlite"));
  const second = new SqliteTestDatabase(join(directory, "queue.sqlite"));
  context.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true });
  });
  const a = new RelayService(first, "alice");
  const b = new RelayService(second, "alice");
  await a.initialize();
  const endpoint = (await a.snapshot()).endpoints.find(
    (row) => row.mode === "healthy",
  )!;
  for (let index = 0; index < 20; index++)
    await a.send(endpoint.id, "invoice.paid", { index });
  await Promise.all([a.pump(), b.pump()]);
  await a.pump();
  const snapshot = await b.snapshot();
  assert.equal(snapshot.metrics.delivered, 20);
  assert.equal(snapshot.metrics.businessEffects, 20);
  for (const event of snapshot.deliveries)
    assert.equal((await b.detail(event.id)).attempts.length, 1);
});

test("failure exhausts budget; repair and replay preserve history and receiver effects stay idempotent", async (context) => {
  const { db, service, endpoints, advance } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "failing")!;
  const event = await service.send(endpoint.id, "order.completed", {
    orderId: 42,
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await service.pump();
    const detail = await service.detail(event);
    assert.equal(detail.delivery.attempts, attempt);
    if (detail.delivery.nextAttemptAt) advance(10_000);
  }
  assert.equal((await service.detail(event)).delivery.status, "dead");
  await service.pump();
  assert.equal((await service.detail(event)).attempts.length, 4);
  await service.action({
    type: "set-receiver",
    endpointId: endpoint.id,
    mode: "healthy",
  });
  await service.action({ type: "replay", eventId: event });
  assert.equal((await service.detail(event)).delivery.status, "delivered");
  assert.equal((await service.detail(event)).attempts.length, 5);
  await service.action({ type: "replay", eventId: event });
  assert.equal((await service.detail(event)).attempts.length, 6);
  assert.equal((await service.snapshot()).metrics.businessEffects, 1);
});

test("paused queue accepts durable events and resumes them explicitly", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  await service.action({ type: "pause", paused: true });
  const event = await service.send(endpoint.id, "invoice.paid");
  await service.pump();
  assert.equal((await service.detail(event)).attempts.length, 0);
  await service.action({ type: "pause", paused: false });
  await service.pump();
  assert.equal((await service.detail(event)).delivery.status, "delivered");
});

test("expired worker claims recover with an audit record and consume their attempt budget", async (context) => {
  const { db, service, endpoints, advance } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  const event = await service.send(endpoint.id, "invoice.paid");
  const now = (await service.snapshot()).system.now;
  await db.batch([
    db
      .prepare(
        "UPDATE deliveries SET attempts = 1, lease_token = 'crashed-worker', lease_until = ? WHERE id = ?",
      )
      .bind(now + LEASE_MS, event),
    db
      .prepare(
        "INSERT INTO attempts (id, owner, event_id, number, created_at) VALUES ('crashed-worker', 'alice', ?, 1, ?)",
      )
      .bind(event, now),
  ]);
  await service.pump();
  assert.equal((await service.detail(event)).attempts.length, 1);
  advance(LEASE_MS + 1);
  await service.pump();
  const detail = await service.detail(event);
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.attempts, 2);
  assert.equal(detail.attempts.length, 2);
  assert.match(detail.attempts[0].error!, /lease expired/);
});

test("receiver rejects forged bytes and permits only one business effect for signed redelivery", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  const event = await service.send(endpoint.id, "invoice.paid", { amount: 42 });
  const { signing_secret: secret } = (await db
    .prepare("SELECT signing_secret FROM workspaces WHERE owner = 'alice'")
    .first<{ signing_secret: string }>())!;
  const now = (await service.snapshot()).system.now;
  const body = canonicalJson({
    eventId: event,
    eventType: "invoice.paid",
    payload: { amount: 42 },
    attempt: 1,
  });
  const signature = await signPayload(secret, now, body);
  assert.equal(
    (await service.receive(endpoint.id, body + " ", now, signature)).status,
    401,
  );
  assert.equal(
    (await service.receive(endpoint.id, body, now, signature)).duplicate,
    false,
  );
  assert.equal(
    (await service.receive(endpoint.id, body, now, signature)).duplicate,
    true,
  );
  assert.equal((await service.snapshot()).metrics.businessEffects, 1);
});

test("a stale worker cannot overwrite recovered attempts or create a second business effect", async (context) => {
  const { db, service, endpoints, advance } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  const event = await service.send(endpoint.id, "invoice.paid");
  const clock = () =>
    service.snapshot().then((snapshot) => snapshot.system.now);
  let now = await clock();
  const stale = new RelayService(db, "alice", () => now);
  let reached!: () => void;
  let release!: () => void;
  const receiverReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const receiverHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receive = stale.receive.bind(stale);
  stale.receive = async (...args) => {
    const response = await receive(...args);
    reached();
    await receiverHeld;
    return response;
  };
  const stalePump = stale.pump();
  await receiverReached;
  advance(LEASE_MS + 1);
  now = await clock();
  await service.pump();
  release();
  await stalePump;
  const detail = await service.detail(event);
  assert.equal(detail.delivery.status, "delivered");
  assert.equal(detail.delivery.attempts, 2);
  assert.equal(detail.attempts[0].statusCode, null);
  assert.match(detail.attempts[0].error!, /lease expired/);
  assert.equal(detail.attempts[1].statusCode, 200);
  assert.equal((await service.snapshot()).metrics.businessEffects, 1);
});

test("timeout records measured latency without side effects; retries wait for their due timestamp", async (context) => {
  const { db, service, endpoints } = await fixture();
  context.after(() => db.close());
  const endpoint = endpoints.find((row) => row.mode === "healthy")!;
  await service.action({
    type: "set-receiver",
    endpointId: endpoint.id,
    mode: "timeout",
  });
  const event = await service.send(endpoint.id, "invoice.paid");
  await service.pump();
  const first = await service.detail(event);
  assert.equal(first.delivery.status, "retrying");
  assert.equal(first.attempts[0].statusCode, 504);
  assert.ok(first.attempts[0].durationMs >= 200);
  assert.equal((await service.snapshot()).metrics.businessEffects, 0);
  await service.pump();
  assert.equal((await service.detail(event)).attempts.length, 1);
});
