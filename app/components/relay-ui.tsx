"use client";

import { motion } from "motion/react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Inbox,
  LoaderCircle,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  ConnectionTransport,
  Delivery,
  DeliveryStatus,
} from "@/lib/contracts";

export const statusNames: Record<DeliveryStatus, string> = {
  pending: "Queued",
  delivered: "Delivered",
  retrying: "Retrying",
  dead: "Failed",
};
export const formatNumber = (value: number) => value.toLocaleString("en-US");
export const formatDuration = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value >= 1000
      ? `${(value / 1000).toFixed(1)} s`
      : `${value} ms`;
export const formatTime = (value: number) =>
  new Date(value).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const fullDate = (value: number) =>
  new Date(value).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
export function relativeTime(value: number, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 5) return "Just now";
  if (seconds < 60) return `${seconds} sec ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

export function Logo() {
  return (
    <span className="relay-logo">
      <span className="relay-logo-mark" aria-hidden="true">
        <span />
      </span>
      <span>RelayForge</span>
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button
      className={`button button-${variant} ${className}`}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusBadge({
  status,
  transport,
}: {
  status: DeliveryStatus;
  transport?: ConnectionTransport;
}) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-mark" />
      {status === "delivered" && transport && transport !== "demo"
        ? "Acknowledged"
        : statusNames[status]}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  children,
  search = false,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  search?: boolean;
}) {
  return (
    <div className="empty-state">
      <span>{search ? <Search size={22} /> : <Inbox size={22} />}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}

export function Dialog({
  children,
  title,
  onClose,
  drawer = false,
  returnFocus,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  drawer?: boolean;
  returnFocus?: { current: HTMLElement | null };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocus);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous =
      returnFocusRef.current?.current ??
      (document.activeElement as HTMLElement | null);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current
      ?.querySelector<HTMLElement>(
        "button:not(:disabled), input, select, textarea, [tabindex='0']",
      )
      ?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const items = ref.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']",
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
      // Background inert state is released by the owning screen after unmount.
      window.requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.closest("[inert]"))
          previous.focus();
      });
    };
  }, []);
  return (
    <motion.div
      className={`dialog-overlay ${drawer ? "is-drawer" : ""}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        ref={ref}
        className={drawer ? "delivery-drawer" : "event-modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        initial={drawer ? { x: 40 } : { y: 14, scale: 0.98 }}
        animate={{ x: 0, y: 0, scale: 1 }}
        exit={drawer ? { x: 40 } : { y: 14, scale: 0.98 }}
        transition={{ duration: 0.2 }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function CloseButton({
  onClick,
  label = "Close dialog",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      onClick={onClick}
    >
      <X size={20} />
    </button>
  );
}

export function JsonBlock({
  value,
  copy,
  label = "JSON payload",
}: {
  value: string;
  copy: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{label}</span>
        <button className="copy-button" onClick={() => copy(value)}>
          <Copy size={14} />
          Copy
        </button>
      </div>
      <pre tabIndex={0}>{value}</pre>
    </div>
  );
}

export function DeliveryChart({
  data,
}: {
  data: { label: string; delivered: number; failed: number }[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(
    3,
    ...data.map((item) => Math.max(item.delivered, item.failed)),
  );
  const roundedMax = Math.ceil(max / 3) * 3;
  const x = (index: number) =>
    42 + (index * 720) / Math.max(1, data.length - 1);
  const y = (value: number) => 182 - (value / roundedMax) * 148;
  const points = (field: "delivered" | "failed") =>
    data.map((item, index) => `${x(index)},${y(item[field])}`).join(" ");
  const hasData = data.some((item) => item.delivered || item.failed);
  return (
    <div className="chart">
      <svg
        viewBox="0 0 792 228"
        role="img"
        aria-label="Acknowledged and failed delivery attempts in the last 10 minutes. All chart times are UTC."
      >
        <defs>
          <linearGradient id="delivery-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b9f94a" stopOpacity=".19" />
            <stop offset="100%" stopColor="#b9f94a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((index) => (
          <g key={index}>
            <line
              x1="42"
              x2="762"
              y1={34 + (index * 148) / 3}
              y2={34 + (index * 148) / 3}
              className="grid-line"
            />
            <text x="7" y={38 + (index * 148) / 3}>
              {(roundedMax * (3 - index)) / 3}
            </text>
          </g>
        ))}
        <polygon
          points={`42,182 ${points("delivered")} 762,182`}
          fill="url(#delivery-area)"
        />
        <polyline points={points("delivered")} className="chart-line-success" />
        <polyline points={points("failed")} className="chart-line-failed" />
        {data.map((item, index) => (
          <g
            key={item.label}
            tabIndex={0}
            aria-label={`${item.label} UTC: ${item.delivered} acknowledged and ${item.failed} failed ${item.failed === 1 ? "attempt" : "attempts"}`}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
          >
            {(index === 0 || index === data.length - 1 || index % 2 === 0) && (
              <text
                x={x(index)}
                y="214"
                textAnchor={
                  index === 0
                    ? "start"
                    : index === data.length - 1
                      ? "end"
                      : "middle"
                }
              >
                {item.label}
              </text>
            )}
            <rect
              x={x(index) - 25}
              y="23"
              width="50"
              height="172"
              fill="transparent"
            />
            {active === index && (
              <>
                <line
                  x1={x(index)}
                  x2={x(index)}
                  y1="25"
                  y2="184"
                  className="chart-active-line"
                />
                <circle
                  cx={x(index)}
                  cy={y(item.delivered)}
                  r="4"
                  fill="#b9f94a"
                />
              </>
            )}
          </g>
        ))}
      </svg>
      {!hasData && (
        <div className="chart-empty">
          <Clock3 size={21} />
          <strong>No attempts in this window</strong>
          <span>Send an event to start the last 10-minute chart.</span>
        </div>
      )}
      {active !== null && data[active] && (
        <div className="chart-tooltip">
          <span>{data[active].label} UTC</span>
          <b>{data[active].delivered} acknowledged</b>
          <span>{data[active].failed} failed</span>
        </div>
      )}
    </div>
  );
}

export function DeliveryTable({
  rows,
  onSelect,
  now,
  maxAttempts,
  expanded = false,
  loading = false,
  emptyAction,
  hrefForEvent,
}: {
  hrefForEvent?: (id: string) => string;
  rows: Delivery[];
  onSelect: (id: string) => void;
  now: number;
  maxAttempts: number;
  expanded?: boolean;
  loading?: boolean;
  emptyAction?: ReactNode;
}) {
  return (
    <>
      {loading && (
        <div className="table-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          Refreshing deliveries…
        </div>
      )}
      {!rows.length ? (
        <EmptyState
          title={
            emptyAction
              ? "Your event history starts here"
              : "No matching deliveries"
          }
          description={
            emptyAction
              ? "Send an event to see acceptance, retries, and delivery in action."
              : "Try a different event type, endpoint, or status filter."
          }
          search={!emptyAction}
        >
          {emptyAction}
        </EmptyState>
      ) : (
        <>
          <div className="desktop-deliveries">
            <table
              className={`delivery-table ${expanded ? "expanded-table" : ""}`}
            >
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Destination</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  {expanded && (
                    <>
                      <th>HTTP</th>
                      <th>Duration</th>
                    </>
                  )}
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Inspect</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((delivery) => (
                  <tr key={delivery.id} onClick={() => onSelect(delivery.id)}>
                    <td>
                      {hrefForEvent ? (
                        <a
                          className="event-cell"
                          href={hrefForEvent(delivery.id)}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (
                              event.button !== 0 ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            onSelect(delivery.id);
                          }}
                        >
                          <strong>{delivery.eventType}</strong>
                          <code>{delivery.id.slice(0, 18)}</code>
                        </a>
                      ) : (
                        <button
                          className="event-cell"
                          onClick={() => onSelect(delivery.id)}
                        >
                          <strong>{delivery.eventType}</strong>
                          <code>{delivery.id.slice(0, 18)}</code>
                        </button>
                      )}
                    </td>
                    <td>
                      <span className="target-cell">
                        <i>{delivery.endpointName.charAt(0)}</i>
                        <span>{delivery.endpointName}</span>
                      </span>
                    </td>
                    <td>
                      <StatusBadge
                        status={delivery.status}
                        transport={delivery.transport}
                      />
                    </td>
                    <td>
                      <span className="attempt-cell">
                        {delivery.attempts}
                        <small> / {maxAttempts}</small>
                      </span>
                    </td>
                    {expanded && (
                      <>
                        <td>
                          <span
                            className={
                              delivery.latestAttempt?.statusCode &&
                              delivery.latestAttempt.statusCode >= 400
                                ? "danger-text mono"
                                : "mono"
                            }
                          >
                            {delivery.latestAttempt?.statusCode ||
                              (delivery.latestAttempt?.failureCode
                                ? "Network"
                                : "—")}
                          </span>
                        </td>
                        <td className="muted mono">
                          {delivery.latestAttempt?.finishedAt == null
                            ? "—"
                            : formatDuration(delivery.latestAttempt.durationMs)}
                        </td>
                      </>
                    )}
                    <td>
                      <time
                        className="created-cell"
                        title={fullDate(delivery.createdAt)}
                      >
                        {relativeTime(delivery.createdAt, now)}
                      </time>
                    </td>
                    <td>
                      <ChevronRight size={16} className="row-arrow" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="delivery-cards">
            {rows.map((delivery) => (
              <a
                className="delivery-card"
                key={delivery.id}
                href={
                  hrefForEvent?.(delivery.id) ??
                  `/?view=deliveries&event=${encodeURIComponent(delivery.id)}`
                }
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
                  onSelect(delivery.id);
                }}
              >
                <span className="card-top">
                  <span className="event-cell">
                    <strong>{delivery.eventType}</strong>
                    <code>{delivery.id.slice(0, 21)}</code>
                  </span>
                  <StatusBadge
                    status={delivery.status}
                    transport={delivery.transport}
                  />
                </span>
                <span className="card-bottom">
                  <span>{delivery.endpointName}</span>
                  <span>
                    {delivery.attempts}{" "}
                    {delivery.attempts === 1 ? "attempt" : "attempts"}
                  </span>
                  <time>{relativeTime(delivery.createdAt, now)}</time>
                </span>
                {expanded && (
                  <span className="card-response">
                    <span>
                      Last HTTP{" "}
                      <b
                        className={
                          delivery.latestAttempt?.statusCode &&
                          delivery.latestAttempt.statusCode >= 400
                            ? "danger-text"
                            : ""
                        }
                      >
                        {delivery.latestAttempt?.statusCode || "—"}
                      </b>
                    </span>
                    <span>
                      Duration{" "}
                      <b>
                        {delivery.latestAttempt?.finishedAt == null
                          ? "—"
                          : formatDuration(delivery.latestAttempt.durationMs)}
                      </b>
                    </span>
                    <ChevronRight size={15} />
                  </span>
                )}
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  loading,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
  loading: boolean;
}) {
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  return (
    <div className="pagination">
      <span aria-live="polite">
        {loading ? (
          "Loading delivery records…"
        ) : (
          <>
            Showing{" "}
            <b>
              {start}–{end}
            </b>{" "}
            of <b>{formatNumber(total)}</b> deliveries
          </>
        )}
      </span>
      <div>
        <Button
          variant="secondary"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1 || loading}
        >
          <ChevronLeft size={16} />
          <span>Previous</span>
        </Button>
        <span className="page-counter">
          {loading ? "…" : `${page} / ${Math.max(1, totalPages)}`}
        </span>
        <Button
          variant="secondary"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages || loading}
        >
          <span>Next</span>
          <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
}

export function PanelHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function ViewAll({ onClick }: { onClick: () => void }) {
  return (
    <button className="text-button" onClick={onClick}>
      View all
      <ArrowRight size={14} />
    </button>
  );
}
