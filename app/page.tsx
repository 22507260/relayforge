"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Database,
  GitBranch,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Webhook,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Action,
  Activity,
  DeliveryDetail,
  DeliveryPage,
  DeliveryStatus,
  Endpoint,
  ReceiverMode,
  Snapshot,
} from "@/lib/contracts";
import {
  Button,
  CloseButton,
  DeliveryChart,
  DeliveryTable,
  Dialog,
  EmptyState,
  formatDuration,
  formatNumber,
  formatTime,
  fullDate,
  JsonBlock,
  Logo,
  Pagination,
  PanelHeading,
  relativeTime,
  StatusBadge,
  ViewAll,
} from "./components/relay-ui";

type View =
  "Overview" | "Deliveries" | "Endpoints" | "Activity" | "Engineering";
type StatusFilter = "all" | DeliveryStatus;
type Notice = { id: number; message: string; error?: boolean };
const navigation = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Deliveries", icon: Layers3 },
  { name: "Endpoints", icon: Webhook },
  { name: "Activity", icon: ActivityIcon },
  { name: "Engineering", icon: Code2 },
] as const;
const receiverModes: ReceiverMode[] = [
  "healthy",
  "flaky",
  "failing",
  "timeout",
];
const modeDescriptions: Record<ReceiverMode, string> = {
  healthy: "Acknowledges signed events with HTTP 200.",
  flaky: "Returns HTTP 503 on the first two attempts, then recovers.",
  failing: "Returns HTTP 500 until you change its behavior.",
  timeout: "Exceeds the sandbox deadline and returns HTTP 504.",
};
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
const titleForActivity: Record<Activity["kind"], string> = {
  accepted: "Event accepted",
  delivered: "Delivery acknowledged",
  retry: "Retry scheduled",
  dead: "Attempts exhausted",
  replay: "Event replayed",
  duplicate: "Duplicate prevented",
  system: "Engine configuration",
};

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(
  url: string,
  action?: Action,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    url,
    action
      ? {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
          signal,
        }
      : { cache: "no-store", credentials: "same-origin", signal },
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RequestError(
      "The engine returned an unexpected response. Please reconnect.",
      response.status,
    );
  }
  const message =
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
      ? body.error
      : "The request could not be completed. Please try again.";
  if (!response.ok)
    throw new RequestError(
      response.status === 401
        ? "Your session has ended. Sign in to continue."
        : message,
      response.status,
    );
  return body as T;
}

function ModeBadge({ mode }: { mode: ReceiverMode }) {
  return (
    <span className={`mode-badge mode-${mode}`}>
      <i />
      {capitalize(mode)}
    </span>
  );
}

function processorStatus(system: Snapshot["system"]) {
  const online = system.processor === "worker";
  const lastHeartbeatAt = system.worker?.lastHeartbeatAt ?? null;
  const heartbeat =
    lastHeartbeatAt === null
      ? "No worker heartbeat recorded"
      : `Heartbeat ${relativeTime(lastHeartbeatAt, system.now).toLowerCase()}`;
  const description = online
    ? `${heartbeat}. Background delivery runs independently of this page.`
    : `${lastHeartbeatAt === null ? "No fresh worker heartbeat is available." : "The last worker heartbeat is stale."} The visible page requests delivery processing every 3 seconds.`;
  return { online, lastHeartbeatAt, heartbeat, description };
}

function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <span className="page-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

