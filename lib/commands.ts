import type {
  ConnectionTransport,
  Delivery,
  DeliveryStatus,
  Endpoint,
} from "./contracts.ts";
import {
  navigationForView,
  type NavigationState,
  type NavigationView,
} from "./navigation.ts";

export interface CommandEntry {
  id: string;
  kind: "view" | "endpoint" | "event";
  label: string;
  detail: string;
  destination: NavigationState;
  status?: DeliveryStatus;
  transport?: ConnectionTransport;
}

const viewCommands: {
  view: NavigationView;
  label: string;
  detail: string;
  keywords: string;
}[] = [
  {
    view: "overview",
    label: "Overview",
    detail: "Workspace health and delivery metrics",
    keywords: "dashboard home metrics health",
  },
  {
    view: "deliveries",
    label: "Deliveries",
    detail: "Search the complete event history",
    keywords: "events webhook history queue",
  },
  {
    view: "insights",
    label: "Delivery Insights",
    detail: "Latency, failure patterns, and full-history delivery signals",
    keywords:
      "analytics statistics metrics latency p50 p95 performance failures http network",
  },
  {
    view: "recovery",
    label: "Recovery",
    detail: "Failed deliveries and the recovery guide",
    keywords: "failed failure dead replay retries lab guide",
  },
  {
    view: "endpoints",
    label: "Connections",
    detail: "Live destinations, signing keys, and lab receivers",
    keywords: "endpoints destinations receivers integrations https reference",
  },
  {
    view: "studio",
    label: "Integration Studio",
    detail: "Compose an event and follow its complete delivery journey",
    keywords: "send producer curl api json payload test integration",
  },
  {
    view: "activity",
    label: "Activity",
    detail: "Delivery and account audit history",
    keywords: "audit logs security history operations",
  },
  {
    view: "engineering",
    label: "Engineering",
    detail: "Delivery guarantees and system architecture",
    keywords: "architecture docs guarantees reliability worker",
  },
  {
    view: "security",
    label: "Security",
    detail: "Account sessions and password settings",
    keywords: "account sessions password authentication",
  },
];

export const MAX_RECEIVER_COMMANDS = 5;
export const MAX_EVENT_COMMANDS = 6;

/** Keep the query within the existing delivery API's search limit. */
export function normalizeCommandQuery(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
}

const identifier = (value: string) =>
  value.length > 0 && value.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(value);

function score(query: string, label: string, keywords: string): number {
  if (!query) return 1;
  const title = label.toLocaleLowerCase("en-US");
  const haystack = `${title} ${keywords.toLocaleLowerCase("en-US")}`;
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (title.includes(query)) return 60;
  if (query.split(" ").every((token) => haystack.includes(token))) return 20;
  return 0;
}

/** Local options come only from known views and the authenticated workspace. */
export function localCommands(
  value: string,
  endpoints: readonly Endpoint[],
): CommandEntry[] {
  const query = normalizeCommandQuery(value).toLocaleLowerCase("en-US");
  const rankedViews = viewCommands
    .map((entry, order) => ({
      entry,
      order,
      rank: score(query, entry.label, `${entry.detail} ${entry.keywords}`),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .map(({ entry }) => ({
      id: `view-${entry.view}`,
      kind: "view" as const,
      label: entry.label,
      detail: entry.detail,
      destination: navigationForView(entry.view),
    }));
  if (!query) return rankedViews;

  const receivers = endpoints
    .filter((endpoint) => identifier(endpoint.id))
    .map((entry, order) => ({
      entry,
      order,
      rank: score(query, entry.name, `${entry.description} ${entry.id}`),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .slice(0, MAX_RECEIVER_COMMANDS)
    .map(({ entry }) => ({
      id: `endpoint-${entry.id}`,
      kind: "endpoint" as const,
      label: entry.name,
      detail: "Open deliveries for this receiver",
      destination: {
        ...navigationForView("deliveries"),
        endpoint: entry.id,
      },
    }));
  return [...rankedViews, ...receivers];
}

/** The caller supplies results from the authenticated, paginated delivery API. */
export function deliveryCommands(
  deliveries: readonly Delivery[],
): CommandEntry[] {
  const seen = new Set<string>();
  return deliveries
    .filter((delivery) => {
      if (!identifier(delivery.id) || seen.has(delivery.id)) return false;
      seen.add(delivery.id);
      return true;
    })
    .slice(0, MAX_EVENT_COMMANDS)
    .map((delivery) => ({
      id: `event-${delivery.id}`,
      kind: "event" as const,
      label: delivery.eventType,
      detail: `${delivery.endpointName} · ${delivery.id}`,
      status: delivery.status,
      transport: delivery.transport,
      destination: {
        ...navigationForView("deliveries"),
        event: delivery.id,
      },
    }));
}

export function commandDestination(command: CommandEntry): NavigationState {
  return { ...command.destination };
}
