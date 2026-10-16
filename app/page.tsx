"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  Activity as ActivityIcon,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Database,
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
  Wrench,
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
  type ReactNode,
} from "react";
import type {
  Action,
  DeliveryDetail,
  DeliveryPage,
  ReplayBatchRequest,
  ReplayBatchResponse,
  Snapshot,
  SecurityAction,
  SecuritySnapshot,
  SecurityMutationResponse,
  AuditPage,
} from "@/lib/contracts";
import {
  Button,
  CloseButton,
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
} from "./components/relay-ui";
import { RecoveryPanel } from "./components/recovery-panel";
import { SecurityCenter } from "./components/security-center";
import { AuditExplorer } from "./components/audit-explorer";
import { CommandPalette } from "./components/command-palette";
import {
  ConnectionsPanel,
  TransportBadge,
} from "./components/connections-panel";
import { IntegrationStudio } from "./components/integration-studio";
import { ProducerKeyPanel } from "./components/producer-key-panel";
import { ProductOverview } from "./components/product-overview";
import { api, isSessionError } from "@/lib/client-api";
import {
  navigationForView,
  parseNavigation,
  serializeNavigation,
  type NavigationState,
  type NavigationView,
} from "@/lib/navigation";

type View =
  | "Overview"
  | "Deliveries"
  | "Recovery"
  | "Endpoints"
  | "Studio"
  | "Activity"
  | "Engineering"
  | "Security";
type Notice = { id: number; message: string; error?: boolean };
const navigation = [
  {
    name: "Overview",
    label: "Overview",
    icon: LayoutDashboard,
    group: "Operate",
  },
  { name: "Deliveries", label: "Deliveries", icon: Layers3, group: "Operate" },
  { name: "Recovery", label: "Recovery", icon: Wrench, group: "Operate" },
  { name: "Endpoints", label: "Connections", icon: Webhook, group: "Build" },
  { name: "Studio", label: "Integration Studio", icon: Send, group: "Build" },
  { name: "Engineering", label: "Engineering", icon: Code2, group: "Build" },
  { name: "Activity", label: "Activity", icon: ActivityIcon, group: "Manage" },
  { name: "Security", label: "Security", icon: ShieldCheck, group: "Manage" },
] as const;
const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
const loadRecoveryPage = (query: string, signal: AbortSignal) =>
  api<DeliveryPage>(`/api/deliveries?${query}`, undefined, signal);
const loadSecurity = (signal: AbortSignal) =>
  api<SecuritySnapshot>("/api/security", undefined, signal);
const loadAudit = (query: string, signal: AbortSignal) =>
  api<AuditPage>(`/api/audit?${query}`, undefined, signal);
const loadCommandResults = (search: string, signal: AbortSignal) =>
  api<DeliveryPage>(
    `/api/deliveries?${new URLSearchParams({
      page: "1",
      pageSize: "6",
      search,
      status: "all",
      endpointId: "all",
    })}`,
    undefined,
    signal,
  );

