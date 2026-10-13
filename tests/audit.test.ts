import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { AuditQuery } from "../lib/contracts.ts";
import { AuditService } from "../lib/server/audit.ts";
import { AuthService } from "../lib/server/auth.ts";
import { SqliteDatabase } from "../lib/server/database.ts";
import { ApiError } from "../lib/server/domain.ts";
import { parseAuditQuery } from "../lib/server/http.ts";
import { RelayService } from "../lib/server/service.ts";

const query = (values: Partial<AuditQuery> = {}): AuditQuery => ({
  page: 1,
  pageSize: 20,
  category: "all",
  kind: "all",
  search: "",
  eventId: "all",
  operationId: "all",
  from: null,
  to: null,
  ...values,
});
const status = (expected: number) => (error: unknown) =>
  error instanceof ApiError && error.status === expected;

async function fixture(context: TestContext) {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db, () => 1_800_000_000_000);
  const account = await auth.register({
    email: "audit-alice@example.test",
    password: "audit account password",
  });
  const foreign = await auth.register({
    email: "audit-bob@example.test",
    password: "foreign account password",
  });
  await new RelayService(db, account.user.id).initialize();
  await new RelayService(db, foreign.user.id).initialize();
  db.connection.exec("DELETE FROM activity; DELETE FROM security_events;");
  const activity = db.connection.prepare(
    "INSERT INTO activity (id,owner,kind,event_id,message,created_at,cycle,operation_id) VALUES (?,?,?,?,?,?,?,?)",
  );
  const security = db.connection.prepare(
    "INSERT INTO security_events (id,owner,kind,message,created_at) VALUES (?,?,?,?,?)",
  );
  for (let index = 0; index < 45; index++)
    activity.run(
      `delivery-${String(index).padStart(3, "0")}`,
      account.user.id,
      index % 2 ? "replay" : "delivered",
      index % 2 ? "event-b" : "event-a",
      index === 11 ? "Literal 100%_finished" : `Delivery audit ${index}`,
      1000 + Math.floor(index / 3),
      index % 2 ? 2 : 1,
      index % 2 ? "operation-batch" : null,
    );
  for (let index = 0; index < 22; index++)
    security.run(
      `security-${String(index).padStart(3, "0")}`,
      account.user.id,
      index % 2 ? "signed-in" : "session-revoked",
      `Security audit ${index}`,
      1000 + Math.floor(index / 3),
    );
  activity.run(
    "foreign-delivery",
    foreign.user.id,
    "replay",
    "event-a",
    "Foreign delivery audit",
    2000,
    9,
    "operation-batch",
  );
  security.run(
    "foreign-security",
    foreign.user.id,
    "signed-in",
    "Foreign security audit",
    2000,
  );
  return {
    db,
    audit: new AuditService(db, account.user.id),
    foreign: new AuditService(db, foreign.user.id),
  };
}

test("audit pagination traverses full delivery and security history with stable ties and no repeats", async (context) => {
  const { audit } = await fixture(context);
  const first = await audit.list(query({ pageSize: 10 }));
  assert.equal(
    first.total,
    67,
    "The explorer must include history beyond snapshot's last thirty entries",
  );
  assert.equal(first.totalPages, 7);
  const pages = [first];
  for (let page = 2; page <= first.totalPages; page++)
    pages.push(await audit.list(query({ pageSize: 10, page })));
  const records = pages.flatMap((page) => page.records);
  assert.equal(records.length, 67);
  assert.equal(
    new Set(records.map((record) => `${record.category}:${record.id}`)).size,
    67,
  );
  assert.deepEqual(
    (await audit.list(query({ pageSize: 10 }))).records,
    first.records,
  );
  assert.deepEqual(records, [
    ...(await audit.list(query({ pageSize: 50 }))).records,
    ...(await audit.list(query({ pageSize: 50, page: 2 }))).records,
  ]);
  for (let index = 1; index < records.length; index++)
    assert.ok(records[index - 1].createdAt >= records[index].createdAt);
  assert.equal((await audit.list(query({ page: 500, pageSize: 10 }))).page, 7);
});

