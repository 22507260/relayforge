"use client";

import {
  ArrowRight,
  ChevronDown,
  Clock3,
  GitBranch,
  LoaderCircle,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AuditPage } from "@/lib/contracts";
import {
  auditQueryFor,
  deliveryKinds,
  securityKinds,
  type NavigationState,
} from "@/lib/navigation";
import { Button, EmptyState, formatNumber, fullDate } from "./relay-ui";

const dateInput = (value: number | null) =>
  value === null ? "" : new Date(value).toISOString().slice(0, 19);
const label = (kind: string) =>
  kind.replaceAll("-", " ").replace(/^./, (first) => first.toUpperCase());
export function AuditExplorer({
  navigation,
  change,
  now,
  load,
  connectionError,
  inspect,
  hrefForEvent,
}: {
  navigation: NavigationState;
  change: (patch: Partial<NavigationState>, replace?: boolean) => void;
  now: number;
  load: (query: string, signal: AbortSignal) => Promise<AuditPage>;
  connectionError: (error: unknown) => void;
  inspect: (id: string) => void;
  hrefForEvent: (id: string) => string;
}) {
  const [search, setSearch] = useState(navigation.q);
  const [searchSource, setSearchSource] = useState(navigation.q);
  if (searchSource !== navigation.q) {
    setSearchSource(navigation.q);
    setSearch(navigation.q);
  }
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    data: AuditPage | null;
    error: string;
  } | null>(null);
  const [from, setFrom] = useState(dateInput(navigation.from));
  const [to, setTo] = useState(dateInput(navigation.to));
  const [dateSource, setDateSource] = useState(
    `${navigation.from}:${navigation.to}`,
  );
  if (dateSource !== `${navigation.from}:${navigation.to}`) {
    setDateSource(`${navigation.from}:${navigation.to}`);
    setFrom(dateInput(navigation.from));
    setTo(dateInput(navigation.to));
  }
  const [dateError, setDateError] = useState("");
  const dateErrorRef = useRef<HTMLParagraphElement>(null);
  const queryValues = auditQueryFor(navigation);
  const params = new URLSearchParams({
    page: String(queryValues.page),
    pageSize: String(queryValues.pageSize),
    search: queryValues.search,
    category: queryValues.category,
    kind: queryValues.kind,
    eventId: queryValues.eventId,
    operationId: queryValues.operationId,
  });
  if (queryValues.from !== null) params.set("from", String(queryValues.from));
  if (queryValues.to !== null) params.set("to", String(queryValues.to));
  const query = params.toString();
  const current = result?.query === query ? result : null;
  const loading = !current;
  useEffect(() => {
    if (search.trim() === navigation.q) return;
    const timer = window.setTimeout(
      () => change({ q: search.trim(), page: 1 }, true),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search, navigation.q, change]);
  useEffect(() => {
    const controller = new AbortController();
    load(query, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setResult({ query, data, error: "" });
        if (data.totalPages > 0 && navigation.page > data.totalPages)
          change({ page: data.totalPages }, true);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          query,
          data: previous?.query === query ? previous.data : null,
          error:
            error instanceof Error
              ? error.message
              : "Unable to load audit records.",
        }));
        connectionError(error);
      });
    return () => controller.abort();
  }, [query, navigation.page, now, retry, load, connectionError, change]);
  useEffect(() => {
    if (dateError) dateErrorRef.current?.focus();
  }, [dateError]);
  const applyDates = () => {
    const fromValue = from ? Date.parse(`${from}Z`) : null;
    const toValue = to ? Date.parse(`${to}Z`) : null;
    if (
      (fromValue !== null && (!Number.isFinite(fromValue) || fromValue < 0)) ||
      (toValue !== null && (!Number.isFinite(toValue) || toValue < 0))
    ) {
      setDateError("Enter valid dates on or after 1 January 1970.");
      return;
    }
    if (fromValue !== null && toValue !== null && fromValue > toValue) {
      setDateError("The start date must be before the end date.");
      return;
    }
    setDateError("");
    change({ from: fromValue, to: toValue, page: 1 });
  };
  const kinds =
    navigation.category === "security"
      ? securityKinds
      : navigation.category === "delivery"
        ? deliveryKinds
        : [...deliveryKinds, ...securityKinds];
  return (
    <>
      <div className="page-header">
        <div>
          <span className="page-eyebrow">WORKSPACE AUDIT</span>
          <h1>Activity</h1>
          <p>
            Search the complete delivery and account history. All date filters
            use UTC.
          </p>
        </div>
        <span className="audit-record-count">
          <GitBranch size={16} />
          {current?.data
            ? `${formatNumber(current.data.total)} records`
            : "Syncing history"}
        </span>
      </div>
      <div className="toolbar audit-toolbar">
        <label className="toolbar-search">
          <Search size={17} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={100}
            placeholder="Search messages, event IDs…"
            aria-label="Search audit records"
          />
        </label>
        <label className="filter-select">
          <span className="sr-only">Audit category</span>
          <select
            value={navigation.category}
            onChange={(event) =>
              change({
                category: event.target.value as NavigationState["category"],
                kind: "all",
                page: 1,
              })
            }
          >
            <option value="all">All categories</option>
            <option value="delivery">Delivery</option>
            <option value="security">Security</option>
          </select>
          <ChevronDown size={15} />
        </label>
        <label className="filter-select">
          <span className="sr-only">Audit action</span>
          <select
            value={navigation.kind}
            onChange={(event) =>
              change({
                kind: event.target.value as NavigationState["kind"],
                page: 1,
              })
            }
          >
            <option value="all">All actions</option>
            {kinds.map((kind) => (
              <option value={kind} key={kind}>
                {label(kind)}
              </option>
            ))}
          </select>
          <ChevronDown size={15} />
        </label>
      </div>
      <div className="audit-date-toolbar">
        <label>
          From (UTC)
          <input
            type="datetime-local"
            step="1"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          To (UTC)
          <input
            type="datetime-local"
            step="1"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <Button variant="secondary" onClick={applyDates}>
          <Clock3 size={15} />
          Apply dates
        </Button>
        {(navigation.from !== null || navigation.to !== null) && (
          <Button
            variant="ghost"
            onClick={() => {
              setDateError("");
              change({ from: null, to: null, page: 1 });
            }}
          >
            Clear dates
          </Button>
        )}
      </div>
      {dateError && (
        <p
          className="inline-error"
          ref={dateErrorRef}
          tabIndex={-1}
          role="alert"
        >
          {dateError}
        </p>
      )}
      {(navigation.operation !== "all" || navigation.auditEvent !== "all") && (
        <div className="audit-filter-chips">
          {navigation.operation !== "all" && (
            <button onClick={() => change({ operation: "all", page: 1 })}>
              Operation <code>{navigation.operation.slice(0, 20)}</code>
              <X size={14} />
              <span className="sr-only">Clear operation filter</span>
            </button>
          )}
          {navigation.auditEvent !== "all" && (
            <button onClick={() => change({ auditEvent: "all", page: 1 })}>
              Event <code>{navigation.auditEvent.slice(0, 20)}</code>
              <X size={14} />
              <span className="sr-only">Clear event filter</span>
            </button>
          )}
        </div>
      )}
      {current?.error && (
        <div className="notice error" role="alert">
          {current.error}
          <Button
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      <section className="panel audit-list" aria-busy={loading}>
        <div className="delivery-list-head">
          <span>
            <i className="live-dot" />
            {loading ? "Loading audit history" : "Recorded workspace history"}
          </span>
          <label>
            Rows
            <span className="select-wrap">
              <select
                value={navigation.size}
                aria-label="Audit records per page"
                onChange={(event) =>
                  change({ size: Number(event.target.value), page: 1 })
                }
              >
                {[10, 20, 50].map((size) => (
                  <option value={size} key={size}>
                    {size}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </span>
          </label>
        </div>
        {loading ? (
          <div className="list-loading">
            <LoaderCircle className="spin" size={23} />
            Loading audit records…
          </div>
        ) : !current?.data?.records.length ? (
          <EmptyState
            title="No matching audit records"
            description="Try a different action, search term, or UTC date range."
            search
          />
        ) : (
          current.data.records.map((record) => (
            <article
              className="audit-record"
              key={`${record.category}:${record.id}`}
            >
              <span
                className={`activity-icon ${record.category === "security" ? "purple" : record.kind === "dead" || record.kind === "retry" ? "amber" : "green"}`}
              >
                {record.category === "security" ? (
                  <ShieldCheck size={18} />
                ) : (
                  <GitBranch size={18} />
                )}
              </span>
              <div className="audit-record-body">
                <div>
                  <strong>{label(record.kind)}</strong>
                  <span className={`audit-category ${record.category}`}>
                    {record.category}
                  </span>
                  {record.cycle !== null && (
                    <small>
                      {record.cycle === 1
                        ? "Initial delivery"
                        : `Replay ${record.cycle - 1}`}
                    </small>
                  )}
                </div>
                <p>{record.message}</p>
                <div className="audit-record-links">
                  {record.eventId && (
                    <>
                      <a
                        href={hrefForEvent(record.eventId)}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          inspect(record.eventId!);
                        }}
                      >
                        {record.eventId.slice(0, 24)}
                        <ArrowRight size={13} />
                      </a>
                      <button
                        onClick={() =>
                          change({ auditEvent: record.eventId!, page: 1 })
                        }
                      >
                        Event history
                      </button>
                    </>
                  )}
                  {record.operationId && (
                    <button
                      className="audit-operation-link"
                      title={record.operationId}
                      onClick={() =>
                        change({ operation: record.operationId!, page: 1 })
                      }
                    >
                      <GitBranch size={12} />
                      Operation {record.operationId.slice(0, 15)}
                    </button>
                  )}
                </div>
              </div>
              <time
                dateTime={new Date(record.createdAt).toISOString()}
                title={fullDate(record.createdAt)}
              >
                {new Date(record.createdAt)
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 19)}
                <small>UTC</small>
              </time>
            </article>
          ))
        )}
      </section>
      <div className="pagination">
        <span aria-live="polite">
          {loading ? (
            "Loading audit records…"
          ) : (
            <>
              Showing{" "}
              <b>
                {current?.data?.total
                  ? (current.data.page - 1) * navigation.size + 1
                  : 0}
                –
                {Math.min(
                  (current?.data?.page ?? navigation.page) * navigation.size,
                  current?.data?.total ?? 0,
                )}
              </b>{" "}
              of <b>{formatNumber(current?.data?.total ?? 0)}</b> records
            </>
          )}
        </span>
        <div>
          <Button
            variant="secondary"
            disabled={loading || navigation.page <= 1}
            onClick={() => change({ page: navigation.page - 1 })}
          >
            Previous
          </Button>
          <span className="page-counter">
            {loading
              ? "…"
              : `${current?.data?.page ?? navigation.page} / ${current?.data?.totalPages ?? 1}`}
          </span>
          <Button
            variant="secondary"
            disabled={
              loading || navigation.page >= (current?.data?.totalPages ?? 1)
            }
            onClick={() => change({ page: navigation.page + 1 })}
          >
            Next
          </Button>
        </div>
      </div>
    </>
  );
}
