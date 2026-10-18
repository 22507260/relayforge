import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditQueryFor,
  deliveryQueryFor,
  insightsQueryFor,
  navigationForView,
  parseNavigation,
  safeReturnTo,
  serializeNavigation,
} from "../lib/navigation.ts";

const parseUrl = (url: string) =>
  parseNavigation(new URL(url, "http://localhost:3000").search);

test("operations URLs retain scope and inspected event without stale list or insight filters", () => {
  const state = parseNavigation(
    "?view=operations&scope=lab&endpoint=billing_1&window=7d&status=dead&page=3&event=event_1",
  );
  const link = serializeNavigation(state);
  assert.equal(link, "/?view=operations&scope=lab&event=event_1");
  assert.deepEqual(parseUrl(link), state);
  assert.equal(safeReturnTo(link, "https://app.example.test"), link);
  assert.equal(
    serializeNavigation(navigationForView("operations")),
    "/?view=operations",
  );
});

test("insights links retain scope, connection and time window without carrying delivery mutations or audit filters", () => {
  const state = parseNavigation(
    "?view=insights&scope=lab&window=7d&endpoint=billing_1&status=dead&page=3&operation=op_1&event=event_1",
  );
  assert.deepEqual(insightsQueryFor(state), {
    scope: "lab",
    window: "7d",
    endpointId: "billing_1",
  });
  const link = serializeNavigation(state);
  assert.equal(
    link,
    "/?view=insights&scope=lab&endpoint=billing_1&window=7d&event=event_1",
  );
  assert.deepEqual(parseUrl(link), state);
  assert.equal(safeReturnTo(link, "https://app.example.test"), link);
  assert.equal(parseNavigation("?view=insights&window=1h").window, "1h");
  assert.equal(
    serializeNavigation(navigationForView("insights")),
    "/?view=insights",
  );
});

test("insights window and destination URL values canonicalize to bounded defaults", () => {
  for (const query of [
    "window=365d",
    "window=1h&window=7d",
    "window=0",
    "window=24H",
  ]) {
    assert.equal(parseNavigation(`?view=insights&${query}`).window, "24h");
  }
  const state = parseNavigation(
    "?view=insights&endpoint=../private&scope=lab&scope=live",
  );
  assert.deepEqual(insightsQueryFor(state), {
    window: "24h",
    scope: "live",
    endpointId: "all",
  });
  assert.equal(serializeNavigation(state), "/?view=insights");
  assert.equal(parseNavigation("?view=studio&window=7d").window, "24h");
});

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

test("live and lab scope survive sharing, sign-in return, and cross-view navigation while legacy endpoints links remain valid", () => {
  assert.equal(navigationForView().scope, "live");
  const lab = parseNavigation(
    "?scope=lab&view=studio&endpoint=reference-42&event=event-42",
  );
  assert.equal(lab.view, "studio");
  assert.equal(lab.scope, "lab");
  assert.equal(lab.endpoint, "reference-42");
  const shared = serializeNavigation(lab);
  assert.deepEqual(parseUrl(shared), lab);
  assert.equal(safeReturnTo(shared), shared);
  const connections = { ...navigationForView("endpoints"), scope: lab.scope };
  assert.equal(serializeNavigation(connections), "/?view=endpoints&scope=lab");
  assert.equal(parseNavigation("?view=endpoints").view, "endpoints");
  assert.equal(parseNavigation("?scope=live&scope=lab").scope, "live");
  assert.equal(
    parseNavigation("?view=studio&endpoint=..%2Fprivate").endpoint,
    "all",
  );
  assert.equal(parseNavigation("?scope=production").scope, "live");
  assert.ok(
    !serializeNavigation(navigationForView("studio")).includes("endpoint="),
  );
});
