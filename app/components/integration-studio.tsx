"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Copy,
  FlaskConical,
  Globe2,
  LoaderCircle,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type {
  DeliveryDetail,
  Snapshot,
  StudioAcceptance,
} from "@/lib/contracts";
import { api } from "@/lib/client-api";
import { Button, EmptyState, formatDuration, fullDate } from "./relay-ui";
import { ProductFlow, TransportBadge } from "./connections-panel";
import { RequestFeedback } from "./request-feedback";
import "./integrations.css";

export function IntegrationStudio({
  snapshot,
  endpointId,
  choose,
  update,
  inspect,
  connections,
  connectionError,
  keys,
}: {
  snapshot: Snapshot;
  endpointId: string;
  choose: (endpointId: string) => void;
  update: (snapshot: Snapshot) => void;
  inspect: (eventId: string) => void;
  connections: () => void;
  connectionError: (error: unknown) => void;
  keys: () => void;
}) {
  const endpoints = snapshot.endpoints.filter(
    (endpoint) => endpoint.enabled && endpoint.purpose === "standard",
  );
  const destination =
    endpoints.find((endpoint) => endpoint.id === endpointId) ??
    endpoints.find((endpoint) => endpoint.transport !== "demo") ??
    endpoints[0];
  const [eventType, setEventType] = useState("invoice.paid");
  const [payload, setPayload] = useState(
    '{\n  "invoiceId": "inv_1042",\n  "amount": 14900,\n  "currency": "USD"\n}',
  );
  const [idempotencyKey, setIdempotencyKey] = useState("invoice-1042-paid");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [accepted, setAccepted] = useState<StudioAcceptance | null>(null);
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("http://localhost:3000");
  const pendingRef = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!accepted) return;
    const controller = new AbortController();
    api<DeliveryDetail>(
      `/api/deliveries/${encodeURIComponent(accepted.eventId)}`,
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          setDetail(data);
          setDetailError(null);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setDetailError(err);
          connectionError(err);
        }
      });
    return () => controller.abort();
  }, [accepted, snapshot.system.now, connectionError]);
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(payload);
    if (value && typeof value === "object" && !Array.isArray(value))
      parsed = value as Record<string, unknown>;
  } catch {
    /* Inline validation describes the editor state. */
  }
  const payloadBytes = new TextEncoder().encode(payload).byteLength;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pendingRef.current) return;
    setError(null);
    if (!destination)
      return setError(new Error("Choose an enabled connection first."));
    if (!parsed)
      return setError(new Error("The payload must be a valid JSON object."));
    if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 12_288)
      return setError(new Error("The payload must be smaller than 12 KB."));
    if (!idempotencyKey.trim())
      return setError(
        new Error("Enter an idempotency key to identify this event."),
      );
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await api<StudioAcceptance>(
        `/api/connections/${encodeURIComponent(destination.id)}/events`,
        {
          eventType: eventType.trim(),
          payload: parsed,
          idempotencyKey: idempotencyKey.trim(),
        },
      );
      setDetail(null);
      setDetailError(null);
      setAccepted(result);
      update(result.snapshot);
    } catch (err) {
      setError(err);
      connectionError(err);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const curl = `curl -X POST '${origin}/api/v1/events' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: ${idempotencyKey.replace(/[\r\n']/g, "") || "YOUR_IDEMPOTENCY_KEY"}' \\\n  --data '${JSON.stringify({ eventType, payload: parsed ?? {} }, null, 2).replace(/'/g, "'\\''")}'`;
  const event = detail?.delivery;
  const live = event
    ? event.transport !== "demo"
    : destination?.transport !== "demo";
  return (
    <>
      <div className="rf-product-header">
        <div>
          <span className="rf-eyebrow">
            <i />
            BUILD / INTEGRATION STUDIO
          </span>
          <h1>One event. The whole journey.</h1>
          <p>
            Compose a webhook, send it through the real queue, and watch each
            acknowledgement and retry arrive.
          </p>
        </div>
        <div className="rf-header-actions">
          <Button variant="secondary" onClick={connections}>
            <Globe2 size={16} />
            Connections
          </Button>
        </div>
      </div>
      <ProductFlow current="Send" />
      {!endpoints.length ? (
        <section className="rf-studio-panel">
          <EmptyState
            title="Connect a destination first"
            description="Your events need an enabled connection before they can enter the delivery queue."
          >
            <Button onClick={connections}>
              <ArrowRight size={16} />
              Open connections
            </Button>
          </EmptyState>
        </section>
      ) : (
        <div className="rf-studio">
          <form className="rf-studio-panel" onSubmit={submit}>
            <div className="rf-studio-head">
              <h2>
                <Code2 size={16} />
                Event composer
              </h2>
              <span>APPLICATION/JSON</span>
            </div>
            <div className="rf-studio-body">
              <label className="field">
                <span className="field-label">Destination connection</span>
                <span className="select-wrap">
                  <select
                    value={destination?.id ?? ""}
                    onChange={(event) => choose(event.target.value)}
                    disabled={pending}
                  >
                    {endpoints.map((endpoint) => (
                      <option key={endpoint.id} value={endpoint.id}>
                        {endpoint.name} ·{" "}
                        {endpoint.transport === "demo"
                          ? "Lab"
                          : endpoint.transport === "reference"
                            ? "Reference"
                            : "HTTPS"}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </span>
              </label>
              {destination && (
                <div
                  className="destination-preview"
                  style={{ marginBottom: 21 }}
                >
                  <span className="rf-connection-symbol">
                    {destination.transport === "demo" ? (
                      <FlaskConical size={17} />
                    ) : destination.transport === "reference" ? (
                      <Terminal size={17} />
                    ) : (
                      <Globe2 size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{destination.name}</strong>
                    <code title={destination.url}>{destination.url}</code>
                  </div>
                  <TransportBadge endpoint={destination} />
                </div>
              )}
              <label className="field">
                <span className="field-label">Event type</span>
                <input
                  value={eventType}
                  onChange={(event) => setEventType(event.target.value)}
                  required
                  maxLength={64}
                  pattern="[a-zA-Z][a-zA-Z0-9._\-]{0,63}"
                  autoComplete="off"
                  placeholder="invoice.paid"
                />
              </label>
              <label className="field">
                <span className="field-label">JSON payload</span>
                <span className="rf-studio-json">
                  <span className="sr-only">Payload editor</span>
                  <div aria-hidden="true">
                    <span>payload.json</span>
                    <span>{payloadBytes.toLocaleString("en-US")} BYTES</span>
                  </div>
                  <textarea
                    value={payload}
                    onChange={(event) => setPayload(event.target.value)}
                    required
                    spellCheck={false}
                    rows={7}
                  />
                </span>
                <span className={`field-hint ${parsed ? "valid" : ""}`}>
                  <Code2 size={12} />
                  {parsed ? "Valid JSON object" : "Enter a JSON object"} · 12 KB
                  limit
                </span>
              </label>
              <label className="field">
                <span className="field-label">
                  Idempotency key <small>Required</small>
                </span>
                <input
                  value={idempotencyKey}
                  onChange={(event) => setIdempotencyKey(event.target.value)}
                  required
                  maxLength={128}
                  autoComplete="off"
                  placeholder="invoice-1042-paid"
                />
                <span className="field-hint">
                  Same connection, key, and payload return the original event.
                </span>
              </label>
              <RequestFeedback error={error} />
            </div>
            <div className="rf-studio-submit">
              <span>
                <ShieldCheck size={13} />
                {destination?.transport === "demo"
                  ? "Isolated lab delivery"
                  : "Signed background delivery"}
              </span>
              <Button type="submit" disabled={pending || !destination}>
                {pending ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Send size={15} />
                )}
                {pending ? "Accepting…" : "Send event"}
              </Button>
            </div>
          </form>
          <div className="rf-studio-right">
            <section className="rf-studio-panel" aria-live="polite">
              <div className="rf-studio-head">
                <h2>
                  <RadioIcon />
                  Delivery journey
                </h2>
                {event && <span>CYCLE {event.currentCycle}</span>}
              </div>
              {!accepted ? (
                <div className="rf-studio-empty">
                  <span>
                    <Send size={22} />
                  </span>
                  <h3>Your event’s story starts here.</h3>
                  <p>
                    Send an event to see its queue state, real HTTP results, and
                    complete attempt timeline.
                  </p>
                </div>
              ) : (
                <div className="rf-event-live">
                  <span
                    className={`rf-state ${event?.status === "delivered" ? "positive" : event?.status === "dead" ? "failure" : "warning"}`}
                  >
                    <i />
                    {event?.status === "delivered"
                      ? live
                        ? "Acknowledged"
                        : "Delivered"
                      : event?.status === "dead"
                        ? "Delivery failed"
                        : snapshot.system.queuePaused
                          ? "Queue paused"
                          : snapshot.system.processor !== "worker" && live
                            ? "Waiting for worker"
                            : event?.status === "retrying"
                              ? "Waiting for retry"
                              : "Accepted into queue"}
                    {accepted.duplicate && " · Original event"}
                  </span>
                  <code className="rf-event-id">{accepted.eventId}</code>
                  <ol className="rf-timeline">
                    <li>
                      <span className="rf-timeline-mark">
                        <Check size={12} />
                      </span>
                      <div>
                        <h4>
                          {accepted.duplicate
                            ? "Idempotency matched the original event"
                            : "Event accepted and persisted"}
                        </h4>
                        <p>
                          The event ID and payload remain stable through retries
                          and replay.
                        </p>
                      </div>
                    </li>
                    {(detail?.attempts ?? []).map((attempt) => (
                      <li key={attempt.id}>
                        <span
                          className={`rf-timeline-mark ${attempt.finishedAt === null ? "pending" : attempt.statusCode !== null && attempt.statusCode >= 200 && attempt.statusCode < 300 ? "" : "bad"}`}
                        >
                          {attempt.finishedAt === null ? (
                            <Clock3 size={12} />
                          ) : attempt.statusCode !== null &&
                            attempt.statusCode >= 200 &&
                            attempt.statusCode < 300 ? (
                            <Check size={12} />
                          ) : (
                            <X size={12} />
                          )}
                        </span>
                        <div>
                          <h4>
                            {attempt.cycle === null
                              ? "Legacy"
                              : attempt.cycle === 1
                                ? "Initial"
                                : `Replay ${attempt.cycle - 1}`}{" "}
                            · Attempt {attempt.number} ·{" "}
                            {attempt.finishedAt === null
                              ? "In progress"
                              : attempt.statusCode !== null
                                ? `HTTP ${attempt.statusCode}`
                                : "Network failure"}
                          </h4>
                          <p>
                            {attempt.error ??
                              (attempt.finishedAt === null
                                ? "Waiting for the receiver."
                                : "Receiver acknowledged this event.")}{" "}
                            {attempt.finishedAt !== null &&
                              `· ${formatDuration(attempt.durationMs)}`}
                          </p>
                          {attempt.failureCode && (
                            <code>{attempt.failureCode}</code>
                          )}
                        </div>
                      </li>
                    ))}
                    {event?.nextAttemptAt && (
                      <li>
                        <span className="rf-timeline-mark pending">
                          <Clock3 size={12} />
                        </span>
                        <div>
                          <h4>Next attempt scheduled</h4>
                          <p>{fullDate(event.nextAttemptAt)}</p>
                        </div>
                      </li>
                    )}
                  </ol>
                  {live &&
                    snapshot.system.processor !== "worker" &&
                    event?.status !== "delivered" &&
                    event?.status !== "dead" && (
                      <p>
                        Start the background worker to process this live
                        connection. Your event remains safely queued.
                      </p>
                    )}
                  {event?.status === "delivered" && live && (
                    <p>
                      HTTP success confirms acknowledgement. A remote
                      application’s business effect cannot be verified from this
                      response.
                    </p>
                  )}
                  <RequestFeedback error={detailError} focus={false} />
                  <Button
                    variant="secondary"
                    onClick={() => inspect(accepted.eventId)}
                  >
                    <ArrowRight size={14} />
                    Open full inspector
                  </Button>
                </div>
              )}
            </section>
            <section className="rf-studio-panel">
              <div className="rf-studio-head">
                <h2>
                  <Terminal size={15} />
                  Send from your application
                </h2>
                {destination?.transport !== "demo" && (
                  <button
                    className="text-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(curl);
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 2000);
                      } catch {
                        setError(
                          new Error(
                            "Select the request example to copy it manually.",
                          ),
                        );
                      }
                    }}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
              {destination?.transport === "demo" ? (
                <div className="rf-studio-empty">
                  <span>
                    <FlaskConical size={20} />
                  </span>
                  <h3>Lab events stay inside the workspace.</h3>
                  <p>
                    Choose a live connection to use the producer API with a
                    scoped key from your application.
                  </p>
                </div>
              ) : (
                <>
                  <pre className="rf-curl" tabIndex={0}>
                    {curl}
                  </pre>
                  <div className="rf-observation">
                    <ShieldCheck size={13} />
                    Use a producer key scoped to this connection.{" "}
                    <button className="text-button" onClick={keys}>
                      Manage API keys <ArrowRight size={12} />
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}

function RadioIcon() {
  return <span className="live-dot" aria-hidden="true" />;
}