function processorStatus(system: Snapshot["system"]) {
  const online = system.processor === "worker";
  const lastHeartbeatAt = system.worker?.lastHeartbeatAt ?? null;
  const heartbeat =
    lastHeartbeatAt === null
      ? "No worker heartbeat recorded"
      : `Heartbeat ${relativeTime(lastHeartbeatAt, system.now).toLowerCase()}`;
  const description = online
    ? `${heartbeat}. Background delivery runs independently of this page.`
    : `${lastHeartbeatAt === null ? "No fresh worker heartbeat is available." : "The last worker heartbeat is stale."} Live events wait in the queue. The visible page can process lab events every 3 seconds.`;
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

function DeliveryDrawer({
  id,
  version,
  maxAttempts,
  close,
  replay,
  viewEndpoint,
  recoveryEndpointIds,
  openRecovery,
  busy,
  copy,
  href,
}: {
  href: string;
  id: string;
  version: number;
  maxAttempts: number;
  close: () => void;
  replay: (eventId: string, expectedCycle: number) => void;
  viewEndpoint: (id: string) => void;
  recoveryEndpointIds: string[];
  openRecovery: () => void;
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
  const managed = Boolean(
    event && recoveryEndpointIds.includes(event.endpointId),
  );
  const last =
    detail?.attempts
      .filter((attempt) => attempt.cycle === event?.currentCycle)
      .at(-1) ??
    (event && event.attempts > 0 && event.latestAttempt?.cycle === null
      ? detail?.attempts.filter((attempt) => attempt.cycle === null).at(-1)
      : undefined);
  const attemptGroups = Array.from(
    (detail?.attempts ?? []).reduce((groups, attempt) => {
      const key = attempt.cycle;
      groups.set(key, [...(groups.get(key) ?? []), attempt]);
      return groups;
    }, new Map<number | null, DeliveryDetail["attempts"]>()),
  ).sort(([a], [b]) => (b ?? 0) - (a ?? 0));
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
          durationMs: last.finishedAt == null ? null : last.durationMs,
          error: last.error,
          failureCode: last.failureCode,
          signingKeyIds: last.signingKeyIds,
          connectionRevision: last.connectionRevision,
          startedAt: new Date(last.createdAt).toISOString(),
          finishedAt: last.finishedAt
            ? new Date(last.finishedAt).toISOString()
            : null,
        }
      : { message: "No attempt has been recorded in the current cycle yet." },
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
            <StatusBadge status={event.status} transport={event.transport} />
            <TransportBadge endpoint={event} />
            <time title={fullDate(event.createdAt)}>
              Created {relativeTime(event.createdAt, version)}
            </time>
          </div>
          <div className="drawer-actions">
            <a
              href={href}
              className="button button-secondary"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ArrowRight size={15} />
              Open event link
            </a>
            {managed ? (
              <Button onClick={openRecovery}>
                <Wrench size={16} /> Open recovery guide
              </Button>
            ) : (
              (event.status === "dead" || event.status === "delivered") && (
                <Button
                  onClick={() => replay(event.id, event.currentCycle)}
                  disabled={busy}
                >
                  <RotateCcw size={16} />
                  Replay event
                </Button>
              )
            )}
            <Button
              variant="secondary"
              onClick={() => viewEndpoint(event.endpointId)}
            >
              <Webhook size={16} />
              View connection
            </Button>
          </div>
          {event.status === "delivered" && (
            <p className="drawer-replay-note">
              <ShieldCheck size={14} />
              {event.transport === "demo"
                ? "Replaying preserves the event ID. Lab receiver effects remain deduplicated."
                : "The receiver acknowledged this event. Replaying preserves its ID; remote business effects depend on your receiver’s idempotency handling."}
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
                <span>Attempts this cycle</span>
                <strong>
                  {event.attempts} of {maxAttempts}
                </strong>
                <small className="drawer-cycle-label">
                  {event.currentCycle === 1
                    ? "Initial delivery"
                    : `Replay ${event.currentCycle - 1}`}
                </small>
              </div>
              <div>
                <span>Last result</span>
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
                      : last?.failureCode
                        ? "Network failure"
                        : "Not recorded")}
                </strong>
              </div>
              <div>
                <span>Last duration</span>
                <strong>
                  {last?.finishedAt == null
                    ? "—"
                    : formatDuration(last.durationMs)}
                </strong>
              </div>
            </div>
            {event.transport !== "demo" && (
              <div className="rf-config-note">
                <ShieldCheck size={17} />
                <div>
                  <strong>
                    {event.status === "delivered"
                      ? "Acknowledged by the receiver"
                      : "Signed HTTP delivery"}
                  </strong>
                  {event.status === "delivered"
                    ? "HTTP success confirms acknowledgement. RelayForge cannot verify a remote application’s business effect."
                    : "A real HTTP response or network failure is recorded for every completed attempt."}
                  {last?.failureCode && (
                    <>
                      <br />
                      Failure category: <code>{last.failureCode}</code>
                    </>
                  )}
                  {Boolean(last?.signingKeyIds.length) && (
                    <>
                      <br />
                      Signing key IDs:{" "}
                      <code>{last?.signingKeyIds.join(", ")}</code>
                    </>
                  )}
                  {last?.connectionRevision !== null &&
                    last?.connectionRevision !== undefined && (
                      <>
                        <br />
                        Connection revision: {last.connectionRevision}
                      </>
                    )}
                </div>
              </div>
            )}
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
              attemptGroups.map(([cycle, attempts]) => (
                <div className="attempt-cycle-group" key={cycle ?? "legacy"}>
                  <div className="attempt-cycle-heading">
                    <h4>
                      {cycle == null
                        ? "Legacy history"
                        : cycle === 1
                          ? "Initial delivery"
                          : `Replay ${cycle - 1}`}
                    </h4>
                    <span>
                      {attempts.length}{" "}
                      {attempts.length === 1 ? "attempt" : "attempts"}
                    </span>
                  </div>
                  {cycle == null && (
                    <p className="legacy-attempt-note">
                      Recorded before cycle tracking. Original history
                      preserved.
                    </p>
                  )}
                  {attempts
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
                                          : attempt.failureCode
                                            ? "Network delivery failed"
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
                                    (inProgress
                                      ? "WORKING"
                                      : attempt.failureCode
                                        ? "NETWORK"
                                        : "INTERRUPTED")}
                                </b>
                                <time title={fullDate(attempt.createdAt)}>
                                  {formatTime(attempt.createdAt)}
                                </time>
                              </span>
                              <ChevronDown
                                size={15}
                                className={
                                  expanded === attempt.id ? "rotated" : ""
                                }
                              />
                            </button>
                            {expanded === attempt.id && (
                              <div className="attempt-extra">
                                <p>
                                  {attempt.error ||
                                    (inProgress
                                      ? "The processor has claimed this event. The response has not been recorded yet."
                                      : "The receiver acknowledged the signed request.")}
                                </p>
                                <span>
                                  Duration:{" "}
                                  {inProgress
                                    ? "In progress"
                                    : formatDuration(attempt.durationMs)}
                                </span>
                                {attempt.failureCode && (
                                  <span>
                                    Failure category:{" "}
                                    <code>{attempt.failureCode}</code>
                                  </span>
                                )}
                                {attempt.signingKeyIds.length > 0 && (
                                  <span>
                                    Signing key IDs:{" "}
                                    <code>
                                      {attempt.signingKeyIds.join(", ")}
                                    </code>
                                  </span>
                                )}
                                {attempt.connectionRevision !== null && (
                                  <span>
                                    Connection revision:{" "}
                                    {attempt.connectionRevision}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </Dialog>
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
        description="Understand the delivery guarantees, operational boundaries, and security decisions."
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
          <h2>Stable identity. Honest guarantees.</h2>
          <p>
            Events can be replayed with the same identity. Acceptance keys
            prevent duplicate events. The Lab and reference receiver deduplicate
            effects. External receivers must implement their own deduplication;
            a successful HTTP response confirms acknowledgement.
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
              verified lab receiver effects
            </span>
          </div>
        </section>
        <section className="panel engineering-card">
          <span className="card-label">RETRY POLICY</span>
          <h2>Exponential backoff with jitter</h2>
          <p>
            Retryable failures schedule the next eligible delivery with ±20%
            jitter. Live transport retries network failures, HTTP 408, 429, and
            5xx; other non-success responses are terminal. After{" "}
            {snapshot.system.maxAttempts} attempts, the event enters the
            dead-letter state and can be replayed.
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
          <h2>Explicit operational boundaries</h2>
          <div className="system-limits">
            <div>
              <span>Event payload</span>
              <strong>12 KB</strong>
            </div>
            <div>
              <span>Receiver deadline</span>
              <strong>5 seconds live</strong>
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
            Live connections use individual HMAC signing keys encrypted at rest.
            HTTPS destinations are checked against the operator’s allowed hosts
            and resolved public addresses before every attempt. Producer keys
            are scoped to one connection; immutable payloads and history persist
            in SQLite.
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
                While visible, this page can process lab deliveries every 3
                seconds. Live events stay queued until a worker restores
                background processing and its heartbeat is observed within 10
                seconds.
              </>
            )}{" "}
            Live transport runs only in the worker. Queue pause applies to both
            live connections and lab receivers.
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
  const [urlState, setUrlState] = useState<NavigationState>(() =>
    navigationForView(),
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandPresented, setCommandPresented] = useState(false);
  const commandPresentedRef = useRef(false);
  const commandOpenerRef = useRef<HTMLElement | null>(null);
  const pendingCommandNavigation = useRef<{
    state: NavigationState;
    replace: boolean;
  } | null>(null);
  const navigationRef = useRef(urlState);
  const changeNavigation = useCallback(
    (patch: Partial<NavigationState>, replace = false) => {
      const next = parseNavigation(
        serializeNavigation({ ...navigationRef.current, ...patch }).slice(2),
      );
      const destination = serializeNavigation(next);
      navigationRef.current = next;
      setUrlState(next);
      if (
        `${window.location.pathname}${window.location.search}` !== destination
      ) {
        if (replace) window.history.replaceState(null, "", destination);
        else window.history.pushState(null, "", destination);
      }
    },
    [],
  );
  useEffect(() => {
    const restore = () => {
      const next = parseNavigation(window.location.search);
      if (commandPresentedRef.current) {
        pendingCommandNavigation.current = { state: next, replace: true };
        setCommandOpen(false);
        return;
      }
      navigationRef.current = next;
      setUrlState(next);
      const destination = serializeNavigation(next);
      if (
        `${window.location.pathname}${window.location.search}` !== destination
      )
        window.history.replaceState(null, "", destination);
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const view = capitalize(urlState.view) as View;
  const page = urlState.page;
  const pageSize = urlState.size;
  const status = urlState.status;
  const endpointFilter = urlState.endpoint;
  const selected = urlState.event;
  const setSelected = useCallback(
    (event: string | null) => changeNavigation({ event }),
    [changeNavigation],
  );
  const hrefForEvent = useCallback(
    (event: string) => serializeNavigation({ ...urlState, event }),
    [urlState],
  );
  const setPage = useCallback(
    (page: number) => changeNavigation({ page }),
    [changeNavigation],
  );
  const [connectionError, setConnectionError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [search, setSearch] = useState("");
  const searchKey = `${urlState.view}:${urlState.q}`;
  const [searchSource, setSearchSource] = useState(searchKey);
  if (searchSource !== searchKey) {
    setSearchSource(searchKey);
    setSearch(urlState.q);
  }
  const [deliveryResult, setDeliveryResult] = useState<{
    query: string;
    retry: number;
    data: DeliveryPage | null;
    error: string;
  } | null>(null);
  const [listRetry, setListRetry] = useState(0);
  const [recoveryDialogOpen, setRecoveryDialogOpen] = useState(false);
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
    search: urlState.q,
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
    if (isSessionError(err)) {
      setAuthRequired(true);
      pendingCommandNavigation.current = null;
      setCommandOpen(false);
    }
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
        if (isSessionError(err)) handleConnection(err);
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
  const replayBatch = useCallback(
    async (request: ReplayBatchRequest) => {
      if (acting.current || authRequired) return null;
      acting.current = true;
      setBusy(true);
      const job = queue.current.then(() =>
        api<ReplayBatchResponse>("/api/recovery/replay", request),
      );
      queue.current = job.catch(() => undefined);
      try {
        const data = await job;
        updateSnapshot(data.snapshot);
        return data;
      } catch (err) {
        if (isSessionError(err)) handleConnection(err);
        toast(
          err instanceof Error
            ? err.message
            : "The selected events could not be replayed.",
          true,
        );
        return null;
      } finally {
        acting.current = false;
        setBusy(false);
      }
    },
    [authRequired, handleConnection, toast, updateSnapshot],
  );
  const securityMutate = useCallback(
    async (action: SecurityAction): Promise<SecurityMutationResponse> => {
      if (acting.current || authRequired)
        throw new Error("Please wait for the current action to finish.");
      acting.current = true;
      setBusy(true);
      const job = queue.current.then(() =>
        api<SecurityMutationResponse>("/api/security", action),
      );
      queue.current = job.catch(() => undefined);
      try {
        return await job;
      } catch (error) {
        if (isSessionError(error)) handleConnection(error);
        throw error;
      } finally {
        acting.current = false;
        setBusy(false);
      }
    },
    [authRequired, handleConnection],
  );
  const handleRecoveryConnection = useCallback(
    (err: unknown) => {
      if (isSessionError(err)) handleConnection(err);
    },
    [handleConnection],
  );
  const loadCommands = useCallback(
    async (search: string, signal: AbortSignal) => {
      try {
        return await loadCommandResults(search, signal);
      } catch (error) {
        if (!signal.aborted && isSessionError(error)) handleConnection(error);
        throw error;
      }
    },
    [handleConnection],
  );
  useEffect(() => {
    if (view !== "Deliveries" || search.trim() === urlState.q) return;
    const timer = window.setTimeout(
      () => changeNavigation({ q: search.trim(), page: 1 }, true),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search, view, urlState.q, changeNavigation]);
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
        if (isSessionError(err)) handleConnection(err);
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
    setPage,
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
      const target = event.target instanceof HTMLElement ? event.target : null;
      const protectedInput = target?.closest(
        'input[type="password"], input[autocomplete="current-password"], input[autocomplete="new-password"], [contenteditable="true"], [role="dialog"]',
      );
      if (
        event.key.toLowerCase() === "k" &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.repeat &&
        !event.isComposing &&
        !protectedInput &&
        !target?.isContentEditable &&
        snapshot &&
        !selected &&
        !recoveryDialogOpen &&
        !mobileOpen &&
        !commandPresented &&
        !authRequired &&
        !busy &&
        !signingOut &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        pendingCommandNavigation.current = null;
        commandOpenerRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        commandPresentedRef.current = true;
        setCommandPresented(true);
        setCommandOpen(true);
        return;
      }
      if (
        event.key === "/" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !selected &&
        !recoveryDialogOpen &&
        !mobileOpen &&
        !commandPresented &&
        !event.isComposing &&
        !event.repeat &&
        !target?.isContentEditable
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    selected,
    mobileOpen,
    recoveryDialogOpen,
    commandPresented,
    authRequired,
    busy,
    signingOut,
    snapshot,
  ]);
  const openCommandPalette = () => {
    if (
      !snapshot ||
      selected ||
      recoveryDialogOpen ||
      mobileOpen ||
      commandPresented ||
      authRequired ||
      busy ||
      signingOut ||
      document.querySelector('[role="dialog"]')
    )
      return;
    pendingCommandNavigation.current = null;
    commandOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    commandPresentedRef.current = true;
    setCommandPresented(true);
    setCommandOpen(true);
  };
  const closeCommandPalette = useCallback(() => {
    pendingCommandNavigation.current = null;
    setCommandOpen(false);
  }, []);
  const navigateFromCommand = useCallback((state: NavigationState) => {
    pendingCommandNavigation.current = { state, replace: false };
    setCommandOpen(false);
  }, []);
  const commandExitComplete = useCallback(() => {
    commandPresentedRef.current = false;
    setCommandPresented(false);
    const destination = pendingCommandNavigation.current;
    pendingCommandNavigation.current = null;
    if (destination) changeNavigation(destination.state, destination.replace);
    if (!destination?.state.event) {
      const opener = commandOpenerRef.current;
      window.requestAnimationFrame(() => opener?.focus());
    }
  }, [changeNavigation]);
  const go = (next: View) => {
    changeNavigation({
      ...navigationForView(next.toLowerCase() as NavigationView),
      scope: urlState.scope,
    });
    setMobileOpen(false);
  };
  const showEndpointDeliveries = (id: string) => {
    changeNavigation({
      ...navigationForView("deliveries"),
      scope: urlState.scope,
      endpoint: id,
    });
    setMobileOpen(false);
  };
  const closeDetail = useCallback(() => setSelected(null), [setSelected]);
  const createEvent = (id?: string) => {
    changeNavigation({
      ...navigationForView("studio"),
      scope: urlState.scope,
      endpoint: id || "all",
    });
    setMobileOpen(false);
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
      await api("/api/auth/logout", {});
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
  const hasModal = Boolean(
    commandPresented ||
    (snapshot && !authRequired && (selected || recoveryDialogOpen)),
  );
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
          inert={Boolean((isMobile && !mobileOpen) || hasModal)}
          aria-hidden={(isMobile && !mobileOpen) || hasModal ? true : undefined}
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
              <small>Webhook delivery platform</small>
            </div>
            <span className="workspace-environment">2.0</span>
          </div>
          <nav aria-label="Main navigation">
            {(["Operate", "Build", "Manage"] as const).map((group) => (
              <div className="rf-navigation-group" key={group}>
                <span className="nav-label">{group}</span>
                {navigation
                  .filter((item) => item.group === group)
                  .map(({ name, label, icon: Icon }) => (
                    <button
                      key={name}
                      className={`nav-item ${view === name ? "active" : ""}`}
                      aria-current={view === name ? "page" : undefined}
                      onClick={() => go(name)}
                    >
                      <Icon size={19} />
                      <span>{label}</span>
                      {name === "Recovery" &&
                        snapshot &&
                        snapshot.metrics.dead > 0 && (
                          <b>{snapshot.metrics.dead}</b>
                        )}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sandbox-capacity">
              <div>
                <span>Workspace events</span>
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
                      ? "Worker offline · live events queued"
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
          inert={Boolean((isMobile && mobileOpen) || hasModal)}
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
              <span>
                {view === "Endpoints"
                  ? "Connections"
                  : view === "Studio"
                    ? "Integration Studio"
                    : view}
              </span>
              <small>Webhook delivery platform</small>
            </div>
            <label className="global-search">
              <Search size={17} />
              <input
                ref={searchRef}
                value={search}
                maxLength={100}
                onChange={(event) => {
                  const value = event.target.value;
                  if (view !== "Deliveries")
                    changeNavigation(
                      { ...navigationForView("deliveries"), q: value },
                      true,
                    );
                  setSearch(value);
                }}
                placeholder="Search events, IDs, endpoints…"
                aria-label="Search deliveries"
              />
              <kbd>/</kbd>
            </label>
            <button
              type="button"
              className="rf-command-trigger"
              aria-label="Open command palette"
              title="Open command palette (Ctrl or Cmd + K)"
              onClick={openCommandPalette}
              disabled={
                !snapshot ||
                busy ||
                authRequired ||
                signingOut ||
                commandPresented ||
                mobileOpen ||
                Boolean(selected) ||
                recoveryDialogOpen
              }
            >
              <Search size={17} />
              <span>Commands</span>
              <kbd>⌘ K</kbd>
            </button>
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
                    href={`/login?returnTo=${encodeURIComponent(serializeNavigation(urlState))}`}
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
            {!snapshot || authRequired ? (
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
                    href={`/login?returnTo=${encodeURIComponent(serializeNavigation(urlState))}`}
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
                    <ProductOverview
                      snapshot={snapshot}
                      scope={urlState.scope}
                      changeScope={(scope) => changeNavigation({ scope })}
                      connections={() => go("Endpoints")}
                      studio={() => createEvent()}
                      deliveries={() => go("Deliveries")}
                      recovery={() => go("Recovery")}
                      engineering={() => go("Engineering")}
                      demo={() =>
                        act(
                          { type: "demo" },
                          "Demo accepted. Watch the delivery engine work.",
                        )
                      }
                      busy={busy}
                      inspect={setSelected}
                      hrefForEvent={hrefForEvent}
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
                            }}
                            placeholder="Search event type or ID…"
                            aria-label="Filter deliveries by event, ID or endpoint"
                            maxLength={100}
                          />
                        </label>
                        <div className="filter-tabs">
                          {[
                            { id: "all", label: "All" },
                            { id: "delivered", label: "Completed" },
                            { id: "retrying", label: "Retrying" },
                            { id: "dead", label: "Failed" },
                            { id: "pending", label: "Queued" },
                          ].map((item) => (
                            <button
                              key={item.id}
                              className={status === item.id ? "active" : ""}
                              aria-pressed={status === item.id}
                              onClick={() => {
                                changeNavigation({
                                  status: item.id as NavigationState["status"],
                                  page: 1,
                                });
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
                              changeNavigation({
                                endpoint: event.target.value,
                                page: 1,
                              });
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
                                  changeNavigation({
                                    size: Number(event.target.value),
                                    page: 1,
                                  });
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
                            hrefForEvent={hrefForEvent}
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
                                  Run lab demo
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
                    <ConnectionsPanel
                      snapshot={snapshot}
                      update={updateSnapshot}
                      busy={busy}
                      setMode={(endpointId, mode) =>
                        act(
                          { type: "set-receiver", endpointId, mode },
                          `Receiver behavior changed to ${mode}.`,
                        )
                      }
                      inspect={showEndpointDeliveries}
                      studio={createEvent}
                      recovery={() => go("Recovery")}
                      connectionError={handleRecoveryConnection}
                      onDialogChange={setRecoveryDialogOpen}
                    />
                  )}
                  {view === "Studio" && (
                    <IntegrationStudio
                      snapshot={snapshot}
                      endpointId={urlState.endpoint}
                      choose={(endpoint) => changeNavigation({ endpoint })}
                      update={updateSnapshot}
                      inspect={setSelected}
                      connections={() => go("Endpoints")}
                      connectionError={handleRecoveryConnection}
                      keys={() => go("Security")}
                    />
                  )}
                  {view === "Recovery" && (
                    <RecoveryPanel
                      snapshot={snapshot}
                      busy={busy}
                      act={act}
                      replayBatch={replayBatch}
                      load={loadRecoveryPage}
                      connectionError={handleRecoveryConnection}
                      inspect={setSelected}
                      onDialogChange={setRecoveryDialogOpen}
                      navigation={urlState}
                      change={changeNavigation}
                    />
                  )}
                  {view === "Activity" && (
                    <AuditExplorer
                      navigation={urlState}
                      change={changeNavigation}
                      now={snapshot.system.now}
                      load={loadAudit}
                      connectionError={handleRecoveryConnection}
                      inspect={setSelected}
                      hrefForEvent={hrefForEvent}
                    />
                  )}
                  {view === "Security" && (
                    <>
                      <SecurityCenter
                        busy={busy}
                        version={snapshot.system.now}
                        load={loadSecurity}
                        mutate={securityMutate}
                        connectionError={handleRecoveryConnection}
                        onDialogChange={setRecoveryDialogOpen}
                        activityHref={serializeNavigation({
                          ...navigationForView("activity"),
                          category: "security",
                        })}
                        openActivity={() =>
                          changeNavigation({
                            ...navigationForView("activity"),
                            category: "security",
                          })
                        }
                      />
                      <ProducerKeyPanel
                        snapshot={snapshot}
                        connectionError={handleRecoveryConnection}
                        onDialogChange={setRecoveryDialogOpen}
                        connections={() => go("Endpoints")}
                      />
                    </>
                  )}
                  {view === "Engineering" && (
                    <Engineering snapshot={snapshot} copy={copy} />
                  )}
                  <footer className="workspace-footer">
                    <span>RelayForge · Webhook delivery platform</span>
                    <span title={processor?.description}>
                      <i className="live-dot" />
                      {connectionError
                        ? "Connection interrupted"
                        : snapshot.system.queuePaused
                          ? "Queue paused"
                          : processor?.online
                            ? `Worker ${processor.heartbeat.toLowerCase()}`
                            : "Worker offline · live events queued"}
                    </span>
                  </footer>
                </motion.div>
              </AnimatePresence>
            )}
          </main>
        </div>
        <AnimatePresence onExitComplete={commandExitComplete}>
          {commandOpen && snapshot && !authRequired && (
            <CommandPalette
              endpoints={snapshot.endpoints}
              load={loadCommands}
              navigate={navigateFromCommand}
              onClose={closeCommandPalette}
            />
          )}
        </AnimatePresence>
        <AnimatePresence>
          {selected && snapshot && !authRequired && (
            <DeliveryDrawer
              id={selected}
              version={snapshot.system.now}
              maxAttempts={snapshot.system.maxAttempts}
              close={closeDetail}
              replay={(eventId, expectedCycle) =>
                act(
                  { type: "replay", eventId, expectedCycle },
                  "Original event requeued. Its identity and history are preserved.",
                )
              }
              busy={busy}
              recoveryEndpointIds={snapshot.endpoints
                .filter((endpoint) => endpoint.purpose === "recovery")
                .map((endpoint) => endpoint.id)}
              openRecovery={() => {
                go("Recovery");
              }}
              viewEndpoint={() => {
                go("Endpoints");
              }}
              copy={copy}
              href={hrefForEvent(selected)}
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
