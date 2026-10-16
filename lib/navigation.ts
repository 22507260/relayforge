import type { AuditQuery, DeliveryQuery } from "./contracts.ts";

export const views = [
  "overview",
  "deliveries",
  "recovery",
  "endpoints",
  "studio",
  "activity",
  "engineering",
  "security",
] as const;
export type NavigationView = (typeof views)[number];
export const deliveryKinds = [
  "accepted",
  "delivered",
  "retry",
  "dead",
  "replay",
  "duplicate",
  "system",
] as const;
export const securityKinds = [
  "registered",
  "signed-in",
  "sign-in-failed",
  "signed-out",
  "session-revoked",
  "other-sessions-revoked",
  "password-changed",
] as const;
export interface NavigationState {
  view: NavigationView;
  scope: "live" | "lab";
  page: number;
  size: number;
  q: string;
  status: DeliveryQuery["status"];
  endpoint: string;
  event: string | null;
  category: AuditQuery["category"];
  kind: AuditQuery["kind"];
  auditEvent: string;
  operation: string;
  from: number | null;
  to: number | null;
}
export function navigationForView(
  view: NavigationView = "overview",
): NavigationState {
  return {
    view,
    scope: "live",
    page: 1,
    size: view === "recovery" ? 10 : 20,
    q: "",
    status: "all",
    endpoint: "all",
    event: null,
    category: "all",
    kind: "all",
    auditEvent: "all",
    operation: "all",
    from: null,
    to: null,
  };
}
const identifier = (value: string | null) =>
  value && value.length <= 100 && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
const positive = (value: string | null, maximum: number, fallback: number) =>
  value && /^[1-9]\d*$/.test(value) && Number(value) <= maximum
    ? Number(value)
    : fallback;
const timestamp = (value: string | null) =>
  value &&
  /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) <= 8_640_000_000_000_000
    ? Number(value)
    : null;

/** Unknown keys are discarded. Duplicate known keys are treated as invalid. */
export function parseNavigation(
  search: string | URLSearchParams,
): NavigationState {
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : search;
  const get = (key: string) =>
    params.getAll(key).length === 1 ? params.get(key) : null;
  const requestedView = get("view");
  const view: NavigationView = views.includes(requestedView as NavigationView)
    ? (requestedView as NavigationView)
    : "overview";
  const state = navigationForView(view);
  if (get("scope") === "lab") state.scope = "lab";
  state.event = identifier(get("event"));
  if (view === "studio") state.endpoint = identifier(get("endpoint")) ?? "all";
  if (["deliveries", "recovery", "activity"].includes(view)) {
    state.page = positive(get("page"), 500, 1);
    const size = positive(
      get("size"),
      view === "recovery" ? 20 : 50,
      state.size,
    );
    state.size = (view === "recovery" ? [10, 20] : [10, 20, 50]).includes(size)
      ? size
      : state.size;
    state.q = (get("q") ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 100);
  }
  if (view === "deliveries" || view === "recovery") {
    state.endpoint = identifier(get("endpoint")) ?? "all";
    const status = get("status");
    if (
      view === "deliveries" &&
      ["pending", "delivered", "retrying", "dead"].includes(status ?? "")
    )
      state.status = status as DeliveryQuery["status"];
  }
  if (view === "activity") {
    const category = get("category");
    if (category === "delivery" || category === "security")
      state.category = category;
    const kind = get("kind");
    const kinds: readonly string[] =
      state.category === "delivery"
        ? deliveryKinds
        : state.category === "security"
          ? securityKinds
          : [...deliveryKinds, ...securityKinds];
    if (kind && kinds.includes(kind)) state.kind = kind as AuditQuery["kind"];
    state.auditEvent = identifier(get("auditEvent")) ?? "all";
    state.operation = identifier(get("operation")) ?? "all";
    state.from = timestamp(get("from"));
    state.to = timestamp(get("to"));
    if (state.from !== null && state.to !== null && state.from > state.to) {
      state.from = null;
      state.to = null;
    }
  }
  return state;
}

export function serializeNavigation(state: NavigationState): string {
  const params = new URLSearchParams();
  if (state.view !== "overview") params.set("view", state.view);
  if (state.scope === "lab") params.set("scope", "lab");
  if (state.view === "studio" && state.endpoint !== "all")
    params.set("endpoint", state.endpoint);
  if (["deliveries", "recovery", "activity"].includes(state.view)) {
    if (state.page !== 1) params.set("page", String(state.page));
    if (state.size !== (state.view === "recovery" ? 10 : 20))
      params.set("size", String(state.size));
    if (state.q.trim()) params.set("q", state.q.trim());
  }
  if (state.view === "deliveries" || state.view === "recovery") {
    if (state.view === "deliveries" && state.status !== "all")
      params.set("status", state.status);
    if (state.endpoint !== "all") params.set("endpoint", state.endpoint);
  }
  if (state.view === "activity") {
    if (state.category !== "all") params.set("category", state.category);
    if (state.kind !== "all") params.set("kind", state.kind);
    if (state.auditEvent !== "all") params.set("auditEvent", state.auditEvent);
    if (state.operation !== "all") params.set("operation", state.operation);
    if (state.from !== null) params.set("from", String(state.from));
    if (state.to !== null) params.set("to", String(state.to));
  }
  if (state.event) params.set("event", state.event);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export function safeReturnTo(
  target: string | null,
  origin = "http://localhost",
): string {
  if (
    !target ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\")
  )
    return "/";
  try {
    const url = new URL(target, origin);
    return url.origin === new URL(origin).origin && url.pathname === "/"
      ? serializeNavigation(parseNavigation(url.search))
      : "/";
  } catch {
    return "/";
  }
}

export function deliveryQueryFor(state: NavigationState): DeliveryQuery {
  return {
    page: state.page,
    pageSize: state.size,
    search: state.q,
    status: state.view === "recovery" ? "dead" : state.status,
    endpointId: state.endpoint,
  };
}
export function auditQueryFor(state: NavigationState): AuditQuery {
  return {
    page: state.page,
    pageSize: state.size,
    search: state.q,
    category: state.category,
    kind: state.kind,
    eventId: state.auditEvent,
    operationId: state.operation,
    from: state.from,
    to: state.to,
  };
}
