"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Download,
  FlaskConical,
  Globe2,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import type {
  OperationsQueueCode,
  OperationsReport,
  Snapshot,
} from "@/lib/contracts";
import { api } from "@/lib/client-api";
import { Button, formatNumber } from "./relay-ui";
import { TransportBadge } from "./connections-panel";
import { RequestFeedback } from "./request-feedback";
import "./operations-center.css";

type OperationsScope = "live" | "lab";
type OperationsConnection = OperationsReport["connections"][number];

const bucketDefinitions: Record<
  OperationsQueueCode,
  { title: string; description: string; tone: string }
> = {
  in_flight: {
    title: "In flight",
    description: "A delivery lease is active.",
    tone: "blue",
  },
  lease_recovery: {
    title: "Lease recovery",
    description: "An expired lease needs recovery.",
    tone: "purple",
  },
  disabled: {
    title: "Connection disabled",
    description: "Waiting behind a disabled connection.",
    tone: "amber",
  },
  budget_exhausted: {
    title: "Attempt budget used",
    description: "No attempts remain in the current cycle.",
    tone: "red",
  },
  scheduled: {
    title: "Scheduled",
    description: "The next attempt is scheduled for later.",
    tone: "muted",
  },
  due: {
    title: "Due locally",
    description: "The local retry schedule allows an attempt.",
    tone: "lime",
  },
  unscheduled: {
    title: "Needs inspection",
    description: "Schedule or lease metadata needs review.",
    tone: "neutral",
  },
};

