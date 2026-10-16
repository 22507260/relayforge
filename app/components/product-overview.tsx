"use client";

import {
  ArrowRight,
  CheckCheck,
  Clock3,
  Code2,
  FlaskConical,
  Globe2,
  Layers3,
  Plus,
  Send,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Snapshot } from "@/lib/contracts";
import {
  Button,
  DeliveryChart,
  DeliveryTable,
  formatNumber,
  PanelHeading,
  ViewAll,
} from "./relay-ui";
import { ProductFlow, TransportBadge } from "./connections-panel";
import "./integrations.css";

export function ProductOverview({
  snapshot,
  scope,
  changeScope,
  connections,
  studio,
  deliveries,
  recovery,
  engineering,
  demo,
  busy,
  inspect,
  hrefForEvent,
}: {
  snapshot: Snapshot;
  scope: "live" | "lab";
  changeScope: (scope: "live" | "lab") => void;
  connections: () => void;
  studio: () => void;
  deliveries: () => void;
  recovery: () => void;
  engineering: () => void;
  demo: () => void;
  busy: boolean;
  inspect: (eventId: string) => void;
  hrefForEvent: (eventId: string) => string;
}) {
  const data = snapshot.scopes[scope];
  const metrics = data.metrics;
  const endpoints = snapshot.endpoints.filter((endpoint) =>
    scope === "lab"
      ? endpoint.transport === "demo"
      : endpoint.transport !== "demo",
  );
  const rows = data.deliveries.slice(0, 6);
  const emptyLive = scope === "live" && metrics.total === 0;
  const online = snapshot.system.processor === "worker";
  const cards = [
    {
      label: "Accepted events",
      value: formatNumber(metrics.total),
      note:
        scope === "live" ? "Persisted before delivery" : "Isolated lab events",
      Icon: Layers3,
      tone: "",
    },
    {
      label: scope === "live" ? "Acknowledged" : "Delivered",
      value: formatNumber(metrics.delivered),
      note: `${metrics.successRate.toFixed(1)}% of accepted events`,
      Icon: CheckCheck,
      tone: "lime",
    },
    {
      label: "In the queue",
      value: formatNumber(metrics.queued),
      note: snapshot.system.queuePaused
        ? "Processing is paused"
        : online
          ? "Background worker online"
          : scope === "live"
            ? "Waiting for background worker"
            : "Browser fallback available",
      Icon: Clock3,
      tone: "",
    },
    {
      label: "Needs recovery",
      value: formatNumber(metrics.dead),
      note: "Complete history preserved",
      Icon: Wrench,
      tone: metrics.dead ? "red" : "",
    },
  ];
  return (
    <>
      <div className="rf-product-header">
        <div>
          <span className="rf-eyebrow">
            <i />
            OPERATE / OVERVIEW <span className="rf-version">2.0</span>
          </span>
          <h1>
            {scope === "live"
              ? "Every event deserves to arrive."
              : "Break it. Understand it. Recover it."}
          </h1>
          <p>
            {scope === "live"
              ? "A clear view of your real integrations, from durable acceptance to the receiver’s response."
              : "A separate workspace view for controlled failures, retry budgets, and the recovery guide."}
          </p>
        </div>
        <div className="rf-header-actions">
          <div className="rf-scope" aria-label="Overview scope">
            <button
              aria-pressed={scope === "live"}
              onClick={() => changeScope("live")}
            >
              <Globe2 size={13} />
              Live
            </button>
            <button
              aria-pressed={scope === "lab"}
              onClick={() => changeScope("lab")}
            >
              <FlaskConical size={13} />
              Lab
            </button>
          </div>
          <Button onClick={scope === "live" ? studio : demo} disabled={busy}>
            <Send size={15} />
            {scope === "live" ? "Send event" : "Run lab demo"}
          </Button>
        </div>
      </div>
      {emptyLive && (
        <>
          <section className="rf-onboard">
            <div className="rf-onboard-copy">
              <span className="rf-eyebrow">
                <i />
                YOUR FIRST LIVE INTEGRATION
              </span>
              <h2>
                Ship a webhook.
                <br />
                Keep the proof.
              </h2>
              <p>
                Connect a service and send one event. RelayForge signs the
                request, records every attempt, and keeps recovery within reach.
              </p>
              <div className="rf-onboard-actions">
                <Button onClick={connections}>
                  <Plus size={15} />
                  {endpoints.length
                    ? "View connections"
                    : "Connect a destination"}
                </Button>
                <button
                  className="text-button"
                  onClick={() => changeScope("lab")}
                >
                  Explore the Lab <ArrowRight size={14} />
                </button>
              </div>
            </div>
            <div className="rf-onboard-visual" aria-hidden="true">
              <span className="rf-wire" />
              <div className="rf-system-node">
                <Code2 size={24} />
                YOUR APP<small>EVENT PRODUCER</small>
              </div>
              <div className="rf-system-node main">
                <ShieldCheck size={25} />
                RELAYFORGE<small>DURABLE QUEUE</small>
              </div>
              <div className="rf-system-node">
                <Globe2 size={24} />
                RECEIVER<small>HTTP RESPONSE</small>
              </div>
              <span className="rf-onboard-proof">
                ONE ID · EVERY ATTEMPT · FULL HISTORY
              </span>
            </div>
          </section>
          <div className="rf-step-grid">
            <article className="rf-step-card">
              <span>
                <Globe2 size={20} />
                <small>01 / CONNECT</small>
              </span>
              <h3>A destination you control</h3>
              <p>
                Add an allowed HTTPS address or the independent local reference
                receiver.
              </p>
              <button onClick={connections}>
                Set up a connection <ArrowRight size={13} />
              </button>
            </article>
            <article className="rf-step-card">
              <span>
                <Terminal size={20} />
                <small>02 / SEND</small>
              </span>
              <h3>Your payload, your event</h3>
              <p>
                Use Integration Studio or a scoped producer key. Acceptance
                happens before delivery.
              </p>
              <button onClick={studio}>
                Open Integration Studio <ArrowRight size={13} />
              </button>
            </article>
            <article className="rf-step-card">
              <span>
                <Wrench size={20} />
                <small>03 / UNDERSTAND</small>
              </span>
              <h3>A failure is a starting point</h3>
              <p>
                Read HTTP responses, inspect retry cycles, and replay with the
                original event identity.
              </p>
              <button onClick={recovery}>
                Explore recovery <ArrowRight size={13} />
              </button>
            </article>
          </div>
        </>
      )}
      {!emptyLive && (
        <ProductFlow
          current={
            metrics.dead ? "Recover" : metrics.total ? "Inspect" : "Send"
          }
        />
      )}
      <div className="rf-metric-grid">
        {cards.map(({ label, value, note, Icon, tone }) => (
          <article className={`rf-live-metric ${tone}`} key={label}>
            <span>
              <Icon size={15} />
              {label}
            </span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
      <div className="rf-overview-pair">
        <section className="panel chart-panel">
          <PanelHeading
            title="Delivery signals"
            description="Acknowledged and failed attempts over the last 10 minutes"
          >
            <span className="time-range">
              <Clock3 size={13} />
              {scope === "live" ? "LIVE" : "LAB"} · UTC
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
          </div>
          <DeliveryChart data={data.chart} />
        </section>
        <section className="rf-studio-panel">
          <div className="rf-studio-head">
            <h2>
              <Globe2 size={15} />
              {scope === "live" ? "Your connections" : "Lab receivers"}
            </h2>
            <ViewAll onClick={connections} />
          </div>
          {endpoints.length ? (
            endpoints.map((endpoint) => (
              <button
                className="rf-connection-mini"
                key={endpoint.id}
                onClick={connections}
              >
                {endpoint.transport === "demo" ? (
                  <FlaskConical size={16} />
                ) : endpoint.transport === "reference" ? (
                  <Terminal size={16} />
                ) : (
                  <Globe2 size={16} />
                )}
                <span>
                  <strong>{endpoint.name}</strong>
                  <small>
                    {endpoint.delivered}{" "}
                    {scope === "live" ? "acknowledged" : "delivered"} ·{" "}
                    {endpoint.deliveries} accepted
                  </small>
                </span>
                <TransportBadge endpoint={endpoint} />
              </button>
            ))
          ) : (
            <div className="rf-studio-empty">
              <span>
                <Globe2 size={21} />
              </span>
              <h3>No live connection yet</h3>
              <p>
                A connected destination brings your real delivery signals to
                this page.
              </p>
            </div>
          )}
          <div className="rf-observation">
            <ShieldCheck size={13} />
            {scope === "live"
              ? "HTTP success confirms acknowledgement. Remote business effects remain outside RelayForge’s observation."
              : "Lab effects are verified locally and kept separate from live integration metrics."}
          </div>
        </section>
      </div>
      <section className="panel table-panel">
        <PanelHeading
          title="Recent deliveries"
          description={
            scope === "live"
              ? "The latest real integration events in this workspace"
              : "Controlled events from the Reliability Lab"
          }
        >
          <ViewAll onClick={deliveries} />
        </PanelHeading>
        <DeliveryTable
          rows={rows}
          onSelect={inspect}
          hrefForEvent={hrefForEvent}
          now={snapshot.system.now}
          maxAttempts={snapshot.system.maxAttempts}
          emptyAction={
            <Button
              variant="secondary"
              onClick={scope === "live" ? studio : demo}
              disabled={busy}
            >
              <Send size={14} />
              {scope === "live" ? "Send your first event" : "Run lab demo"}
            </Button>
          }
        />
      </section>
      <div className="integrity-strip">
        <span>
          <ShieldCheck size={15} />
          <strong>{formatNumber(metrics.duplicatesPrevented)}</strong>{" "}
          duplicates prevented
        </span>
        {scope === "lab" && (
          <span>
            <CheckCheck size={15} />
            <strong>{formatNumber(metrics.businessEffects)}</strong> verified
            lab effects
          </span>
        )}
        <button onClick={engineering}>
          How delivery works <ArrowRight size={13} />
        </button>
      </div>
    </>
  );
}
