import assert from "node:assert/strict";
import { test } from "node:test";
import type { Delivery, Endpoint } from "../lib/contracts.ts";
import {
  commandDestination,
  deliveryCommands,
  localCommands,
  MAX_EVENT_COMMANDS,
  MAX_RECEIVER_COMMANDS,
  normalizeCommandQuery,
} from "../lib/commands.ts";
import {
  parseNavigation,
  serializeNavigation,
  views,
} from "../lib/navigation.ts";

function endpoint(id: string, name: string, description = ""): Endpoint {
  return {
    id,
    name,
    description,
    url: `/api/receiver/${id}`,
    color: "lime",
    mode: "healthy",
    purpose: "standard",
    deliveries: 0,
    delivered: 0,
    lastDurationMs: null,
  };
}

function delivery(id: string, overrides: Partial<Delivery> = {}): Delivery {
  return {
    id,
    eventType: "invoice.paid",
    endpointId: "billing",
    endpointName: "Billing",
    status: "delivered",
    attempts: 1,
    currentCycle: 1,
    createdAt: 1,
    updatedAt: 2,
    nextAttemptAt: null,
    payload: '{"secret":"never index this"}',
    latestAttempt: null,
    ...overrides,
  };
}

test("command queries normalize whitespace and controls before enforcing the API bound", () => {
  assert.equal(
    normalizeCommandQuery("  invoice.\npaid\u0000  Billing\t "),
    "invoice. paid Billing",
  );
  assert.equal(normalizeCommandQuery("\u0001\u007f\n"), "");
  assert.equal(normalizeCommandQuery("x".repeat(150)).length, 100);
  assert.equal(
    normalizeCommandQuery("\u00a0Audit   History\u00a0"),
    "Audit History",
  );
});

test("empty search provides every known view, while exact names outrank keyword matches", () => {
  const commands = localCommands("", [endpoint("billing", "Billing")]);
  assert.deepEqual(
    commands.map((entry) => entry.destination.view),
    [...views],
  );
  assert.ok(commands.every((entry) => entry.kind === "view"));
  assert.equal(
    localCommands("security", [])[0].destination.view,
    "security",
    "Security must precede the Activity security-history keyword match",
  );
  assert.equal(
    localCommands("  audit   history ", [])[0].destination.view,
    "activity",
  );
  assert.equal(
    localCommands("ACCOUNT SESSIONS", [])[0].destination.view,
    "security",
  );
  assert.equal(localCommands("unmatched-phrase", []).length, 0);
});

test("receiver searches match tenant metadata, rank exact names, and bound large workspaces", () => {
  const receivers = [
    endpoint("billing-extra", "Billing archive"),
    endpoint("billing", "Billing"),
    ...Array.from({ length: 20 }, (_, index) =>
      endpoint(`billing-${index}`, `Billing ${index}`),
    ),
    endpoint("invalid/identifier", "Billing"),
    endpoint("unrelated", "Support", "Customer service"),
  ];
  const matches = localCommands("billing", receivers).filter(
    (entry) => entry.kind === "endpoint",
  );
  assert.equal(matches.length, MAX_RECEIVER_COMMANDS);
  assert.equal(matches[0].destination.endpoint, "billing");
  assert.ok(
    matches.every(
      (entry) => entry.destination.endpoint !== "invalid/identifier",
    ),
  );
  const support = localCommands("customer service", receivers).find(
    (entry) => entry.kind === "endpoint",
  );
  assert.equal(support?.label, "Support");
  const target = commandDestination(matches[0]);
  assert.equal(target.view, "deliveries");
  assert.equal(target.page, 1);
  assert.equal(target.status, "all");
  assert.equal(target.event, null);
  assert.deepEqual(
    parseNavigation(
      new URL(serializeNavigation(target), "http://localhost").search,
    ),
    target,
  );
});

test("remote event commands retain only metadata, preserve full-history IDs, and cannot carry payloads into URLs", () => {
  const rows = [
    delivery("event-older-than-snapshot", { currentCycle: 5, status: "dead" }),
    delivery("event-older-than-snapshot"),
    delivery("bad/id"),
    ...Array.from({ length: 20 }, (_, index) => delivery(`event-${index}`)),
  ];
  const matches = deliveryCommands(rows);
  assert.equal(matches.length, MAX_EVENT_COMMANDS);
  assert.equal(matches[0].status, "dead");
  assert.equal(matches[0].destination.event, "event-older-than-snapshot");
  assert.equal(new Set(matches.map((entry) => entry.id)).size, matches.length);
  assert.ok(!JSON.stringify(matches).includes("never index this"));
  assert.ok(!JSON.stringify(matches).includes("payload"));
  const target = commandDestination(matches[0]);
  const url = serializeNavigation(target);
  assert.equal(url, "/?view=deliveries&event=event-older-than-snapshot");
  assert.deepEqual(
    parseNavigation(new URL(url, "http://localhost").search),
    target,
  );
  target.q = "changed by caller";
  assert.equal(
    matches[0].destination.q,
    "",
    "Destinations returned to the caller cannot mutate the option",
  );
});