function EventForm({
  endpoints,
  initialEndpointId,
  onClose,
  send,
  busy,
}: {
  endpoints: Endpoint[];
  initialEndpointId: string | null;
  onClose: () => void;
  send: (action: Action) => Promise<boolean>;
  busy: boolean;
}) {
  const [endpointId, setEndpointId] = useState(
    initialEndpointId ||
      endpoints.find((endpoint) => endpoint.mode === "healthy")?.id ||
      endpoints[0]?.id ||
      "",
  );
  const [eventType, setEventType] = useState("invoice.paid");
  const [payload, setPayload] = useState(
    '{\n  "customerId": "cus_1042",\n  "amount": 14900,\n  "currency": "USD"\n}',
  );
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [error, setError] = useState("");
  const endpoint = endpoints.find((item) => item.id === endpointId);
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  let validJson = false;
  try {
    const value: unknown = JSON.parse(payload);
    validJson = Boolean(
      value && typeof value === "object" && !Array.isArray(value),
    );
  } catch {
    /* The form reports a parse error on submission. */
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      const value: unknown = JSON.parse(payload);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("The payload must be a valid JSON object.");
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(eventType))
        throw new Error(
          "Start with a letter and use up to 64 letters, numbers, dots, underscores or hyphens.",
        );
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 12_288)
        throw new Error("The payload must be smaller than 12 KB.");
      if (!endpointId) throw new Error("Choose a destination for this event.");
      const accepted = await send({
        type: "send",
        endpointId,
        eventType,
        payload: value as Record<string, unknown>,
        ...(idempotencyKey.trim()
          ? { idempotencyKey: idempotencyKey.trim() }
          : {}),
      });
      if (accepted) onClose();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Check the event fields and try again.",
      );
    }
  };
  return (
    <Dialog title="Send a new event" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <span className="modal-icon">
              <Zap size={20} />
            </span>
            <div>
              <h2>Send a new event</h2>
              <p>Dispatch a signed event to a sandbox receiver.</p>
            </div>
          </div>
          <CloseButton onClick={onClose} label="Close event form" />
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">Event type</span>
            <input
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
              placeholder="invoice.paid"
              required
              maxLength={64}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field-label">Destination</span>
            <span className="select-wrap">
              <select
                value={endpointId}
                onChange={(event) => setEndpointId(event.target.value)}
              >
                {endpoints.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} />
            </span>
          </label>
          <label className="field">
            <span className="field-label">JSON payload</span>
            <textarea
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
              required
              spellCheck={false}
              rows={7}
            />
            <span className={`field-hint ${validJson ? "valid" : ""}`}>
              <Code2 size={14} />
              {validJson ? "Valid JSON object" : "Enter a JSON object"} ·{" "}
              {formatNumber(payloadBytes)} bytes · 12 KB limit
            </span>
          </label>
          <label className="field">
            <span className="field-label">
              Idempotency key <small>Optional</small>
            </span>
            <input
              value={idempotencyKey}
              onChange={(event) => setIdempotencyKey(event.target.value)}
              placeholder="e.g. invoice-1042-paid"
              maxLength={128}
              autoComplete="off"
            />
            <span className="field-hint">
              Reuse the same key and payload to prevent a duplicate event.
            </span>
          </label>
          {endpoint && (
            <div className="destination-preview">
              <span className={`endpoint-dot ${endpoint.mode}`}>
                <Webhook size={17} />
              </span>
              <div>
                <strong>{endpoint.name}</strong>
                <code>{endpoint.url}</code>
              </div>
              <ModeBadge mode={endpoint.mode} />
            </div>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Send size={16} />
            )}
            {busy ? "Sending…" : "Send event"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeliveryDrawer({
  id,
  version,
  maxAttempts,
  close,
  replay,
  viewEndpoint,
  busy,
  copy,
}: {
  id: string;
  version: number;
  maxAttempts: number;
  close: () => void;
  replay: () => void;
  viewEndpoint: (id: string) => void;
  busy: boolean;
  copy: (text: string) => void;
}) {
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [tab, setTab] = useState<"payload" | "response">("payload");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<DeliveryDetail>(
      `/api/deliveries/${encodeURIComponent(id)}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setDetail(data);
          setError("");
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(
            err instanceof Error ? err.message : "Could not load this event.",
          );
      });
    return () => controller.abort();
  }, [id, version, retry]);
  const event = detail?.delivery;
  const last = detail?.attempts[detail.attempts.length - 1];
  let prettyPayload = event?.payload || "{}";
  try {
    prettyPayload = JSON.stringify(JSON.parse(prettyPayload), null, 2);
  } catch {
    /* Preserve the exact stored payload if it cannot be formatted. */
  }
  const lastResponse = JSON.stringify(
    last
      ? {
          statusCode: last.statusCode,
          durationMs:
            last.finishedAt == null || last.statusCode == null
              ? null
              : last.durationMs,
          error: last.error,
          startedAt: new Date(last.createdAt).toISOString(),
          finishedAt: last.finishedAt
            ? new Date(last.finishedAt).toISOString()
            : null,
        }
      : { message: "No attempt has been recorded yet." },
    null,
    2,
  );
  return (
    <Dialog title="Delivery details" onClose={close} drawer>
      <div className="drawer-head">
        <div>
          <span className="drawer-label">DELIVERY DETAILS</span>
          <h2>{event?.eventType || "Loading event…"}</h2>
          {event && (
            <button className="event-id-copy" onClick={() => copy(event.id)}>
              {event.id}
              <Copy size={13} />
            </button>
          )}
        </div>
        <CloseButton onClick={close} label="Close delivery details" />
      </div>
      {!event ? (
        error ? (
          <EmptyState title="Unable to load this delivery" description={error}>
            <Button
              variant="secondary"
              onClick={() => setRetry((value) => value + 1)}
            >
              <RotateCcw size={16} />
              Try again
            </Button>
          </EmptyState>
        ) : (
          <div className="drawer-loading">
            <LoaderCircle className="spin" size={24} />
            <span>Loading delivery details…</span>
          </div>
        )
      ) : (
        <>
          {error && (
            <div className="drawer-error" role="alert">
              {error}
              <button onClick={() => setRetry((value) => value + 1)}>
                Retry
              </button>
            </div>
          )}
          <div className="drawer-status">
            <StatusBadge status={event.status} />
            <time title={fullDate(event.createdAt)}>
              Created {relativeTime(event.createdAt, version)}
            </time>
          </div>
          <div className="drawer-actions">
            {(event.status === "dead" || event.status === "delivered") && (
              <Button onClick={replay} disabled={busy}>
                <RotateCcw size={16} />
                Replay event
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => viewEndpoint(event.endpointId)}
            >
              <Webhook size={16} />
              View endpoint
            </Button>
          </div>
          {event.status === "delivered" && (
            <p className="drawer-replay-note">
              <ShieldCheck size={14} />
              Replaying preserves the event ID. Receiver effects remain
              deduplicated.
            </p>
          )}
          <section className="drawer-section">
            <h3>Event information</h3>
            <div className="info-grid">
              <div>
                <span>Destination</span>
                <strong>{event.endpointName}</strong>
              </div>
              <div>
                <span>Attempts this run</span>
                <strong>
                  {event.attempts} of {maxAttempts}
                </strong>
              </div>
              <div>
                <span>Last HTTP status</span>
                <strong
                  className={
                    last?.statusCode && last.statusCode >= 400
                      ? "danger-text"
                      : ""
                  }
                >
                  {last?.statusCode ||
                    (last?.finishedAt == null && last
                      ? "In progress"
                      : "Not recorded")}
                </strong>
              </div>
              <div>
                <span>Last duration</span>
                <strong>
                  {last?.finishedAt == null || last.statusCode == null
                    ? "—"
                    : formatDuration(last.durationMs)}
                </strong>
              </div>
            </div>
            {event.nextAttemptAt && (
              <p className="next-attempt">
                <Clock3 size={14} />
                Next eligible attempt at {formatTime(event.nextAttemptAt)} ·
                local time
              </p>
            )}
          </section>
          <section className="drawer-section">
            <div className="tabs">
              <button
                className={tab === "payload" ? "active" : ""}
                aria-pressed={tab === "payload"}
                onClick={() => setTab("payload")}
              >
                Payload
              </button>
              <button
                className={tab === "response" ? "active" : ""}
                aria-pressed={tab === "response"}
                onClick={() => setTab("response")}
              >
                Last attempt
              </button>
            </div>
            <JsonBlock
              value={tab === "payload" ? prettyPayload : lastResponse}
              copy={copy}
              label={
                tab === "payload"
                  ? "Immutable event payload"
                  : "Recorded attempt metadata"
              }
            />
          </section>
          <section className="drawer-section timeline">
            <div className="section-title">
              <h3>Attempt timeline</h3>
              <span>{detail!.attempts.length} recorded</span>
            </div>
            {!detail!.attempts.length ? (
              <div className="timeline-empty">
                <Clock3 size={18} />
                Waiting for the processor to claim this event.
              </div>
            ) : (
              detail!.attempts
                .slice()
                .reverse()
                .map((attempt) => {
                  const success =
                    attempt.statusCode != null &&
                    attempt.statusCode >= 200 &&
                    attempt.statusCode < 300;
                  const inProgress = attempt.finishedAt == null;
                  return (
                    <div className="timeline-item" key={attempt.id}>
                      <span
                        className={`timeline-dot ${success ? "success" : inProgress ? "pending" : "failed"}`}
                      >
                        {success ? (
                          <Check size={13} />
                        ) : inProgress ? (
                          <Clock3 size={13} />
                        ) : (
                          <X size={13} />
                        )}
                      </span>
                      <div className="timeline-content">
                        <button
                          className="timeline-toggle"
                          aria-expanded={expanded === attempt.id}
                          onClick={() =>
                            setExpanded(
                              expanded === attempt.id ? null : attempt.id,
                            )
                          }
                        >
                          <span>
                            <strong>Attempt {attempt.number}</strong>
                            <small>
                              {inProgress
                                ? "Processing the event"
                                : success
                                  ? "Acknowledged by receiver"
                                  : attempt.statusCode === 504
                                    ? "Receiver deadline exceeded"
                                    : attempt.statusCode
                                      ? "Receiver returned an error"
                                      : "Delivery interrupted"}
                            </small>
                          </span>
                          <span className="timeline-meta">
                            <b
                              className={
                                success
                                  ? "success-text"
                                  : inProgress
                                    ? "muted"
                                    : "danger-text"
                              }
                            >
                              {attempt.statusCode ||
                                (inProgress ? "WORKING" : "INTERRUPTED")}
                            </b>
                            <time title={fullDate(attempt.createdAt)}>
                              {formatTime(attempt.createdAt)}
                            </time>
                          </span>
                          <ChevronDown
                            size={15}
                            className={expanded === attempt.id ? "rotated" : ""}
                          />
                        </button>
                        {expanded === attempt.id && (
                          <div className="attempt-extra">
                            <p>
                              {attempt.error ||
                                (inProgress
                                  ? "The processor has claimed this event. The response has not been recorded yet."
                                  : "Signature verified. The receiver acknowledged the event.")}
                            </p>
                            <span>
                              Duration:{" "}
                              {inProgress
                                ? "In progress"
                                : attempt.statusCode == null
                                  ? "—"
                                  : formatDuration(attempt.durationMs)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
            )}
          </section>
        </>
      )}
    </Dialog>
  );
}

function Overview({
  snapshot,
  demo,
  busy,
  go,
  select,
}: {
  snapshot: Snapshot;
  demo: () => void;
  busy: boolean;
  go: (view: View) => void;
  select: (id: string) => void;
}) {
  const metrics = snapshot.metrics;
  const processor = processorStatus(snapshot.system);
  const healthy = snapshot.endpoints.filter(
    (endpoint) => endpoint.mode === "healthy",
  ).length;
  const unhealthy = snapshot.endpoints.length - healthy;
  const latest = snapshot.deliveries.slice(0, 5);
  const chartAcknowledged = snapshot.chart.reduce(
    (sum, bucket) => sum + bucket.delivered,
    0,
  );
  const chartFailed = snapshot.chart.reduce(
    (sum, bucket) => sum + bucket.failed,
    0,
  );
  const date = new Date(snapshot.system.now)
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    })
    .toUpperCase();
  return (
    <>
      <PageHeader
        eyebrow={date}
        title="Your pipeline, at a glance."
        description="Real events. Every attempt recorded. A safe place to test reliability."
      >
        <Button variant="secondary" onClick={demo} disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Play size={16} />
          )}
          Run live demo
        </Button>
      </PageHeader>
      <div className="metric-grid">
        {[
          {
            title: "Accepted events",
            value: formatNumber(metrics.total),
            tag: "Durable",
            tone: "green",
            icon: Zap,
            foot: "Persisted before acknowledgement",
          },
          {
            title: "Delivery success",
            value: `${metrics.successRate.toFixed(1)}%`,
            tag: `${formatNumber(metrics.delivered)} delivered`,
            tone: "green",
            icon: CheckCheck,
            foot: "Across all accepted events",
          },
          {
            title: "Queued events",
            value: formatNumber(metrics.queued),
            tag: snapshot.system.queuePaused
              ? "Paused"
              : processor.online
                ? "Background processing"
                : "Browser fallback",
            tone: "blue",
            icon: Clock3,
            foot: "Pending and retrying deliveries",
          },
          {
            title: "Failed events",
            value: formatNumber(metrics.dead),
            tag: metrics.dead ? "Replay available" : "No dead letters",
            tone: metrics.dead ? "red" : "neutral",
            icon: ActivityIcon,
            foot: "Events that exhausted their attempts",
          },
        ].map(({ title, value, tag, tone, icon: Icon, foot }) => (
          <article className="metric" key={title}>
            <div className={`metric-icon ${tone}`}>
              <Icon size={19} />
            </div>
            <div className="metric-top">
              <span>{title}</span>
            </div>
            <strong>{value}</strong>
            <div className="metric-bottom">
              <span className={`metric-tag ${tone}`}>{tag}</span>
              <p>{foot}</p>
            </div>
          </article>
        ))}
      </div>
      <div className="overview-middle">
        <section className="panel chart-panel">
          <PanelHeading
            title="Delivery attempts"
            description="Acknowledged and failed attempts over the last 10 minutes"
          >
            <span className="time-range">
              <Clock3 size={14} />
              Last 10 min
            </span>
          </PanelHeading>
          <div className="chart-legend">
            <span>
              <i className="legend-success" />
              Acknowledged
            </span>
            <span>
              <i className="legend-failed" />
              Failed attempts
            </span>
            <b>
              {formatNumber(chartAcknowledged + chartFailed)}
              <small>
                {" "}
                total{" "}
                {chartAcknowledged + chartFailed === 1 ? "attempt" : "attempts"}
              </small>
            </b>
          </div>
          <DeliveryChart data={snapshot.chart} />
          <div className="chart-foot">
            <span>
              <Radio size={13} />
              {snapshot.system.queuePaused
                ? "Queue paused"
                : processor.online
                  ? "Background worker · live snapshots"
                  : "Browser fallback · every 3 seconds"}
            </span>
            <span>UTC</span>
          </div>
        </section>
        <section className="panel health-panel">
          <PanelHeading
            title="Endpoint health"
            description="Current sandbox receiver behavior"
          >
            <ViewAll onClick={() => go("Endpoints")} />
          </PanelHeading>
          <div className="health-score">
            <div
              className="health-ring"
              style={{
                background: `conic-gradient(var(--lime) ${snapshot.endpoints.length ? (healthy / snapshot.endpoints.length) * 100 : 0}%, var(--border) 0)`,
              }}
            >
              <span>
                {healthy}
                <small>/ {snapshot.endpoints.length}</small>
              </span>
            </div>
            <div>
              <strong>
                {unhealthy
                  ? "Failure scenarios enabled"
                  : "Receivers are ready"}
              </strong>
              <p>
                {unhealthy
                  ? `${unhealthy} receiver${unhealthy === 1 ? "" : "s"} configured to return errors`
                  : "All receivers acknowledge signed events"}
              </p>
            </div>
          </div>
          <div className="health-endpoints">
            {snapshot.endpoints.map((endpoint) => (
              <button
                className="endpoint-row"
                key={endpoint.id}
                onClick={() => go("Endpoints")}
              >
                <span className={`endpoint-dot ${endpoint.mode}`}>
                  <Webhook size={16} />
                </span>
                <span>
                  <strong>{endpoint.name}</strong>
                  <small>
                    {endpoint.delivered} of {endpoint.deliveries} events
                    delivered
                  </small>
                </span>
                <ModeBadge mode={endpoint.mode} />
              </button>
            ))}
          </div>
        </section>
      </div>
      <section className="panel table-panel">
        <PanelHeading
          title="Recent deliveries"
          description="Follow an event from acceptance to acknowledgement"
        >
          <ViewAll onClick={() => go("Deliveries")} />
        </PanelHeading>
        <DeliveryTable
          rows={latest}
          onSelect={select}
          now={snapshot.system.now}
          maxAttempts={snapshot.system.maxAttempts}
          emptyAction={
            <Button variant="secondary" disabled={busy} onClick={demo}>
              <Play size={15} />
              Run your first demo
            </Button>
          }
        />
        <div className="table-foot">
          <span>
            Showing {latest.length} of {formatNumber(metrics.total)} accepted
            events
          </span>
          <span>
            <i className="live-dot" />
            {snapshot.system.queuePaused
              ? "Engine paused"
              : processor.online
                ? "Background worker online"
                : "Browser-driven fallback"}
          </span>
        </div>
      </section>
      <div className="integrity-strip">
        <span>
          <ShieldCheck size={16} />
          <strong>{formatNumber(metrics.duplicatesPrevented)}</strong>{" "}
          duplicates prevented
        </span>
        <span>
          <Database size={15} />
          <strong>{formatNumber(metrics.businessEffects)}</strong> unique
          receiver effects
        </span>
        <button onClick={() => go("Engineering")}>
          How reliability works
          <ArrowRight size={14} />
        </button>
      </div>
    </>
  );
}

function Endpoints({
  snapshot,
  busy,
  setMode,
  viewDeliveries,
  newEvent,
}: {
  snapshot: Snapshot;
  busy: boolean;
  setMode: (endpointId: string, mode: ReceiverMode) => void;
  viewDeliveries: (id: string) => void;
  newEvent: (id: string) => void;
}) {
  const healthy = snapshot.endpoints.filter(
    (endpoint) => endpoint.mode === "healthy",
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="DESTINATIONS"
        title="Endpoints"
        description="Change a receiver’s behavior and follow the delivery engine’s response."
      />
      <div className="endpoint-summary">
        <span>
          <i className="healthy" />
          {healthy} healthy
        </span>
        <span>
          <i className="degraded" />
          {snapshot.endpoints.length - healthy} failure{" "}
          {snapshot.endpoints.length - healthy === 1 ? "scenario" : "scenarios"}
        </span>
        <p>
          {snapshot.endpoints.length} controlled receivers · signed delivery
        </p>
      </div>
      <div className="endpoint-grid">
        {snapshot.endpoints.map((endpoint) => {
          return (
            <article className="endpoint-card" key={endpoint.id}>
              <div className="endpoint-card-head">
                <span className={`endpoint-large-icon ${endpoint.mode}`}>
                  <Webhook size={21} />
                </span>
                <div>
                  <h2>{endpoint.name}</h2>
                  <code title={endpoint.url}>{endpoint.url}</code>
                </div>
                <ModeBadge mode={endpoint.mode} />
              </div>
              <div className="behavior-control">
                <span className="control-label">Receiver behavior</span>
                <div>
                  {receiverModes.map((mode) => (
                    <button
                      key={mode}
                      className={
                        endpoint.mode === mode ? `active behavior-${mode}` : ""
                      }
                      aria-pressed={endpoint.mode === mode}
                      disabled={busy}
                      onClick={() => setMode(endpoint.id, mode)}
                    >
                      {capitalize(mode)}
                    </button>
                  ))}
                </div>
                <p>{modeDescriptions[endpoint.mode]}</p>
              </div>
              <div className="endpoint-stats">
                <div>
                  <span>Delivery success</span>
                  <strong>
                    {endpoint.deliveries
                      ? `${((endpoint.delivered / endpoint.deliveries) * 100).toFixed(1)}%`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Accepted events</span>
                  <strong>{formatNumber(endpoint.deliveries)}</strong>
                </div>
                <div>
                  <span>Last duration</span>
                  <strong>{formatDuration(endpoint.lastDurationMs)}</strong>
                </div>
              </div>
              <div className="endpoint-card-foot">
                <button
                  className="text-button"
                  onClick={() => viewDeliveries(endpoint.id)}
                >
                  View deliveries
                  <ArrowRight size={14} />
                </button>
                <button
                  className="text-button"
                  onClick={() => newEvent(endpoint.id)}
                >
                  <Send size={14} />
                  Send test
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="sandbox-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Built-in receivers. Real reliability logic.</strong>
          <p>
            These endpoints use a controlled in-process adapter. Delivery,
            signature verification, retry state, and receiver deduplication are
            real and persisted.
          </p>
        </div>
      </div>
    </>
  );
}

function ActivityView({
  snapshot,
  select,
}: {
  snapshot: Snapshot;
  select: (id: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const filtered = snapshot.activity.filter(
    (item) =>
      filter === "all" ||
      (filter === "system"
        ? item.kind === "system"
        : filter === "failures"
          ? item.kind === "retry" || item.kind === "dead"
          : item.kind !== "system"),
  );
  let previousDay = "";
  return (
    <>
      <PageHeader
        eyebrow="AUDIT LOG"
        title="Activity"
        description="A recorded history of acceptance, delivery, retries, and engine changes."
      />
      <div className="toolbar">
        <div className="filter-tabs">
          {[
            { id: "all", label: "All activity" },
            { id: "deliveries", label: "Events" },
            { id: "failures", label: "Failures & retries" },
            { id: "system", label: "Engine changes" },
          ].map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "active" : ""}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="toolbar-note">
          Latest {snapshot.activity.length} records · local time
        </span>
      </div>
      <section className="panel activity-list">
        {!filtered.length ? (
          <EmptyState
            title="No activity here yet"
            description="Send an event or choose another activity filter."
          />
        ) : (
          filtered.map((item) => {
            const day = new Date(item.createdAt).toLocaleDateString("en-GB", {
              weekday: "long",
              month: "short",
              day: "numeric",
            });
            const heading = day !== previousDay;
            previousDay = day;
            return (
              <div key={item.id}>
                {heading && (
                  <div className="activity-day">
                    {day}
                    <span />
                  </div>
                )}
                <div className="activity-item">
                  <span
                    className={`activity-icon ${item.kind === "delivered" || item.kind === "accepted" ? "green" : item.kind === "dead" || item.kind === "retry" ? "amber" : item.kind === "system" ? "purple" : "blue"}`}
                  >
                    {item.kind === "delivered" ? (
                      <Check size={18} />
                    ) : item.kind === "retry" || item.kind === "replay" ? (
                      <RotateCcw size={18} />
                    ) : item.kind === "duplicate" ? (
                      <ShieldCheck size={18} />
                    ) : item.kind === "dead" ? (
                      <X size={18} />
                    ) : item.kind === "system" ? (
                      <GitBranch size={18} />
                    ) : (
                      <Zap size={18} />
                    )}
                  </span>
                  <div>
                    <strong>{titleForActivity[item.kind]}</strong>
                    <p>{item.message}</p>
                    {item.eventId && (
                      <button
                        className="activity-event-link"
                        onClick={() => select(item.eventId!)}
                      >
                        {item.eventId.slice(0, 22)}
                        <ArrowRight size={13} />
                      </button>
                    )}
                  </div>
                  <time title={fullDate(item.createdAt)}>
                    {relativeTime(item.createdAt, snapshot.system.now)}
                  </time>
                </div>
              </div>
            );
          })
        )}
      </section>
    </>
  );
}

function Engineering({
  snapshot,
  copy,
}: {
  snapshot: Snapshot;
  copy: (value: string) => void;
}) {
  const processor = processorStatus(snapshot.system);
  const endpointId =
    snapshot.endpoints.find((endpoint) => endpoint.mode === "healthy")?.id ||
    snapshot.endpoints[0]?.id;
  const sample = JSON.stringify(
    {
      type: "send",
      endpointId,
      eventType: "invoice.paid",
      idempotencyKey: "invoice-1042-paid",
      payload: { amount: 14900, currency: "USD" },
    },
    null,
    2,
  );
  return (
    <>
      <PageHeader
        eyebrow="SYSTEM DESIGN"
        title="Engineering"
        description="Understand the guarantees, the tradeoffs, and the boundaries of this sandbox."
      />
      <section className="panel architecture">
        <PanelHeading
          title="Event delivery lifecycle"
          description="From validated acceptance to a verified response"
        >
          <span className="subtle-badge" title={processor.description}>
            {processor.online ? "Background worker" : "Browser-driven fallback"}
          </span>
        </PanelHeading>
        <div className="architecture-flow">
          {[
            {
              name: "Accept",
              text: "Validate and persist",
              icon: Zap,
              meta: "Durable event state",
            },
            {
              name: "Queue",
              text: "Claim with a lease",
              icon: Clock3,
              meta: "Bounded processing",
            },
            {
              name: "Deliver",
              text: "Sign and verify",
              icon: Webhook,
              meta: "HMAC SHA-256",
            },
            {
              name: "Record",
              text: "Acknowledge or retry",
              icon: Check,
              meta: "Complete attempt log",
            },
          ].map((step, index) => (
            <div className="architecture-step" key={step.name}>
              <span className="step-number">0{index + 1}</span>
              <div className="step-icon">
                <step.icon size={21} />
              </div>
              <h3>{step.name}</h3>
              <p>{step.text}</p>
              <span>{step.meta}</span>
              {index < 3 && <ArrowRight size={19} className="step-arrow" />}
            </div>
          ))}
        </div>
      </section>
      <div className="engineering-grid">
        <section className="panel engineering-card">
          <span className="card-label">DELIVERY SEMANTICS</span>
          <h2>Retry safely. Apply effects once.</h2>
          <p>
            Events can be replayed with the same identity. Acceptance keys
            prevent duplicate events; receiver deduplication protects the
            business effect when delivery is repeated.
          </p>
          <div className="guarantee-stats">
            <span>
              <strong>
                {formatNumber(snapshot.metrics.duplicatesPrevented)}
              </strong>{" "}
              acceptance duplicates prevented
            </span>
            <span>
              <strong>{formatNumber(snapshot.metrics.businessEffects)}</strong>{" "}
              unique receiver effects
            </span>
          </div>
        </section>
        <section className="panel engineering-card">
          <span className="card-label">RETRY POLICY</span>
          <h2>Exponential backoff with jitter</h2>
          <p>
            Each failed attempt schedules the next eligible delivery with ±20%
            jitter. After {snapshot.system.maxAttempts} attempts, the event
            enters the dead-letter state and can be replayed.
          </p>
          <div className="retry-steps">
            {Array.from({ length: snapshot.system.maxAttempts }, (_, index) => (
              <span key={index}>
                <i />
                <strong>
                  {index === 0 ? "Initial" : `~${2 ** (index - 1)} sec`}
                </strong>
                <small>Attempt {index + 1}</small>
              </span>
            ))}
          </div>
        </section>
        <section className="panel engineering-card">
          <span className="card-label">DESIGNED BOUNDARIES</span>
          <h2>A deliberate, bounded sandbox</h2>
          <div className="system-limits">
            <div>
              <span>Event payload</span>
              <strong>12 KB</strong>
            </div>
            <div>
              <span>Receiver deadline</span>
              <strong>250 ms</strong>
            </div>
            <div>
              <span>Workspace capacity</span>
              <strong>{snapshot.system.eventLimit} events</strong>
            </div>
            <div>
              <span>Attempts per run</span>
              <strong>{snapshot.system.maxAttempts}</strong>
            </div>
          </div>
        </section>
        <section className="panel engineering-card">
          <span className="card-label">SECURITY & PERSISTENCE</span>
          <h2>Signed, scoped, and recorded</h2>
          <p>
            Every receiver envelope is signed with a workspace secret and a
            timestamp. Workspace ownership is resolved from the authenticated
            session. Immutable payloads and attempt records persist in SQLite.
          </p>
          <div className="security-points">
            <span>
              <LockKeyhole size={15} />
              Owner-scoped queries
            </span>
            <span>
              <ShieldCheck size={15} />
              Signature verification
            </span>
            <span>
              <Database size={15} />
              Durable retry state
            </span>
          </div>
        </section>
      </div>
      <div className="sandbox-note">
        <CircleHelp size={21} />
        <div>
          <strong>
            {processor.online
              ? "Background worker connected."
              : "Browser-driven fallback is active."}
          </strong>
          <p>
            {processor.online ? (
              <>
                {processor.heartbeat}. A heartbeat within 10 seconds confirms a
                worker was observed. Eligible deliveries can continue when this
                page is closed; the dashboard fetches a snapshot every 3 seconds
                while visible.
                {snapshot.system.queuePaused &&
                  " The queue is currently paused, so the worker waits for it to resume."}
              </>
            ) : (
              <>
                No fresh worker heartbeat is available. {processor.heartbeat}.
                While visible, this page requests delivery processing every 3
                seconds. A worker restores background processing once its
                heartbeat is observed within 10 seconds.
              </>
            )}{" "}
            Receivers remain local sandbox adapters. External receiver transport
            and an operational retention policy are separate deployment
            concerns.
          </p>
        </div>
      </div>
      <section className="panel api-example">
        <PanelHeading
          title="Send an event"
          description="POST /api/action · authenticated, same-origin JSON request"
        >
          <span className="subtle-badge">Your actual endpoint ID</span>
        </PanelHeading>
        <JsonBlock value={sample} copy={copy} label="Request body" />
      </section>
    </>
  );
}

export default function Home() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>("Overview");
  const [connectionError, setConnectionError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [endpointFilter, setEndpointFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [deliveryResult, setDeliveryResult] = useState<{
    query: string;
    retry: number;
    data: DeliveryPage | null;
    error: string;
  } | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [eventOpen, setEventOpen] = useState(false);
  const [eventDestination, setEventDestination] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeId = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pumping = useRef(false);
  const acting = useRef(false);
  const initialized = useRef(false);
  const snapshotRef = useRef<Snapshot | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const deliveryQuery = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    search: debouncedSearch,
    status,
    endpointId: endpointFilter,
  }).toString();
  const hasCurrentQuery = deliveryResult?.query === deliveryQuery;
  const hasCurrentResult =
    hasCurrentQuery && deliveryResult.retry === listRetry;
  const deliveryPage = hasCurrentQuery ? deliveryResult.data : null;
  const listLoading =
    view === "Deliveries" && !authRequired && !hasCurrentResult;
  const listError = hasCurrentResult ? deliveryResult.error : "";
  const toast = useCallback((message: string, error = false) => {
    const id = ++noticeId.current;
    setNotices((items) => [...items.slice(-2), { id, message, error }]);
    window.setTimeout(
      () => setNotices((items) => items.filter((item) => item.id !== id)),
      4500,
    );
  }, []);
  const updateSnapshot = useCallback((data: Snapshot) => {
    snapshotRef.current = data;
    setSnapshot(data);
    setConnectionError("");
    setAuthRequired(false);
  }, []);
  const handleConnection = useCallback((err: unknown) => {
    if (err instanceof RequestError && err.status === 401)
      setAuthRequired(true);
    setConnectionError(
      err instanceof Error ? err.message : "Unable to connect to the engine.",
    );
  }, []);
  const sync = useCallback(
    async (type: "initialize" | "pump") => {
      if (pumping.current || acting.current) return;
      pumping.current = true;
      const job = queue.current.then(() =>
        type === "pump" && snapshotRef.current?.system.processor === "worker"
          ? api<Snapshot>("/api/snapshot")
          : api<Snapshot>("/api/action", { type }),
      );
      queue.current = job.catch(() => undefined);
      try {
        updateSnapshot(await job);
      } catch (err) {
        handleConnection(err);
      } finally {
        pumping.current = false;
      }
    },
    [handleConnection, updateSnapshot],
  );
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void sync("initialize");
    }
  }, [sync]);
  useEffect(() => {
    const tick = () => {
      if (
        document.visibilityState === "visible" &&
        !authRequired &&
        !signingOut
      )
        void sync("pump");
    };
    const timer = window.setInterval(tick, 3000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [sync, authRequired, signingOut]);
  const act = useCallback(
    async (action: Action, message?: string) => {
      if (acting.current || authRequired) return false;
      acting.current = true;
      setBusy(true);
      const before = snapshotRef.current;
      const job = queue.current.then(() =>
        api<Snapshot>("/api/action", action),
      );
      queue.current = job.catch(() => undefined);
      try {
        const data = await job;
        updateSnapshot(data);
        if (action.type === "send")
          toast(
            data.metrics.duplicatesPrevented >
              (before?.metrics.duplicatesPrevented || 0)
              ? "Duplicate prevented. The original event is preserved."
              : "Event accepted. Its delivery is recorded in the timeline.",
          );
        else if (message) toast(message);
        return true;
      } catch (err) {
        if (err instanceof RequestError && err.status === 401)
          handleConnection(err);
        toast(
          err instanceof Error
            ? err.message
            : "The action could not be completed.",
          true,
        );
        return false;
      } finally {
        acting.current = false;
        setBusy(false);
      }
    },
    [authRequired, handleConnection, toast, updateSnapshot],
  );
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (view !== "Deliveries" || !snapshot || authRequired) return;
    const controller = new AbortController();
    api<DeliveryPage>(
      `/api/deliveries?${deliveryQuery}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setDeliveryResult({
          query: deliveryQuery,
          retry: listRetry,
          data,
          error: "",
        });
        if (data.totalPages > 0 && page > data.totalPages)
          setPage(data.totalPages);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setDeliveryResult((previous) => ({
          query: deliveryQuery,
          retry: listRetry,
          data: previous?.query === deliveryQuery ? previous.data : null,
          error:
            err instanceof Error ? err.message : "Unable to load deliveries.",
        }));
        if (err instanceof RequestError && err.status === 401)
          handleConnection(err);
      });
    return () => controller.abort();
  }, [
    view,
    snapshot,
    authRequired,
    page,
    deliveryQuery,
    listRetry,
    handleConnection,
  ]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const update = () => {
      setIsMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const overflow = document.body.style.overflow;
    const menuButton = menuRef.current;
    document.body.style.overflow = "hidden";
    sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
      if (event.key !== "Tab") return;
      const items = sidebarRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href]",
      );
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handler);
      if (window.matchMedia("(max-width: 980px)").matches) menuButton?.focus();
    };
  }, [isMobile, mobileOpen]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !eventOpen &&
        !selected &&
        !mobileOpen
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [eventOpen, selected, mobileOpen]);
  const go = (next: View) => {
    setView(next);
    setMobileOpen(false);
    if (next !== "Deliveries") {
      setSearch("");
      setStatus("all");
      setEndpointFilter("all");
      setPage(1);
    }
  };
  const showEndpointDeliveries = (id: string) => {
    setSelected(null);
    setEndpointFilter(id);
    setStatus("all");
    setSearch("");
    setPage(1);
    setView("Deliveries");
    setMobileOpen(false);
  };
  const closeEvent = useCallback(() => {
    setEventOpen(false);
    setEventDestination(null);
  }, []);
  const closeDetail = useCallback(() => setSelected(null), []);
  const createEvent = (id?: string) => {
    setEventDestination(id || null);
    setEventOpen(true);
  };
  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast("Copied to clipboard.");
      } catch {
        toast("Clipboard unavailable. You can select and copy the text.", true);
      }
    },
    [toast],
  );
  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await queue.current;
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error("Could not sign out. Please try again.");
      router.replace("/login");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not sign out.", true);
      setSigningOut(false);
    }
  };
  const email = snapshot?.user?.email || "";
  const accountLabel = email ? email.split("@")[0] : "Your account";
  const initials = accountLabel.slice(0, 2).toUpperCase();
  const processor = snapshot ? processorStatus(snapshot.system) : null;
  const pageRows = deliveryPage?.deliveries || [];
  const initialEmpty =
    view === "Deliveries" &&
    snapshot?.metrics.total === 0 &&
    !search &&
    status === "all" &&
    endpointFilter === "all";
  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <AnimatePresence>
          {mobileOpen && (
            <motion.button
              className="mobile-overlay"
              aria-label="Close navigation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
          )}
        </AnimatePresence>
        <aside
          ref={sidebarRef}
          className={`sidebar ${mobileOpen ? "is-open" : ""}`}
          id="workspace-navigation"
          inert={Boolean((isMobile && !mobileOpen) || eventOpen || selected)}
          aria-hidden={
            (isMobile && !mobileOpen) || eventOpen || selected
              ? true
              : undefined
          }
          role={isMobile && mobileOpen ? "dialog" : undefined}
          aria-modal={isMobile && mobileOpen ? true : undefined}
          aria-label="Workspace navigation"
        >
          <div className="sidebar-logo">
            <button
              className="logo-home"
              onClick={() => go("Overview")}
              aria-label="RelayForge overview"
            >
              <Logo />
            </button>
            <button
              className="icon-button mobile-close"
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation"
            >
              <X size={20} />
            </button>
          </div>
          <div className="workspace-mini">
            <span className="workspace-icon">R</span>
            <div>
              <strong>Personal workspace</strong>
              <small>Reliability sandbox</small>
            </div>
            <span className="workspace-environment">LAB</span>
          </div>
          <nav aria-label="Main navigation">
            <span className="nav-label">Workspace</span>
            {navigation.slice(0, 4).map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={`nav-item ${view === name ? "active" : ""}`}
                aria-current={view === name ? "page" : undefined}
                onClick={() => go(name)}
              >
                <Icon size={19} />
                <span>{name}</span>
                {name === "Deliveries" &&
                  snapshot &&
                  snapshot.metrics.dead > 0 && <b>{snapshot.metrics.dead}</b>}
              </button>
            ))}
            <span className="nav-label second">Build</span>
            <button
              className={`nav-item ${view === "Engineering" ? "active" : ""}`}
              aria-current={view === "Engineering" ? "page" : undefined}
              onClick={() => go("Engineering")}
            >
              <Code2 size={19} />
              <span>Engineering</span>
            </button>
          </nav>
          <div className="sidebar-bottom">
            <div className="sandbox-capacity">
              <div>
                <span>Sandbox events</span>
                <b>
                  {snapshot
                    ? `${formatNumber(snapshot.metrics.total)} / ${snapshot.system.eventLimit}`
                    : "—"}
                </b>
              </div>
              <div className="capacity-track">
                <span
                  style={{
                    width: `${snapshot ? Math.min(100, (snapshot.metrics.total / snapshot.system.eventLimit) * 100) : 0}%`,
                  }}
                />
              </div>
              <p title={processor?.description}>
                {connectionError
                  ? "Connection interrupted"
                  : processor?.online
                    ? `Worker ${processor.heartbeat.toLowerCase()}`
                    : processor
                      ? "Worker offline · browser fallback"
                      : "Connecting to the engine…"}
              </p>
              <button onClick={() => go("Engineering")}>
                <CircleHelp size={14} />
                Explore the architecture
                <ArrowRight size={13} />
              </button>
            </div>
            <div className="profile">
              <span className="avatar">{initials}</span>
              <div>
                <strong title={accountLabel}>{accountLabel}</strong>
                <small title={email}>
                  {email || "Connecting to your workspace…"}
                </small>
              </div>
            </div>
            {snapshot && (
              <button
                className="signout-button"
                onClick={signOut}
                disabled={signingOut}
              >
                {signingOut ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <LogOut size={17} />
                )}
                <span>{signingOut ? "Signing out…" : "Sign out"}</span>
              </button>
            )}
          </div>
        </aside>
        <div
          className="main-column"
          inert={Boolean((isMobile && mobileOpen) || eventOpen || selected)}
        >
          <header className="topbar">
            <button
              ref={menuRef}
              className="icon-button menu-button"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              aria-controls="workspace-navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={21} />
            </button>
            <div className="topbar-title">
              <span>{view}</span>
              <small>Reliability sandbox</small>
            </div>
            <label className="global-search">
              <Search size={17} />
              <input
                ref={searchRef}
                value={search}
                maxLength={100}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                  if (view !== "Deliveries") {
                    setView("Deliveries");
                    setStatus("all");
                    setEndpointFilter("all");
                  }
                }}
                placeholder="Search events, IDs, endpoints…"
                aria-label="Search deliveries"
              />
              <kbd>/</kbd>
            </label>
            <span
              className={`engine-indicator ${connectionError ? "disconnected" : snapshot?.system.queuePaused || (processor && !processor.online) ? "paused" : ""}`}
              title={processor?.description}
              role="status"
            >
              <i />
              {connectionError
                ? "Disconnected"
                : snapshot?.system.queuePaused
                  ? "Queue paused"
                  : processor?.online
                    ? "Worker online"
                    : processor
                      ? "Browser fallback"
                      : "Connecting"}
            </span>
            <Button
              className="new-event-button"
              onClick={() => createEvent()}
              disabled={!snapshot || busy || authRequired}
              aria-label="Send a new event"
            >
              <Plus size={17} />
              <span>New event</span>
            </Button>
          </header>
          <main className="content">
            {connectionError && (
              <div className="notice error" role="alert">
                <Radio size={20} />
                <span>
                  <strong>
                    {authRequired
                      ? "Sign in to continue"
                      : "Connection interrupted"}
                  </strong>
                  {connectionError}
                </span>
                {authRequired ? (
                  <a
                    className="button button-secondary"
                    href="/login?returnTo=%2F"
                  >
                    Sign in
                    <ArrowRight size={15} />
                  </a>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => sync("initialize")}
                  >
                    <RotateCcw size={15} />
                    Reconnect
                  </Button>
                )}
              </div>
            )}
            {!snapshot ? (
              <div className="workspace-loading">
                <Logo />
                <h1>
                  {authRequired
                    ? "Your workspace is waiting."
                    : connectionError
                      ? "The engine is temporarily unavailable."
                      : "Preparing your workspace…"}
                </h1>
                <p>
                  {authRequired
                    ? "Sign in to view your delivery pipeline."
                    : connectionError
                      ? "Reconnect to load your persisted events."
                      : "Connecting to the event delivery engine."}
                </p>
                {!connectionError && (
                  <LoaderCircle className="spin" size={23} />
                )}
                {authRequired && (
                  <a
                    href="/login?returnTo=%2F"
                    className="button button-primary"
                  >
                    Sign in to RelayForge
                    <ArrowRight size={16} />
                  </a>
                )}
              </div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div
                  key={view}
                  initial={{ opacity: 0, y: 7 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={{ duration: 0.18 }}
                >
                  {snapshot.system.queuePaused && view !== "Engineering" && (
                    <div className="notice warning">
                      <Pause size={19} />
                      <span>
                        <strong>Delivery queue paused</strong>New events remain
                        persisted until you resume processing.
                      </span>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          act(
                            { type: "pause", paused: false },
                            "Queue processing resumed.",
                          )
                        }
                      >
                        <Play size={15} />
                        Resume
                      </Button>
                    </div>
                  )}
                  {view === "Overview" && (
                    <Overview
                      snapshot={snapshot}
                      demo={() =>
                        act(
                          { type: "demo" },
                          "Demo accepted. Watch the delivery engine work.",
                        )
                      }
                      busy={busy}
                      go={go}
                      select={setSelected}
                    />
                  )}
                  {view === "Deliveries" && (
                    <>
                      <PageHeader
                        eyebrow="EVENT PIPELINE"
                        title="Deliveries"
                        description="Inspect every attempt from acceptance to final acknowledgement."
                      >
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            act(
                              {
                                type: "pause",
                                paused: !snapshot.system.queuePaused,
                              },
                              snapshot.system.queuePaused
                                ? "Queue processing resumed."
                                : "Queue processing paused.",
                            )
                          }
                        >
                          {snapshot.system.queuePaused ? (
                            <Play size={16} />
                          ) : (
                            <Pause size={16} />
                          )}
                          {snapshot.system.queuePaused
                            ? "Resume queue"
                            : "Pause queue"}
                        </Button>
                      </PageHeader>
                      <div className="toolbar deliveries-toolbar">
                        <label className="toolbar-search">
                          <Search size={17} />
                          <input
                            value={search}
                            onChange={(event) => {
                              setSearch(event.target.value);
                              setPage(1);
                            }}
                            placeholder="Search event type or ID…"
                            aria-label="Filter deliveries by event, ID or endpoint"
                            maxLength={100}
                          />
                        </label>
                        <div className="filter-tabs">
                          {[
                            { id: "all", label: "All" },
                            { id: "delivered", label: "Delivered" },
                            { id: "retrying", label: "Retrying" },
                            { id: "dead", label: "Failed" },
                            { id: "pending", label: "Queued" },
                          ].map((item) => (
                            <button
                              key={item.id}
                              className={status === item.id ? "active" : ""}
                              aria-pressed={status === item.id}
                              onClick={() => {
                                setStatus(item.id as StatusFilter);
                                setPage(1);
                              }}
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                        <label className="filter-select">
                          <span className="sr-only">
                            Filter destination endpoint
                          </span>
                          <select
                            value={endpointFilter}
                            onChange={(event) => {
                              setEndpointFilter(event.target.value);
                              setPage(1);
                            }}
                          >
                            <option value="all">All endpoints</option>
                            {snapshot.endpoints.map((endpoint) => (
                              <option key={endpoint.id} value={endpoint.id}>
                                {endpoint.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={15} />
                        </label>
                      </div>
                      {listError && (
                        <div className="notice error" role="alert">
                          <span>{listError}</span>
                          <Button
                            variant="secondary"
                            onClick={() => setListRetry((value) => value + 1)}
                          >
                            <RotateCcw size={15} />
                            Retry
                          </Button>
                        </div>
                      )}
                      <section className="panel table-panel">
                        <div className="delivery-list-head">
                          <span>
                            <i className="live-dot" />
                            {listLoading
                              ? "Syncing delivery records"
                              : "Live delivery records"}
                          </span>
                          <label>
                            Rows
                            <span className="select-wrap">
                              <select
                                value={pageSize}
                                aria-label="Deliveries per page"
                                onChange={(event) => {
                                  setPageSize(Number(event.target.value));
                                  setPage(1);
                                }}
                              >
                                <option value={10}>10</option>
                                <option value={20}>20</option>
                                <option value={50}>50</option>
                              </select>
                              <ChevronDown size={13} />
                            </span>
                          </label>
                        </div>
                        {!deliveryPage && listLoading ? (
                          <div className="list-loading">
                            <LoaderCircle size={23} className="spin" />
                            <span>Loading deliveries…</span>
                          </div>
                        ) : (
                          <DeliveryTable
                            rows={pageRows}
                            onSelect={setSelected}
                            now={snapshot.system.now}
                            maxAttempts={snapshot.system.maxAttempts}
                            expanded
                            loading={listLoading}
                            emptyAction={
                              initialEmpty ? (
                                <Button
                                  variant="secondary"
                                  onClick={() =>
                                    act(
                                      { type: "demo" },
                                      "Demo events accepted.",
                                    )
                                  }
                                  disabled={busy}
                                >
                                  <Play size={15} />
                                  Run live demo
                                </Button>
                              ) : undefined
                            }
                          />
                        )}
                      </section>
                      <Pagination
                        page={deliveryPage?.page || page}
                        pageSize={pageSize}
                        total={deliveryPage?.total || 0}
                        totalPages={deliveryPage?.totalPages || 1}
                        loading={listLoading}
                        onPage={setPage}
                      />
                    </>
                  )}
                  {view === "Endpoints" && (
                    <Endpoints
                      snapshot={snapshot}
                      busy={busy}
                      setMode={(endpointId, mode) =>
                        act(
                          { type: "set-receiver", endpointId, mode },
                          `Receiver behavior changed to ${mode}.`,
                        )
                      }
                      viewDeliveries={showEndpointDeliveries}
                      newEvent={createEvent}
                    />
                  )}
                  {view === "Activity" && (
                    <ActivityView snapshot={snapshot} select={setSelected} />
                  )}
                  {view === "Engineering" && (
                    <Engineering snapshot={snapshot} copy={copy} />
                  )}
                  <footer className="workspace-footer">
                    <span>RelayForge · Reliability sandbox</span>
                    <span title={processor?.description}>
                      <i className="live-dot" />
                      {connectionError
                        ? "Connection interrupted"
                        : snapshot.system.queuePaused
                          ? "Queue paused"
                          : processor?.online
                            ? `Worker ${processor.heartbeat.toLowerCase()}`
                            : "Worker offline · browser-driven fallback"}
                    </span>
                  </footer>
                </motion.div>
              </AnimatePresence>
            )}
          </main>
        </div>
        <AnimatePresence>
          {eventOpen && snapshot && (
            <EventForm
              key={eventDestination || "event"}
              endpoints={snapshot.endpoints}
              initialEndpointId={eventDestination}
              onClose={closeEvent}
              send={(action) => act(action)}
              busy={busy}
            />
          )}
          {selected && snapshot && (
            <DeliveryDrawer
              id={selected}
              version={snapshot.system.now}
              maxAttempts={snapshot.system.maxAttempts}
              close={closeDetail}
              replay={() =>
                act(
                  { type: "replay", eventId: selected },
                  "Original event replayed. Receiver effects are protected.",
                )
              }
              busy={busy}
              viewEndpoint={() => {
                setSelected(null);
                go("Endpoints");
              }}
              copy={copy}
            />
          )}
        </AnimatePresence>
        <div className="toast-stack" aria-live="polite">
          <AnimatePresence>
            {notices.map((notice) => (
              <motion.div
                className={`toast ${notice.error ? "toast-error" : ""}`}
                key={notice.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 15 }}
              >
                <span className="toast-symbol">
                  {notice.error ? <X size={16} /> : <Check size={16} />}
                </span>
                <p>{notice.message}</p>
                <button
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() =>
                    setNotices((items) =>
                      items.filter((item) => item.id !== notice.id),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  );
}
