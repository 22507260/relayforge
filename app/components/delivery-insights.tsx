"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronDown,
  Clock3,
  FlaskConical,
  Globe2,
  Layers3,
  LoaderCircle,
  Pause,
  RefreshCw,
  ShieldCheck,
  Timer,
} from "lucide-react";
import type {
  DeliveryInsights,
  DeliveryQuery,
  Snapshot,
} from "@/lib/contracts";
import { api } from "@/lib/client-api";
import { Button, formatDuration, formatNumber } from "./relay-ui";
import { TransportBadge } from "./connections-panel";
import { RequestFeedback } from "./request-feedback";
import "./delivery-insights.css";

type InsightsNavigation = {
  scope: "live" | "lab";
  window: "1h" | "24h" | "7d";
  endpoint: string;
};

const windowNames = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
};
const failureNames: Record<string, string> = {
  http_3xx: "HTTP redirects",
  http_4xx: "HTTP client errors",
  http_5xx: "HTTP server errors",
  http_other: "Other HTTP responses",
  destination_blocked: "Destination blocked",
  dns_failed: "DNS resolution failed",
  timeout: "Request timed out",
  tls_failed: "TLS connection failed",
  network_error: "Network connection failed",
  response_headers_too_large: "Response headers too large",
  http_rejected: "HTTP request rejected",
  unclassified: "Unclassified failure",
};
const utc = (timestamp: number, withDate = false) =>
  new Date(timestamp).toLocaleString("en-GB", {
    ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
const timestamp = (value: number) => `${utc(value, true)} UTC`;
const percent = (part: number, total: number) =>
  total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—";
const age = (createdAt: number | null, now: number) => {
  if (createdAt === null) return "—";
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr`;
  return `${Math.floor(seconds / 86400)} days`;
};

function Metric({
  title,
  value,
  note,
  icon,
  tone = "",
}: {
  title: string;
  value: string;
  note: string;
  icon: ReactNode;
  tone?: "" | "positive" | "negative";
}) {
  return (
    <article className={`rf-insight-metric ${tone}`}>
      <span>
        {icon}
        {title}
      </span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function AttemptChart({
  data,
  window,
}: {
  data: DeliveryInsights;
  window: InsightsNavigation["window"];
}) {
  const maximum = Math.max(
    1,
    ...data.timeline.map((bucket) => bucket.acknowledged + bucket.failed),
  );
  const outcomes = data.attempts.acknowledged + data.attempts.failed;
  return (
    <section
      className="rf-insight-panel rf-insight-chart"
      aria-labelledby="insight-attempts-title"
    >
      <div className="rf-insight-panel-heading">
        <div>
          <span className="rf-insight-section-label">DELIVERY ACTIVITY</span>
          <h2 id="insight-attempts-title">Every attempt leaves a signal.</h2>
          <p>Completed outcomes, grouped by the time each attempt started.</p>
        </div>
        <ChartNoAxesCombined size={21} aria-hidden="true" />
      </div>
      <div className="rf-insight-legend">
        <span>
          <i className="positive" />
          Acknowledged
        </span>
        <span>
          <i className="negative" />
          Failed
        </span>
        <small>{formatNumber(outcomes)} observed outcomes</small>
      </div>
      <div
        className="rf-insight-plot"
        role="img"
        aria-label={`Attempt outcomes over ${windowNames[window].toLowerCase()}: ${formatNumber(data.attempts.acknowledged)} acknowledged and ${formatNumber(data.attempts.failed)} failed. Exact values are available in the timeline table below.`}
      >
        <div className="rf-insight-plot-axis" aria-hidden="true">
          <span>{formatNumber(maximum)}</span>
          <span>{formatNumber(Math.floor(maximum / 2))}</span>
          <span>0</span>
        </div>
        <div className="rf-insight-plot-grid" aria-hidden="true">
          {data.timeline.map((bucket) => (
            <div
              className="rf-insight-column"
              key={bucket.startAt}
              title={`${timestamp(bucket.startAt)} – ${timestamp(bucket.endAt)}: ${bucket.acknowledged} acknowledged, ${bucket.failed} failed`}
            >
              <div className="rf-insight-column-track">
                <div
                  className="rf-insight-bar-stack"
                  style={{
                    height: `${((bucket.acknowledged + bucket.failed) / maximum) * 100}%`,
                  }}
                >
                  {bucket.failed > 0 && (
                    <i className="negative" style={{ flex: bucket.failed }} />
                  )}
                  {bucket.acknowledged > 0 && (
                    <i
                      className="positive"
                      style={{ flex: bucket.acknowledged }}
                    />
                  )}
                </div>
              </div>
              <span>
                {window === "7d"
                  ? new Date(bucket.startAt).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      timeZone: "UTC",
                    })
                  : utc(bucket.startAt)}
              </span>
            </div>
          ))}
        </div>
        {outcomes === 0 && (
          <div className="rf-insight-chart-empty" aria-hidden="true">
            <Activity size={20} />
            <strong>Quiet for now</strong>
            <span>No completed outcomes in this window.</span>
          </div>
        )}
      </div>
      <div className="rf-insight-chart-note">
        <Clock3 size={12} />
        <span>UTC · An event can appear in more than one attempt.</span>
      </div>
      <details className="rf-insight-timeline">
        <summary>
          Explore the timeline data <ChevronDown size={14} />
        </summary>
        <div
          className="rf-insight-table-scroll"
          role="region"
          aria-label="Attempt timeline table"
          tabIndex={0}
        >
          <table>
            <caption>
              Buckets include their start and exclude their end, except the last
              bucket includes the window end. Accepted counts are events;
              acknowledged and failed counts are attempts.
            </caption>
            <thead>
              <tr>
                <th scope="col">UTC interval</th>
                <th scope="col">Accepted events</th>
                <th scope="col">Acknowledged attempts</th>
                <th scope="col">Failed attempts</th>
              </tr>
            </thead>
            <tbody>
              {data.timeline.map((bucket) => (
                <tr key={bucket.startAt}>
                  <th scope="row">
                    {utc(bucket.startAt, true)} → {utc(bucket.endAt, true)}
                  </th>
                  <td>{formatNumber(bucket.accepted)}</td>
                  <td>{formatNumber(bucket.acknowledged)}</td>
                  <td>{formatNumber(bucket.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function Breakdown({
  title,
  eyebrow,
  description,
  items,
  empty,
}: {
  title: string;
  eyebrow: string;
  description: string;
  items: { label: string; value: number; tone: string }[];
  empty: string;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <section className="rf-insight-panel rf-insight-breakdown">
      <div className="rf-insight-panel-heading">
        <div>
          <span className="rf-insight-section-label">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.label}>
              <div>
                <span>
                  <i className={item.tone} />
                  {item.label}
                </span>
                <strong>
                  {formatNumber(item.value)}
                  <small>{percent(item.value, total)}</small>
                </strong>
              </div>
              <span className="rf-insight-breakdown-track" aria-hidden="true">
                <i
                  className={item.tone}
                  style={{ width: `${(item.value / total) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rf-insight-breakdown-empty">
          <CheckCheck size={18} />
          <p>{empty}</p>
        </div>
      )}
    </section>
  );
}

