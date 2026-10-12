"use client";

import { AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Layers3,
  LoaderCircle,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Action,
  Delivery,
  DeliveryPage,
  ReplayBatchRequest,
  ReplayBatchResponse,
  Snapshot,
} from "@/lib/contracts";
import {
  Button,
  CloseButton,
  Dialog,
  EmptyState,
  formatNumber,
  fullDate,
  Pagination,
  relativeTime,
  StatusBadge,
} from "./relay-ui";

const stages = [
  "Event accepted",
  "Failure recorded",
  "Receiver repaired",
  "Event replayed",
  "Delivery recovered",
];
const stageIndex = {
  failing: 0,
  "awaiting-repair": 1,
  "ready-to-replay": 2,
  recovering: 3,
  completed: 4,
};
const cycleLabel = (cycle: number) =>
  cycle === 1 ? "Initial delivery" : `Replay ${cycle - 1}`;

export function RecoveryPanel({
  snapshot,
  busy,
  act,
  replayBatch,
  load,
  connectionError,
  inspect,
  onDialogChange,
}: {
  snapshot: Snapshot;
  busy: boolean;
  act: (action: Action, message?: string) => Promise<boolean>;
  replayBatch: (
    request: ReplayBatchRequest,
  ) => Promise<ReplayBatchResponse | null>;
  load: (query: string, signal: AbortSignal) => Promise<DeliveryPage>;
  connectionError: (error: unknown) => void;
  inspect: (id: string) => void;
  onDialogChange: (open: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [endpointId, setEndpointId] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    retry: number;
    data: DeliveryPage | null;
    error: string;
  } | null>(null);
  const [selectionState, setSelectionState] = useState<{
    key: string;
    records: Delivery[];
  }>({ key: "", records: [] });
  const [confirmation, setConfirmation] = useState<Delivery[] | null>(null);
  const [batchResult, setBatchResult] = useState<{
    response: ReplayBatchResponse;
    records: Delivery[];
  } | null>(null);
  const guideRef = useRef<HTMLHeadingElement>(null);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    search: debouncedSearch,
    status: "dead",
    endpointId,
  }).toString();
  const selectionKey = `${query}:${search}`;
  const selection =
    selectionState.key === selectionKey ? selectionState.records : [];
  const setSelection = (
    update: Delivery[] | ((previous: Delivery[]) => Delivery[]),
  ) =>
    setSelectionState((previous) => ({
      key: selectionKey,
      records:
        typeof update === "function"
          ? update(previous.key === selectionKey ? previous.records : [])
          : update,
    }));
  const current = result?.query === query ? result : null;
  const records = current?.data?.deliveries ?? [];
  const loading = !current || current.retry !== retry;
  const demo = snapshot.recoveryDemo;
  const currentStage = demo ? stageIndex[demo.stage] : -1;
  const managed = (record: Delivery) =>
    snapshot.endpoints.find((endpoint) => endpoint.id === record.endpointId)
      ?.purpose === "recovery";
  const available = records.filter((record) => !managed(record));
  const allSelected =
    available.length > 0 &&
    available.every((record) =>
      selection.some((item) => item.id === record.id),
    );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    load(query, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ query, retry, data, error: "" });
        if (page > data.totalPages && data.totalPages > 0)
          setPage(data.totalPages);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          query,
          retry,
          data: previous?.query === query ? previous.data : null,
          error:
            error instanceof Error
              ? error.message
              : "Unable to load failed deliveries.",
        }));
        connectionError(error);
      });
    return () => controller.abort();
  }, [query, page, retry, snapshot, load, connectionError]);
  useEffect(() => {
    onDialogChange(Boolean(confirmation));
    return () => onDialogChange(false);
  }, [confirmation, onDialogChange]);

  const openGuide = () => {
    guideRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "center",
    });
    guideRef.current?.focus({ preventScroll: true });
  };
  const toggle = (record: Delivery) =>
    setSelection((previous) =>
      previous.some((item) => item.id === record.id)
        ? previous.filter((item) => item.id !== record.id)
        : previous.length < 20
          ? [...previous, record]
          : previous,
    );
  const closeConfirmation = () => {
    if (busy) return;
    onDialogChange(false);
    setConfirmation(null);
  };
  const confirmReplay = async () => {
    if (!confirmation) return;
    const frozen = confirmation;
    const response = await replayBatch({
      items: frozen.map((record) => ({
        eventId: record.id,
        expectedCycle: record.currentCycle,
      })),
    });
    if (response) {
      setBatchResult({ response, records: frozen });
      setSelection([]);
      onDialogChange(false);
      setConfirmation(null);
    }
  };
  const lastFailure = (record: Delivery) =>
    record.latestAttempt?.error ||
    (record.latestAttempt?.statusCode
      ? `Receiver returned HTTP ${record.latestAttempt.statusCode}.`
      : "Delivery interrupted before acknowledgement.");
  const selectionControl = (record: Delivery) =>
    managed(record) ? (
      <button className="recovery-guide-link" onClick={openGuide}>
        Open recovery guide <ArrowRight size={13} />
      </button>
    ) : (
      <label className="recovery-check">
        <input
          type="checkbox"
          checked={selection.some((item) => item.id === record.id)}
          disabled={
            busy ||
            (selection.length >= 20 &&
              !selection.some((item) => item.id === record.id))
          }
          onChange={() => toggle(record)}
          aria-label={`Select ${record.eventType} ${record.id} for replay`}
        />
      </label>
    );
  const replayed =
    batchResult?.response.results.filter((item) => item.outcome === "replayed")
      .length ?? 0;
  const skipped = (batchResult?.response.results.length ?? 0) - replayed;
  return (
    <>
      <div className="page-header">
        <div>
          <span className="page-eyebrow">FAILURE → RECOVERY</span>
          <h1>Bring your pipeline back.</h1>
          <p>
            Find the cause, repair the receiver, and replay the original event.
          </p>
        </div>
        <div className="recovery-header-count">
          <span>{formatNumber(snapshot.metrics.dead)}</span>
          <small>failed deliveries</small>
        </div>
      </div>
      <section
        className={`recovery-lab ${demo?.stage === "completed" ? "is-complete" : ""}`}
        aria-labelledby="recovery-lab-title"
      >
        <div className="recovery-lab-intro">
          <span className="recovery-kicker">
            <Wrench size={14} /> RECOVERY LAB <span>LIVE SCENARIO</span>
          </span>
          <h2 ref={guideRef} id="recovery-lab-title" tabIndex={-1}>
            {demo?.stage === "completed"
              ? "Recovered. Nothing lost."
              : "A failure worth learning from."}
          </h2>
          <p>
            One signed event. Four failed attempts. Repair its dedicated
            receiver and follow the same event all the way to delivery.
          </p>
          {!demo ? (
            <Button
              disabled={busy}
              onClick={() =>
                act(
                  { type: "start-recovery-demo" },
                  "Recovery lab started. Follow the original event through its retries.",
                )
              }
            >
              <Play size={16} /> Start recovery lab
            </Button>
          ) : (
            <div className="recovery-lab-action">
              {demo.stage === "failing" && (
                <span className="recovery-wait">
                  <LoaderCircle size={16} className="spin" />{" "}
                  {snapshot.system.queuePaused
                    ? "Waiting for the queue to resume"
                    : `Recording failures · ${demo.delivery.attempts} of ${snapshot.system.maxAttempts} attempts`}
                </span>
              )}
              {demo.stage === "awaiting-repair" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(
                      {
                        type: "repair-recovery-demo",
                        eventId: demo.eventId,
                        expectedCycle: demo.delivery.currentCycle,
                      },
                      "Recovery receiver repaired. The original event is ready to replay.",
                    )
                  }
                >
                  <Wrench size={16} /> Repair receiver
                </Button>
              )}
              {demo.stage === "ready-to-replay" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(
                      {
                        type: "replay-recovery-demo",
                        eventId: demo.eventId,
                        expectedCycle: demo.delivery.currentCycle,
                      },
                      "Original event replayed. Its failure history remains intact.",
                    )
                  }
                >
                  <RotateCcw size={16} /> Replay original event
                </Button>
              )}
              {demo.stage === "recovering" && (
                <span className="recovery-wait">
                  <LoaderCircle size={16} className="spin" />{" "}
                  {snapshot.system.queuePaused
                    ? "Replay queued · resume to deliver"
                    : "Delivering the original event again"}
                </span>
              )}
              {demo.stage === "completed" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    act(
                      {
                        type: "start-recovery-demo",
                        previousEventId: demo.eventId,
                      },
                      "A new recovery scenario started. Previous history is preserved.",
                    )
                  }
                >
                  <RotateCcw size={16} /> Run again
                </Button>
              )}
              <button
                className="text-button"
                onClick={() => inspect(demo.eventId)}
              >
                Inspect event <ArrowRight size={14} />
              </button>
            </div>
          )}
          {snapshot.system.queuePaused && (
            <div className="recovery-pause">
              <span>
                <Clock3 size={14} /> Queue paused. Events stay persisted.
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
                <Play size={14} /> Resume
              </Button>
            </div>
          )}
        </div>
        <div className="recovery-lab-progress">
          <ol className="recovery-steps">
            {stages.map((label, index) => (
              <li
                key={label}
                className={
                  index < currentStage || demo?.stage === "completed"
                    ? "done"
                    : index === currentStage
                      ? "current"
                      : ""
                }
              >
                <span>
                  {index < currentStage || demo?.stage === "completed" ? (
                    <Check size={12} />
                  ) : (
                    index + 1
                  )}
                </span>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {
                      [
                        "Immutable payload + stable identity",
                        "Real retries, with a recorded response",
                        "Healthy receiver, ready to acknowledge",
                        "New cycle, preserved attempt history",
                        "Exactly one receiver effect",
                      ][index]
                    }
                  </small>
                </div>
                {index === currentStage && demo?.stage !== "completed" && <i />}
              </li>
            ))}
          </ol>
          {demo && (
            <div className="recovery-evidence">
              <button
                onClick={() => inspect(demo.eventId)}
                title={demo.eventId}
              >
                <span>SAME EVENT ID</span>
                <code>{demo.eventId}</code>
                <ArrowRight size={13} />
              </button>
              <div>
                <span>
                  <small>Current cycle</small>
                  <b>{cycleLabel(demo.delivery.currentCycle)}</b>
                </span>
                <span>
                  <small>Receiver effects</small>
                  <b
                    className={demo.businessEffects === 1 ? "success-text" : ""}
                  >
                    {demo.businessEffects}
                  </b>
                </span>
                <StatusBadge status={demo.delivery.status} />
              </div>
            </div>
          )}
        </div>
      </section>
      <div className="recovery-list-heading">
        <div>
          <h2>Failed deliveries</h2>
          <p>
            Durable history across every event, ready for a controlled replay.
          </p>
        </div>
        <span>
          <Layers3 size={14} />{" "}
          {formatNumber(current?.data?.total ?? snapshot.metrics.dead)} records
        </span>
      </div>
      <div className="toolbar recovery-toolbar">
        <label className="toolbar-search">
          <Search size={17} />
          <input
            value={search}
            maxLength={100}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search event type or ID…"
            aria-label="Search failed deliveries"
          />
        </label>
        <label className="filter-select">
          <span className="sr-only">Filter recovery destination</span>
          <select
            value={endpointId}
            onChange={(event) => {
              setEndpointId(event.target.value);
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
        <span className="recovery-filter-note">
          <i /> Failed deliveries only
        </span>
      </div>
      {current?.error && (
        <div className="notice error" role="alert">
          <span>{current.error}</span>
          <Button
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RotateCcw size={15} /> Retry
          </Button>
        </div>
      )}
      {batchResult && (
        <section className="recovery-result" aria-live="polite">
          <div>
            <CheckCheck size={19} />
            <span>
              <strong>
                {replayed} {replayed === 1 ? "event" : "events"} requeued ·{" "}
                {skipped} skipped
              </strong>
              <small>
                {snapshot.system.queuePaused
                  ? "Requeued events wait until the queue resumes."
                  : "Requeued events keep their identity and full attempt history."}
              </small>
            </span>
            <button
              className="icon-button"
              aria-label="Dismiss replay result"
              onClick={() => setBatchResult(null)}
            >
              <X size={16} />
            </button>
          </div>
          {skipped > 0 && (
            <details>
              <summary>Review skipped records</summary>
              {batchResult.response.results
                .filter((item) => item.outcome === "skipped")
                .map((item) => (
                  <p key={item.eventId}>
                    <code>{item.eventId}</code>
                    <span>
                      No longer eligible, changed, or unavailable. Refresh and
                      inspect before trying again.
                    </span>
                  </p>
                ))}
            </details>
          )}
        </section>
      )}
      <section className="panel recovery-records">
        <div className="delivery-list-head recovery-selection-bar">
          <span>
            {selection.length ? (
              <>
                <CheckCheck size={15} /> {selection.length} selected{" "}
                <button
                  className="text-button"
                  onClick={() => setSelection([])}
                >
                  Clear
                </button>
              </>
            ) : (
              <>
                <ShieldCheck size={15} /> Select up to 20 events
              </>
            )}
          </span>
          <div>
            <label>
              Rows{" "}
              <span className="select-wrap">
                <select
                  value={pageSize}
                  aria-label="Failed deliveries per page"
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                </select>
                <ChevronDown size={13} />
              </span>
            </label>
            <Button
              variant="secondary"
              disabled={busy || !selection.length}
              onClick={() => {
                onDialogChange(true);
                setConfirmation(selection.slice());
              }}
            >
              <RotateCcw size={15} /> Replay selected
              {selection.length ? ` (${selection.length})` : ""}
            </Button>
          </div>
        </div>
        {!current?.data && loading ? (
          <div className="list-loading">
            <LoaderCircle size={23} className="spin" />
            <span>Loading failed deliveries…</span>
          </div>
        ) : !records.length ? (
          <EmptyState
            title={
              search || endpointId !== "all"
                ? "No matching failures"
                : "No failed deliveries to recover"
            }
            description={
              search || endpointId !== "all"
                ? "Try another event type, ID, or receiver."
                : "Your queue is clear. Start the recovery lab to explore a real failure and repair."
            }
            search={Boolean(search || endpointId !== "all")}
          />
        ) : (
          <>
            <div className="desktop-deliveries">
              <table className="recovery-table">
                <thead>
                  <tr>
                    <th>
                      <label className="recovery-check">
                        <input
                          type="checkbox"
                          aria-label="Select all eligible failed deliveries on this page"
                          checked={allSelected}
                          disabled={busy || !available.length}
                          onChange={() =>
                            setSelection(
                              allSelected ? [] : available.slice(0, 20),
                            )
                          }
                        />
                      </label>
                    </th>
                    <th>Event / receiver</th>
                    <th>Last failure</th>
                    <th>Failed at</th>
                    <th>Cycle</th>
                    <th>
                      <span className="sr-only">Inspect</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((record) => (
                    <tr
                      key={record.id}
                      className={
                        selection.some((item) => item.id === record.id)
                          ? "is-selected"
                          : ""
                      }
                    >
                      <td>{selectionControl(record)}</td>
                      <td>
                        <button
                          className="event-cell"
                          onClick={() => inspect(record.id)}
                        >
                          <strong>{record.eventType}</strong>
                          <code>{record.id.slice(0, 21)}</code>
                          <small>{record.endpointName}</small>
                        </button>
                      </td>
                      <td>
                        <div className="recovery-failure">
                          <span className="recovery-http">
                            {record.latestAttempt?.statusCode
                              ? `HTTP ${record.latestAttempt.statusCode}`
                              : "INTERRUPTED"}
                          </span>
                          <p>{lastFailure(record)}</p>
                        </div>
                      </td>
                      <td>
                        <time title={fullDate(record.updatedAt)}>
                          {relativeTime(record.updatedAt, snapshot.system.now)}
                        </time>
                      </td>
                      <td>
                        <span className="recovery-cycle">
                          {cycleLabel(record.currentCycle)}
                        </span>
                        <small className="recovery-attempt-count">
                          {record.attempts} / {snapshot.system.maxAttempts}{" "}
                          attempts
                        </small>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          onClick={() => inspect(record.id)}
                          aria-label={`Inspect failed delivery ${record.id}`}
                        >
                          <ArrowRight size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="recovery-mobile-cards">
              {records.map((record) => (
                <article
                  key={record.id}
                  className={`recovery-mobile-card ${selection.some((item) => item.id === record.id) ? "is-selected" : ""}`}
                >
                  <div className="recovery-card-head">
                    {selectionControl(record)}
                    <button
                      className="event-cell"
                      onClick={() => inspect(record.id)}
                    >
                      <strong>{record.eventType}</strong>
                      <code>{record.id.slice(0, 23)}</code>
                    </button>
                    <span className="recovery-http">
                      {record.latestAttempt?.statusCode ?? "—"}
                    </span>
                  </div>
                  <p>{lastFailure(record)}</p>
                  <div className="recovery-card-meta">
                    <span>{record.endpointName}</span>
                    <span>{cycleLabel(record.currentCycle)}</span>
                    <time title={fullDate(record.updatedAt)}>
                      {relativeTime(record.updatedAt, snapshot.system.now)}
                    </time>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => inspect(record.id)}
                  >
                    Inspect attempts <ArrowRight size={14} />
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      <Pagination
        page={current?.data?.page ?? page}
        pageSize={pageSize}
        total={current?.data?.total ?? 0}
        totalPages={current?.data?.totalPages ?? 1}
        loading={loading}
        onPage={setPage}
      />
      <div className="recovery-footnote">
        <CircleHelp size={15} />
        <p>
          Replay resets the four-attempt budget. Repair a failing receiver
          first; unchanged behavior can lead to another failure.
        </p>
      </div>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {confirmation && (
              <Dialog
                title="Confirm selected replays"
                onClose={closeConfirmation}
              >
                <div className="modal-head">
                  <div>
                    <span className="modal-icon">
                      <RotateCcw size={20} />
                    </span>
                    <div>
                      <h2>
                        Replay {confirmation.length}{" "}
                        {confirmation.length === 1 ? "event" : "events"}?
                      </h2>
                      <p>Original identity. A new attempt cycle.</p>
                    </div>
                  </div>
                  <CloseButton
                    onClick={closeConfirmation}
                    label="Close replay confirmation"
                  />
                </div>
                <div className="modal-body recovery-confirm-body">
                  <p className="recovery-confirm-note">
                    Review current receiver behavior before requeuing. Events
                    changed in another tab will be skipped safely.
                  </p>
                  <ul className="recovery-confirm-list">
                    {confirmation.map((record) => {
                      const endpoint = snapshot.endpoints.find(
                        (item) => item.id === record.endpointId,
                      );
                      return (
                        <li key={record.id}>
                          <div>
                            <strong>{record.eventType}</strong>
                            <code>{record.id}</code>
                            <small>
                              {cycleLabel(record.currentCycle)} → Replay{" "}
                              {record.currentCycle}
                            </small>
                          </div>
                          <span>
                            <strong>
                              {endpoint?.name ?? record.endpointName}
                            </strong>
                            <b
                              className={
                                endpoint?.mode === "healthy"
                                  ? "success-text"
                                  : "danger-text"
                              }
                            >
                              {endpoint?.mode ?? "Unavailable"}
                            </b>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {snapshot.system.queuePaused && (
                    <p className="recovery-paused-confirm">
                      <Clock3 size={14} /> Queue paused. Replays will wait for
                      resume.
                    </p>
                  )}
                  <p className="recovery-preserved">
                    <ShieldCheck size={15} /> Payload, event ID, idempotency
                    key, and previous attempts stay preserved.
                  </p>
                </div>
                <div className="modal-foot">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={closeConfirmation}
                  >
                    Cancel
                  </Button>
                  <Button disabled={busy} onClick={confirmReplay}>
                    {busy ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <RotateCcw size={16} />
                    )}
                    {busy ? "Requeuing…" : "Confirm replay"}
                  </Button>
                </div>
              </Dialog>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
