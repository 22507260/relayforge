import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditQueryFor,
  deliveryQueryFor,
  navigationForView,
  parseNavigation,
  safeReturnTo,
  serializeNavigation,
} from "../lib/navigation.ts";

const parseUrl = (url: string) =>
  parseNavigation(new URL(url, "http://localhost:3000").search);

test("shared delivery and audit URLs survive reload and back/forward traversal without losing detail or filters", () => {
  const delivery = parseNavigation(
    "?view=deliveries&page=3&size=50&q=invoice.paid&status=dead&endpoint=endpoint-a&event=event-42",
  );
  assert.equal(delivery.event, "event-42");
  assert.deepEqual(deliveryQueryFor(delivery), {
    page: 3,
    pageSize: 50,
    search: "invoice.paid",
    status: "dead",
    endpointId: "endpoint-a",
  });
  const audit = parseNavigation(
    "?view=activity&page=2&size=10&category=delivery&kind=replay&auditEvent=event-42&operation=batch-17&from=0&to=1800000000000&event=event-42",
  );
  assert.deepEqual(auditQueryFor(audit), {
    page: 2,
    pageSize: 10,
    search: "",
    category: "delivery",
    kind: "replay",
    eventId: "event-42",
    operationId: "batch-17",
    from: 0,
    to: 1_800_000_000_000,
  });
  const browserHistory = [
    serializeNavigation(delivery),
    serializeNavigation(audit),
    serializeNavigation(navigationForView("security")),
  ];
  assert.deepEqual(
    parseUrl(browserHistory[0]),
    delivery,
    "Reload restores the shared event link and its filters",
  );
  assert.deepEqual(
    parseUrl(browserHistory[1]),
    audit,
    "Back from Security restores the audit operation group",
  );
  assert.deepEqual(
    parseUrl(browserHistory[2]),
    navigationForView("security"),
    "Forward restores Security without carrying another view's filters",
  );
});

test("recovery URLs always request dead deliveries and keep paging independent of unrelated filters", () => {
  const recovery = parseNavigation(
    "?view=recovery&page=4&size=20&q=payment&endpoint=endpoint-b&status=delivered&category=security&operation=batch-99",
  );
  assert.deepEqual(deliveryQueryFor(recovery), {
    page: 4,
    pageSize: 20,
    search: "payment",
    status: "dead",
    endpointId: "endpoint-b",
  });
  const canonical = serializeNavigation(recovery);
  assert.ok(!canonical.includes("status="));
  assert.ok(!canonical.includes("category="));
  assert.ok(!canonical.includes("operation="));
  assert.deepEqual(parseUrl(canonical), recovery);
  assert.equal(parseNavigation("?view=recovery&size=50").size, 10);
});

test("invalid or duplicated URL values canonicalize to bounded defaults without injecting API filters", () => {
  const invalid = parseNavigation(
    "?view=activity&page=1&page=499&size=900&q=%00%0A%20search%20&category=security&kind=replay&operation=..%2Fsecret&from=1000&to=999&owner=administrator",
  );
  assert.equal(invalid.page, 1);
  assert.equal(invalid.size, 20);
  assert.equal(invalid.q, "search");
  assert.equal(invalid.kind, "all");
  assert.equal(invalid.operation, "all");
  assert.equal(invalid.from, null);
  assert.equal(invalid.to, null);
  assert.ok(!serializeNavigation(invalid).includes("owner="));
  assert.equal(parseNavigation("?view=unknown").view, "overview");
  assert.equal(
    parseNavigation("?view=deliveries&page=501&event=..%2Fsecret").page,
    1,
  );
  assert.equal(
    parseNavigation("?view=deliveries&page=501&event=..%2Fsecret").event,
    null,
  );
  assert.equal(
    parseNavigation("?view=activity&q=" + "a".repeat(200)).q.length,
    100,
  );
  assert.equal(
    parseNavigation("?view=activity&from=9007199254740992").from,
    null,
  );
});

test("login return destinations preserve canonical app links and reject external or non-dashboard redirects", () => {
  const origin = "http://localhost:3000";
  const destination =
    "/?view=deliveries&status=dead&event=event-42&unknown=value";
  assert.equal(
    safeReturnTo(destination, origin),
    "/?view=deliveries&status=dead&event=event-42",
  );
  for (const target of [
    null,
    "https://attacker.example/",
    "//attacker.example/",
    "/\\attacker.example",
    "/login?next=//attacker.example",
    "/api/security",
    "javascript:alert(1)",
    "http://localhost:3000/?view=security",
  ])
    assert.equal(safeReturnTo(target, origin), "/", String(target));
  assert.equal(
    safeReturnTo("/?view=activity&category=security", origin),
    "/?view=activity&category=security",
  );
});