test("audit filters select operation groups, event identity, date boundaries and literal text within one owner", async (context) => {
  const { audit, foreign } = await fixture(context);
  const operation = await audit.list(
    query({ operationId: "operation-batch", pageSize: 50 }),
  );
  assert.equal(operation.total, 22);
  assert.ok(
    operation.records.every(
      (record) =>
        record.category === "delivery" &&
        record.kind === "replay" &&
        record.cycle === 2,
    ),
  );
  assert.ok(operation.records.every((record) => record.eventId === "event-b"));
  const filtered = await audit.list(
    query({
      category: "delivery",
      kind: "replay",
      eventId: "event-b",
      operationId: "operation-batch",
      from: 1002,
      to: 1004,
      pageSize: 50,
    }),
  );
  assert.equal(filtered.total, 4);
  assert.ok(
    filtered.records.every(
      (record) => record.createdAt >= 1002 && record.createdAt <= 1004,
    ),
  );
  const oneTimestamp = await audit.list(
    query({ from: 1000, to: 1000, pageSize: 50 }),
  );
  assert.equal(oneTimestamp.total, 6);
  assert.equal(
    (
      await audit.list(
        query({ category: "security", kind: "signed-in", pageSize: 50 }),
      )
    ).total,
    11,
  );
  const caseInsensitive = await audit.list(
    query({ search: "SECURITY AUDIT", pageSize: 50 }),
  );
  assert.equal(caseInsensitive.total, 22);
  const literal = await audit.list(query({ search: "%_", pageSize: 50 }));
  assert.equal(
    literal.total,
    1,
    "Search characters must not expand to SQL wildcards",
  );
  assert.equal(literal.records[0].id, "delivery-011");
  assert.equal((await audit.list(query({ search: "' OR 1=1 --" }))).total, 0);
  assert.equal(
    (await audit.list(query({ eventId: "missing-event" }))).total,
    0,
  );
  const foreignRecords = await foreign.list(query());
  assert.equal(foreignRecords.total, 2);
  assert.ok(
    foreignRecords.records.every((record) => record.id.startsWith("foreign-")),
  );
  assert.ok(
    !(await audit.list(query())).records.some((record) =>
      record.id.startsWith("foreign-"),
    ),
  );
});

test("security audit records expose the public audit shape with no delivery or account secrets", async (context) => {
  const { audit } = await fixture(context);
  const page = await audit.list(query({ category: "security" }));
  for (const record of page.records) {
    assert.equal(record.eventId, null);
    assert.equal(record.cycle, null);
    assert.equal(record.operationId, null);
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        "category",
        "createdAt",
        "cycle",
        "eventId",
        "id",
        "kind",
        "message",
        "operationId",
      ].sort(),
    );
  }
  const serialized = JSON.stringify(page);
  for (const secret of [
    "password",
    "token_hash",
    "password_hash",
    "signing_secret",
    "payload",
    "@example.test",
  ])
    assert.ok(!serialized.includes(secret));
});

test("audit query validation rejects duplicate, unknown, unsafe and reversed query values", () => {
  assert.deepEqual(
    parseAuditQuery(new Request("http://localhost/api/audit")),
    query(),
  );
  const filtered = parseAuditQuery(
    new Request(
      "http://localhost/api/audit?page=2&pageSize=50&category=delivery&kind=replay&search=%20event%20&eventId=event-a&operationId=operation-batch&from=0&to=1000",
    ),
  );
  assert.deepEqual(
    filtered,
    query({
      page: 2,
      pageSize: 50,
      category: "delivery",
      kind: "replay",
      search: "event",
      eventId: "event-a",
      operationId: "operation-batch",
      from: 0,
      to: 1000,
    }),
  );
  for (const values of [
    "owner=other",
    "__proto__=other",
    "page=1&page=2",
    "category=delivery&category=security",
    "page=0",
    "page=501",
    "page=1.5",
    "pageSize=0",
    "pageSize=51",
    "category=unknown",
    "kind=unknown",
    "search=" + "a".repeat(101),
    "eventId=../secret",
    "operationId=" + "a".repeat(101),
    "from=-1",
    "from=",
    "to=1.5",
    "from=9007199254740992",
    "from=1000&to=999",
  ])
    assert.throws(
      () =>
        parseAuditQuery(new Request("http://localhost/api/audit?" + values)),
      status(400),
      values,
    );
});