export function DeliveryInsightsPanel({
  navigation,
  snapshot,
  change,
  deliveries,
  connectionError,
}: {
  navigation: InsightsNavigation;
  snapshot: Snapshot;
  change: (patch: Partial<InsightsNavigation>) => void;
  deliveries: (endpointId: string, status?: DeliveryQuery["status"]) => void;
  connectionError: (error: unknown) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    data: DeliveryInsights | null;
    error: unknown;
  } | null>(null);
  const query = new URLSearchParams({
    scope: navigation.scope,
    window: navigation.window,
    endpointId: navigation.endpoint,
  }).toString();
  const current = result?.query === query ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? null;
  useEffect(() => {
    const controller = new AbortController();
    api<DeliveryInsights>(
      `/api/insights?${query}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setResult({ query, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          query,
          data: previous?.query === query ? previous.data : null,
          error,
        }));
        connectionError(error);
      });
    return () => controller.abort();
  }, [query, snapshot.system.now, retry, connectionError]);
  const endpoints = snapshot.endpoints.filter((endpoint) =>
    navigation.scope === "lab"
      ? endpoint.transport === "demo"
      : endpoint.transport !== "demo",
  );
  const classified = data
    ? data.attempts.acknowledged + data.attempts.failed
    : 0;
  const cohortCompleted = data
    ? data.events.acknowledged + data.events.dead
    : 0;
  const queueWaitingForWorker =
    data &&
    navigation.scope === "live" &&
    data.queue.total > 0 &&
    snapshot.system.processor !== "worker";
  const connectionName =
    endpoints.find((endpoint) => endpoint.id === navigation.endpoint)?.name ??
    "Selected connection";
  return (
    <div className="rf-insights">
      <div className="rf-insight-header">
        <div>
          <span className="rf-insight-eyebrow">
            <i />
            OPERATE / DELIVERY INSIGHTS
          </span>
          <h1>Understand every delivery.</h1>
          <p>
            A real view of outcomes, latency, and the places your queue needs
            attention.
          </p>
        </div>
        <div
          className="rf-insight-scope"
          role="group"
          aria-label="Insights scope"
        >
          <button
            type="button"
            aria-pressed={navigation.scope === "live"}
            onClick={() => change({ scope: "live", endpoint: "all" })}
          >
            <Globe2 size={13} />
            Live
          </button>
          <button
            type="button"
            aria-pressed={navigation.scope === "lab"}
            onClick={() => change({ scope: "lab", endpoint: "all" })}
          >
            <FlaskConical size={13} />
            Lab
          </button>
        </div>
      </div>
      <div className="rf-insight-toolbar">
        <div
          className="rf-insight-windows"
          role="group"
          aria-label="Observation window"
        >
          {(["1h", "24h", "7d"] as const).map((window) => (
            <button
              type="button"
              key={window}
              aria-pressed={navigation.window === window}
              onClick={() => change({ window })}
            >
              {windowNames[window]}
            </button>
          ))}
        </div>
        <label className="rf-insight-connection">
          <span className="sr-only">Insights connection</span>
          <Globe2 size={14} aria-hidden="true" />
          <select
            value={navigation.endpoint}
            onChange={(event) => change({ endpoint: event.target.value })}
          >
            <option value="all">
              All{" "}
              {navigation.scope === "lab"
                ? "lab receivers"
                : "live connections"}
            </option>
            {!endpoints.some(
              (endpoint) => endpoint.id === navigation.endpoint,
            ) &&
              navigation.endpoint !== "all" && (
                <option value={navigation.endpoint}>Selected connection</option>
              )}
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.name}
                {endpoint.enabled ? "" : " · Disabled"}
              </option>
            ))}
          </select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>
      </div>
      {error && (
        <div className="rf-insight-error">
          <RequestFeedback error={error} focus={false} />
          <Button
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={14} />
            Try again
          </Button>
          {data && (
            <small>
              Showing the last successful observation. Its timestamp appears
              below.
            </small>
          )}
        </div>
      )}
      {!current && (
        <div className="rf-insight-loading" role="status">
          <LoaderCircle size={22} />
          <strong>Reading delivery history</strong>
          <p>Gathering this workspace’s events and attempts.</p>
        </div>
      )}
      {data && (
        <>
          <div className="rf-insight-boundary">
            <span>
              <i />
              {navigation.endpoint === "all"
                ? navigation.scope === "live"
                  ? "ALL LIVE CONNECTIONS"
                  : "ALL LAB RECEIVERS"
                : connectionName}
            </span>
            <p>
              <time dateTime={new Date(data.since).toISOString()}>
                {timestamp(data.since)}
              </time>
              <ArrowRight size={11} aria-hidden="true" />
              <time dateTime={new Date(data.now).toISOString()}>
                {timestamp(data.now)}
              </time>
            </p>
          </div>
          <div className="rf-insight-metrics">
            <Metric
              title="Accepted events"
              value={formatNumber(data.events.accepted)}
              note={`${formatNumber(cohortCompleted)} have reached a terminal outcome`}
              icon={<Layers3 size={14} />}
            />
            <Metric
              title="Attempt acknowledgement"
              value={percent(data.attempts.acknowledged, classified)}
              note={
                classified
                  ? `${formatNumber(data.attempts.acknowledged)} of ${formatNumber(classified)} observed outcomes`
                  : "No classified outcomes in this window"
              }
              icon={<CheckCheck size={14} />}
              tone={classified ? "positive" : ""}
            />
            <Metric
              title="Failed attempts"
              value={formatNumber(data.attempts.failed)}
              note="Includes HTTP and network failures"
              icon={<ArrowDownRight size={14} />}
              tone={data.attempts.failed ? "negative" : ""}
            />
            <Metric
              title="Median duration · p50"
              value={formatDuration(data.attempts.p50Ms)}
              note={`${formatNumber(data.attempts.measured)} finished, measured attempts`}
              icon={<Timer size={14} />}
            />
            <Metric
              title="Tail duration · p95"
              value={formatDuration(data.attempts.p95Ms)}
              note="95% of measured durations are at or below"
              icon={<Activity size={14} />}
            />
            <Metric
              title="Queued now"
              value={formatNumber(data.queue.total)}
              note="Current backlog · includes older events"
              icon={<Clock3 size={14} />}
            />
          </div>
          <div className="rf-insight-main-grid">
            <AttemptChart data={data} window={navigation.window} />
            <aside
              className="rf-insight-panel rf-insight-queue"
              aria-labelledby="insight-queue-title"
            >
              <div className="rf-insight-panel-heading">
                <div>
                  <span className="rf-insight-section-label">
                    PRESENT TENSE
                  </span>
                  <h2 id="insight-queue-title">Your queue, right now.</h2>
                  <p>All ages, within the selected scope and connection.</p>
                </div>
              </div>
              <div className="rf-insight-queue-age">
                <Clock3 size={17} />
                <div>
                  <small>Oldest queued event</small>
                  <strong>{age(data.queue.oldestCreatedAt, data.now)}</strong>
                </div>
              </div>
              <dl>
                <div>
                  <dt>Pending or retrying</dt>
                  <dd>{formatNumber(data.queue.total)}</dd>
                </div>
                <div>
                  <dt>Scheduled by now</dt>
                  <dd>{formatNumber(data.queue.due)}</dd>
                </div>
                <div>
                  <dt>At disabled connections</dt>
                  <dd>{formatNumber(data.queue.blockedDisabled)}</dd>
                </div>
              </dl>
              <p
                className={`rf-insight-queue-state ${data.queue.paused || queueWaitingForWorker ? "waiting" : ""}`}
              >
                {data.queue.paused ? (
                  <Pause size={14} />
                ) : (
                  <Activity size={14} />
                )}
                <span>
                  {data.queue.paused
                    ? "Processing is paused. Queued events retain their history."
                    : queueWaitingForWorker
                      ? "Waiting for the background worker. Live delivery needs an active worker."
                      : snapshot.system.processor === "worker"
                        ? "Background worker online."
                        : "The browser can advance Lab deliveries."}
                </span>
              </p>
              <small className="rf-insight-queue-note">
                Scheduled counts do not guarantee delivery. Pause, signing
                configuration, and destination policy can still block
                processing.
              </small>
              <button
                type="button"
                className="rf-insight-link"
                onClick={() => deliveries(navigation.endpoint)}
              >
                Explore deliveries <ArrowRight size={13} />
              </button>
            </aside>
          </div>
          <div className="rf-insight-semantics">
            <ShieldCheck size={16} />
            <p>
              <strong>Read the window clearly.</strong> Event counts include
              events accepted in this window, with their current status. Attempt
              counts include attempts started in this window, even for older
              events. Duration percentiles describe observed requests; they are
              not performance targets.
              {navigation.scope === "live" &&
                " Acknowledgement confirms HTTP success, not a remote business effect."}
            </p>
          </div>
          {(data.attempts.inFlight > 0 ||
            data.attempts.unmeasuredInterrupted > 0) && (
            <div className="rf-insight-history-note">
              <Clock3 size={14} />
              <span>
                {formatNumber(data.attempts.inFlight)} unfinished attempts ·{" "}
                {formatNumber(data.attempts.unmeasuredInterrupted)} unmeasured
                history records. Unfinished and unclassified history are
                excluded from the acknowledgement rate; unmeasured records are
                excluded from duration percentiles.
              </span>
            </div>
          )}
          <div className="rf-insight-breakdown-grid">
            <Breakdown
              title="What came back"
              eyebrow="HTTP OUTCOMES"
              description="Finished requests with an observed result."
              items={data.httpStatuses.map((status) => ({
                label:
                  status.statusCode === null
                    ? "No HTTP response"
                    : `HTTP ${status.statusCode}`,
                value: status.count,
                tone:
                  status.statusCode === null
                    ? "neutral"
                    : status.statusCode >= 200 && status.statusCode < 300
                      ? "positive"
                      : status.statusCode >= 300 && status.statusCode < 400
                        ? "warning"
                        : "negative",
              }))}
              empty="No completed responses in this window."
            />
            <Breakdown
              title="Where attempts broke"
              eyebrow="FAILURE BREAKDOWN"
              description="Recorded failures, grouped by HTTP or transport cause."
              items={data.failures.map((failure) => ({
                label: failureNames[failure.category] ?? "Unclassified failure",
                value: failure.count,
                tone: failure.category.startsWith("http_")
                  ? "negative"
                  : "warning",
              }))}
              empty="No failed outcomes in this window."
            />
          </div>
          <section
            className="rf-insight-panel rf-insight-connections"
            aria-labelledby="insight-connections-title"
          >
            <div className="rf-insight-panel-heading">
              <div>
                <span className="rf-insight-section-label">
                  CONNECTION COMPARISON
                </span>
                <h2 id="insight-connections-title">
                  Find the connection that needs you.
                </h2>
                <p>
                  Event counts follow the acceptance window. Attempt counts and
                  p95 follow the attempt window.
                </p>
              </div>
              <span className="rf-insight-count">
                {data.endpoints.length}{" "}
                {data.endpoints.length === 1 ? "connection" : "connections"}
              </span>
            </div>
            {data.endpoints.length ? (
              <div className="rf-insight-comparison" role="list">
                {data.endpoints.map((endpoint) => (
                  <article
                    className="rf-insight-endpoint"
                    role="listitem"
                    key={endpoint.endpointId}
                  >
                    <div className="rf-insight-endpoint-name">
                      <TransportBadge endpoint={endpoint} />
                      <button
                        type="button"
                        onClick={() => deliveries(endpoint.endpointId)}
                      >
                        {endpoint.name}
                        <ArrowRight size={13} />
                      </button>
                      <small>{endpoint.enabled ? "Enabled" : "Disabled"}</small>
                    </div>
                    <dl>
                      <div>
                        <dt>Accepted events</dt>
                        <dd>{formatNumber(endpoint.accepted)}</dd>
                      </div>
                      <div>
                        <dt>
                          {navigation.scope === "lab"
                            ? "Delivered events"
                            : "Acknowledged events"}
                        </dt>
                        <dd className="positive">
                          {formatNumber(endpoint.acknowledged)}
                        </dd>
                      </div>
                      <div>
                        <dt>Failed events</dt>
                        <dd className={endpoint.dead ? "negative" : ""}>
                          {formatNumber(endpoint.dead)}
                        </dd>
                      </div>
                      <div>
                        <dt>Failed attempts</dt>
                        <dd>
                          {formatNumber(endpoint.failedAttempts)}
                          <small> / {formatNumber(endpoint.attempts)}</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Duration · p95</dt>
                        <dd>{formatDuration(endpoint.p95Ms)}</dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rf-insight-breakdown-empty">
                <Globe2 size={21} />
                <p>
                  No{" "}
                  {navigation.scope === "lab"
                    ? "lab receivers"
                    : "live connections"}{" "}
                  in this scope.
                </p>
              </div>
            )}
            <div className="rf-insight-comparison-note">
              Connection links open their complete delivery history. The
              observation window is not applied to that list.
            </div>
          </section>
          <footer className="rf-insight-footer">
            <span>
              <ShieldCheck size={12} />
              Workspace data · complete history queried
            </span>
            <span>
              Observed{" "}
              <time dateTime={new Date(data.now).toISOString()}>
                {timestamp(data.now)}
              </time>
            </span>
          </footer>
        </>
      )}
    </div>
  );
}