function elapsed(timestamp: number | null, now: number) {
  if (timestamp === null) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr`;
  return `${Math.floor(seconds / 86400)} days`;
}

function observedAt(timestamp: number) {
  return `${new Date(timestamp).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

function QueueBreakdown({ data }: { data: OperationsReport }) {
  return (
    <section
      className="rf-ops-panel rf-ops-queue"
      aria-labelledby="ops-queue-title"
    >
      <div className="rf-ops-panel-heading">
        <div>
          <span className="rf-ops-section-label">QUEUE DISTRIBUTION</span>
          <h2 id="ops-queue-title">Where work is waiting.</h2>
          <p>Every queued event appears in exactly one state.</p>
        </div>
        <span className="rf-ops-count">
          {data.scope === "live" ? "LIVE" : "LAB"} / ALL AGES
        </span>
      </div>
      <div className="rf-ops-queue-total">
        <strong>{formatNumber(data.queue.total)}</strong>
        <div>
          <span>queued events</span>
          <small>
            {data.queue.oldestCreatedAt === null
              ? "No events waiting"
              : `Oldest accepted ${elapsed(data.queue.oldestCreatedAt, data.now)} ago`}
          </small>
        </div>
        <Layers3 size={29} aria-hidden="true" />
      </div>
      <div className="rf-ops-distribution" aria-hidden="true">
        {data.queue.total > 0 ? (
          data.queue.buckets
            .filter((bucket) => bucket.count > 0)
            .map((bucket) => (
              <i
                key={bucket.code}
                className={bucketDefinitions[bucket.code].tone}
                style={{ flex: bucket.count }}
              />
            ))
        ) : (
          <i className="empty" />
        )}
      </div>
      <dl className="rf-ops-buckets">
        {data.queue.buckets.map((bucket) => {
          const definition = bucketDefinitions[bucket.code];
          return (
            <div
              key={bucket.code}
              className={bucket.count > 0 ? "populated" : ""}
            >
              <dt>
                <i className={definition.tone} aria-hidden="true" />
                <span>
                  {definition.title}
                  <small>{definition.description}</small>
                </span>
              </dt>
              <dd>
                <strong>{formatNumber(bucket.count)}</strong>
                <small>
                  {bucket.oldestCreatedAt === null
                    ? "—"
                    : `${elapsed(bucket.oldestCreatedAt, data.now)} oldest`}
                </small>
              </dd>
            </div>
          );
        })}
      </dl>
      {data.workspace.paused && (
        <p className="rf-ops-card-note" role="status">
          Queue paused. New attempts wait; active attempts can finish.
        </p>
      )}
      <details className="rf-ops-help">
        <summary>
          <span>
            <CircleHelp size={13} /> How queue states work
          </span>
          <ChevronDown size={14} />
        </summary>
        <div>
          <p>
            States follow this order: active lease, expired lease, disabled
            connection, exhausted attempt budget, future schedule, due schedule,
            then unclassified queue metadata. Pause is a workspace control and
            does not change these counts.
          </p>
          <p>
            “Due locally” describes timing only. It does not verify destination
            policy, signing configuration, or receiver availability. This report
            makes no DNS or HTTP requests and does not inspect signing keys.
          </p>
        </div>
      </details>
    </section>
  );
}

function Infrastructure({ data }: { data: OperationsReport }) {
  const { worker, workspace } = data;
  const atCapacity = workspace.remainingEvents === 0;
  const usedPercent =
    workspace.eventLimit > 0
      ? Math.min(100, (workspace.acceptedEvents / workspace.eventLimit) * 100)
      : 0;
  return (
    <div className="rf-ops-infrastructure">
      <section
        className={`rf-ops-panel rf-ops-worker ${worker.online ? "online" : "offline"}`}
        aria-labelledby="ops-worker-title"
      >
        <div className="rf-ops-panel-heading">
          <div>
            <span className="rf-ops-section-label">PROCESSOR SIGNAL</span>
            <h2 id="ops-worker-title">Worker heartbeat</h2>
          </div>
          <Server size={19} aria-hidden="true" />
        </div>
        <div className="rf-ops-worker-signal">
          <span className="rf-ops-signal-mark" aria-hidden="true">
            <Activity size={24} />
          </span>
          <div>
            <strong>
              {worker.online ? "Heartbeat current" : "No current heartbeat"}
            </strong>
            <span>
              {worker.online
                ? `${formatNumber(worker.activeWorkers)} active ${worker.activeWorkers === 1 ? "worker" : "workers"}`
                : worker.lastHeartbeatAt === null
                  ? "No heartbeat recorded"
                  : "Last signal is outside the window"}
            </span>
          </div>
        </div>
        <dl className="rf-ops-worker-facts">
          <div>
            <dt>Last signal</dt>
            <dd>
              {worker.lastHeartbeatAt === null
                ? "Never"
                : `${elapsed(worker.lastHeartbeatAt, data.now)} ago`}
            </dd>
          </div>
          <div>
            <dt>Heartbeat window</dt>
            <dd>{worker.heartbeatTtlMs / 1000} sec</dd>
          </div>
        </dl>
        {data.summary.queuedLiveRequiresWorker && (
          <div className="rf-ops-worker-needed">
            <TriangleAlert size={14} />
            <p>
              Live deliveries need a worker. Browser fallback processes lab
              events only.
            </p>
          </div>
        )}
        <p className="rf-ops-card-note">
          Shared infrastructure signal. A recent heartbeat does not confirm
          delivery progress for this workspace.
        </p>
      </section>
      <section
        className={`rf-ops-panel rf-ops-capacity ${atCapacity ? "full" : ""}`}
        aria-labelledby="ops-capacity-title"
      >
        <div className="rf-ops-panel-heading">
          <div>
            <span className="rf-ops-section-label">WORKSPACE CAPACITY</span>
            <h2 id="ops-capacity-title">Room for the next event.</h2>
          </div>
          <Layers3 size={19} aria-hidden="true" />
        </div>
        <div className="rf-ops-capacity-value">
          <strong>{formatNumber(workspace.remainingEvents)}</strong>
          <span>{atCapacity ? "event limit reached" : "events remaining"}</span>
        </div>
        <div
          className="rf-ops-capacity-track"
          role="meter"
          aria-label="Workspace accepted event capacity"
          aria-valuemin={0}
          aria-valuemax={workspace.eventLimit}
          aria-valuenow={Math.min(
            workspace.acceptedEvents,
            workspace.eventLimit,
          )}
          aria-valuetext={`${workspace.acceptedEvents} of ${workspace.eventLimit} accepted events across Live and Lab`}
        >
          <i style={{ width: `${usedPercent}%` }} />
        </div>
        <p className="rf-ops-capacity-label">
          <span>{formatNumber(workspace.acceptedEvents)} accepted</span>
          <span>{formatNumber(workspace.eventLimit)} limit</span>
        </p>
        <p className="rf-ops-card-note">
          Shared across Live and Lab, including completed events.
        </p>
      </section>
    </div>
  );
}

function ConnectionRow({
  connection,
  now,
  openDeliveries,
  openRecovery,
}: {
  connection: OperationsConnection;
  now: number;
  openDeliveries: (endpointId: string) => void;
  openRecovery: (endpointId: string) => void;
}) {
  return (
    <article
      className={`rf-ops-connection ${connection.needsAttention ? "attention" : ""}`}
    >
      <div className="rf-ops-connection-name">
        <button
          type="button"
          onClick={() => openDeliveries(connection.endpointId)}
          aria-label={`Inspect deliveries for ${connection.name}`}
        >
          {connection.name}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
        <div>
          <TransportBadge endpoint={connection} />
          <span className={connection.enabled ? "" : "disabled"}>
            {connection.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
      </div>
      <dl>
        <div>
          <dt>Queued</dt>
          <dd>{formatNumber(connection.queued)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd className={connection.dead > 0 ? "negative" : ""}>
            {formatNumber(connection.dead)}
          </dd>
        </div>
        <div>
          <dt>Oldest queued</dt>
          <dd>{elapsed(connection.oldestQueuedAt, now)}</dd>
        </div>
      </dl>
      <div className="rf-ops-connection-action">
        {connection.dead > 0 ? (
          <button
            type="button"
            onClick={() => openRecovery(connection.endpointId)}
            aria-label={`Open recovery for ${connection.name}`}
          >
            Open recovery
            <ArrowRight size={13} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => openDeliveries(connection.endpointId)}
            aria-label={`View deliveries for ${connection.name}`}
          >
            View deliveries
            <ArrowRight size={13} />
          </button>
        )}
      </div>
    </article>
  );
}

export function OperationsCenter({
  scope,
  snapshot,
  changeScope,
  openConnections,
  openDeliveries,
  openRecovery,
  connectionError,
}: {
  scope: OperationsScope;
  snapshot: Snapshot;
  changeScope: (scope: OperationsScope) => void;
  openConnections: () => void;
  openDeliveries: (endpointId: string) => void;
  openRecovery: (endpointId: string) => void;
  connectionError: (error: unknown) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    scope: OperationsScope;
    data: OperationsReport | null;
    error: unknown;
  } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const current = result?.scope === scope ? result : null;
  const data = current?.data ?? null;
  const error = current?.error ?? null;
  useEffect(() => {
    const controller = new AbortController();
    api<OperationsReport>(
      `/api/operations?scope=${scope}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setResult({ scope, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          scope,
          data: previous?.scope === scope ? previous.data : null,
          error,
        }));
        connectionError(error);
      });
    return () => controller.abort();
  }, [scope, snapshot.system.now, retry, connectionError]);

  const download = () => {
    if (!data) return;
    let objectUrl: string | null = null;
    try {
      const report = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
        type: "application/json",
      });
      objectUrl = URL.createObjectURL(report);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `relayforge-operations-${data.scope}-${new Date(data.now).toISOString().replaceAll(":", "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setDownloadError(null);
    } catch {
      setDownloadError("The report could not be downloaded. Please try again.");
    } finally {
      if (objectUrl !== null) {
        const url = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
  };
  const attentionCount =
    data?.connections.filter((connection) => connection.needsAttention)
      .length ?? 0;
  return (
    <div className="rf-operations">
      <div className="rf-ops-header">
        <div>
          <span className="rf-ops-eyebrow">
            <i /> OPERATE / OPERATIONS CENTER
          </span>
          <h1>Know what needs attention.</h1>
          <p>
            A clear view of your queue, worker signal, and connection backlog.
          </p>
        </div>
        <div
          className="rf-ops-scope"
          role="group"
          aria-label="Operations scope"
        >
          <button
            type="button"
            aria-pressed={scope === "live"}
            onClick={() => changeScope("live")}
          >
            <Globe2 size={13} />
            Live
          </button>
          <button
            type="button"
            aria-pressed={scope === "lab"}
            onClick={() => changeScope("lab")}
          >
            <FlaskConical size={13} />
            Lab
          </button>
        </div>
      </div>
      <div className="rf-ops-toolbar">
        <span>
          <i />
          CURRENT STATE<span className="rf-ops-toolbar-separator">/</span>
          {scope === "live" ? "LIVE CONNECTIONS" : "LAB RECEIVERS"}
        </span>
        <Button variant="secondary" onClick={download} disabled={!data}>
          <Download size={13} />
          Download report
        </Button>
      </div>
      {downloadError && <RequestFeedback error={downloadError} focus={false} />}
      {error !== null && (
        <div className="rf-ops-error">
          <RequestFeedback error={error} focus={!data} />
          <Button
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={13} />
            Retry report
          </Button>
          {data && (
            <small>
              Showing the previous report from {observedAt(data.now)}.
            </small>
          )}
        </div>
      )}
      {!data && error === null && (
        <div className="rf-ops-loading" role="status">
          <LoaderCircle size={25} />
          <strong>Reading your operations.</strong>
          <p>Checking current queue state and connection backlog.</p>
        </div>
      )}
      {data && (
        <>
          <div className="rf-ops-summary">
            <div className={attentionCount > 0 ? "warning" : ""}>
              <span>
                {attentionCount > 0 ? (
                  <TriangleAlert size={15} />
                ) : (
                  <CheckCheck size={15} />
                )}
                Connection attention
              </span>
              <strong>
                {formatNumber(attentionCount)}
                <small>of {formatNumber(data.connections.length)}</small>
              </strong>
            </div>
            <div className={data.summary.dead > 0 ? "negative" : ""}>
              <span>
                <RefreshCw size={15} />
                Failed deliveries
              </span>
              <strong>
                {formatNumber(data.summary.dead)}
                <small>available in Recovery</small>
              </strong>
            </div>
            <div
              className={data.summary.disabledConnections > 0 ? "warning" : ""}
            >
              <span>
                <Unplug size={15} />
                Disabled connections
              </span>
              <strong>
                {formatNumber(data.summary.disabledConnections)}
                <small>in this scope</small>
              </strong>
            </div>
          </div>
          <div className="rf-ops-main-grid">
            <QueueBreakdown data={data} />
            <Infrastructure data={data} />
          </div>
          <section
            className="rf-ops-panel rf-ops-connections"
            aria-labelledby="ops-connections-title"
          >
            <div className="rf-ops-panel-heading">
              <div>
                <span className="rf-ops-section-label">CONNECTION TRIAGE</span>
                <h2 id="ops-connections-title">A place to start.</h2>
                <p>
                  Connections needing attention come first, then larger queued
                  and failed backlogs.
                </p>
              </div>
              <Button variant="ghost" onClick={openConnections}>
                Manage connections
                <ArrowRight size={13} />
              </Button>
            </div>
            {data.connections.length > 0 ? (
              <div className="rf-ops-connection-list">
                {data.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.endpointId}
                    connection={connection}
                    now={data.now}
                    openDeliveries={openDeliveries}
                    openRecovery={openRecovery}
                  />
                ))}
              </div>
            ) : (
              <div className="rf-ops-empty">
                <Globe2 size={25} />
                <strong>
                  {scope === "live"
                    ? "Your next connection starts here."
                    : "No lab receivers yet."}
                </strong>
                <p>
                  {scope === "live"
                    ? "Add a connection to see its queue and recovery status in one place."
                    : "Create a lab receiver to explore controlled delivery scenarios."}
                </p>
                <Button variant="secondary" onClick={openConnections}>
                  Open connections
                  <ArrowRight size={13} />
                </Button>
              </div>
            )}
            <p className="rf-ops-connections-note">
              Attention flags failed deliveries or queue issues: lease recovery,
              exhausted attempts, incomplete schedule or lease metadata, or
              queued work waiting on a disabled connection, workspace pause, or
              missing Live worker. Enabled connections are not a receiver health
              check.
            </p>
          </section>
          <details className="rf-ops-report-details">
            <summary>
              <span>
                <ShieldCheck size={14} /> About this report
              </span>
              <ChevronDown size={14} />
            </summary>
            <p>
              The JSON download contains counts, timestamps, worker metadata,
              and connection names and IDs. It excludes event payloads, producer
              tokens, signing keys, and destination URLs. Review connection
              names before sharing.
            </p>
          </details>
          <div className="rf-ops-footer">
            <span>
              <Clock3 size={12} />
              Observed {observedAt(data.now)}
            </span>
            <span>
              Queue & connections: {scope === "live" ? "Live" : "Lab"} · Shared
              worker signal · Capacity across scopes
            </span>
          </div>
        </>
      )}
    </div>
  );
}
