"use client";

import {
  Activity,
  ArrowRight,
  ChartNoAxesCombined,
  Command,
  CornerDownLeft,
  FileClock,
  LayoutDashboard,
  LoaderCircle,
  Search,
  ShieldCheck,
  SquareTerminal,
  Unplug,
  Webhook,
  Wrench,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { DeliveryPage, Endpoint } from "@/lib/contracts";
import type { NavigationState } from "@/lib/navigation";
import { RequestError } from "@/lib/client-api";
import {
  commandDestination,
  deliveryCommands,
  localCommands,
  normalizeCommandQuery,
  type CommandEntry,
} from "@/lib/commands";
import { CloseButton, Dialog, StatusBadge } from "./relay-ui";
import "./command-palette.css";

const viewIcons = {
  overview: LayoutDashboard,
  deliveries: Webhook,
  insights: ChartNoAxesCombined,
  operations: Activity,
  recovery: Wrench,
  endpoints: Unplug,
  studio: SquareTerminal,
  activity: FileClock,
  engineering: SquareTerminal,
  security: ShieldCheck,
};

interface SearchResult {
  query: string;
  state: "loading" | "ready" | "error";
  entries: CommandEntry[];
  total: number;
  error?: string;
  requestId?: string | null;
}

export function CommandPalette({
  endpoints,
  load,
  navigate,
  onClose,
}: {
  endpoints: Endpoint[];
  load: (search: string, signal: AbortSignal) => Promise<DeliveryPage>;
  navigate: (state: NavigationState) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [remote, setRemote] = useState<SearchResult | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const query = normalizeCommandQuery(search);
  const local = useMemo(
    () => localCommands(query, endpoints),
    [query, endpoints],
  );
  const currentRemote =
    remote?.query === query && query.length >= 2 ? remote : null;
  const eventEntries =
    currentRemote?.state === "ready" ? currentRemote.entries : [];
  const entries = [...local, ...eventEntries];
  const selectedIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));
  const selected = entries[selectedIndex];
  const searching =
    query.length >= 2 && (!currentRemote || currentRemote.state === "loading");

  useEffect(() => {
    if (query.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setRemote({ query, state: "loading", entries: [], total: 0 });
      load(query, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setRemote({
            query,
            state: "ready",
            entries: deliveryCommands(result.deliveries),
            total: result.total,
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setRemote({
            query,
            state: "error",
            entries: [],
            total: 0,
            error:
              error instanceof RequestError
                ? error.message
                : "Delivery search is unavailable. Try again.",
            requestId: error instanceof RequestError ? error.requestId : null,
          });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, load]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      "[aria-selected='true']",
    );
    if (!active || !listRef.current) return;
    const list = listRef.current;
    const top = active.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + active.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = top + active.offsetHeight - list.clientHeight;
  }, [selected?.id]);

  const select = (entry: CommandEntry) => navigate(commandDestination(entry));
  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !entries.length
    )
      return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (selectedIndex +
          (event.key === "ArrowDown" ? 1 : -1) +
          entries.length) %
          entries.length,
      );
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : entries.length - 1);
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      select(selected);
    }
  };

  let announcement = `${entries.length} navigation ${entries.length === 1 ? "option" : "options"}.`;
  if (searching) announcement = "Searching delivery history…";
  else if (currentRemote?.state === "error")
    announcement = currentRemote.error ?? "Delivery search is unavailable.";
  else if (!entries.length)
    announcement =
      "No matches. Try an event ID, event type, receiver, or page name.";
  else if (
    currentRemote?.state === "ready" &&
    currentRemote.total > eventEntries.length
  )
    announcement = `${entries.length} navigation options. Showing ${eventEntries.length} of ${currentRemote.total} matching events.`;

  return createPortal(
    <Dialog title="Quick navigation" onClose={onClose}>
      <section className="command-palette">
        <div className="command-palette-search">
          <Search size={20} aria-hidden="true" />
          <label className="sr-only" htmlFor={`${id}-input`}>
            Search pages, receivers, and event history
          </label>
          <input
            id={`${id}-input`}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={
              selected ? `${id}-${selected.id}` : undefined
            }
            aria-describedby={`${id}-status`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value.slice(0, 100));
              setActiveIndex(0);
            }}
            onKeyDown={handleKey}
            placeholder="Jump to a page, receiver, or event…"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
          <CloseButton onClick={onClose} label="Close quick navigation" />
        </div>
        <div className="command-palette-context">
          <span>
            <Command size={13} aria-hidden="true" /> Quick navigation
          </span>
          <span>
            {query ? "This workspace" : "Where would you like to go?"}
          </span>
        </div>
        <div
          className="command-palette-list"
          id={`${id}-list`}
          role="listbox"
          aria-label="Navigation results"
          ref={listRef}
        >
          {entries.map((entry, index) => {
            const previous = entries[index - 1];
            const groupLabel =
              entry.kind === "view"
                ? "Pages"
                : entry.kind === "endpoint"
                  ? "Receivers"
                  : "Events";
            const Icon =
              entry.kind === "endpoint"
                ? Unplug
                : entry.kind === "event"
                  ? Webhook
                  : viewIcons[entry.destination.view];
            return (
              <div role="presentation" key={entry.id}>
                {previous?.kind !== entry.kind && (
                  <p className="command-palette-group" aria-hidden="true">
                    {groupLabel}
                  </p>
                )}
                <div
                  id={`${id}-${entry.id}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  className="command-palette-option"
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(entry)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select(entry);
                    }
                  }}
                >
                  <span
                    className={`command-palette-icon command-palette-icon-${entry.kind}`}
                  >
                    <Icon size={17} aria-hidden="true" />
                  </span>
                  <span className="command-palette-label">
                    <strong>{entry.label}</strong>
                    <span>{entry.detail}</span>
                  </span>
                  {entry.status ? (
                    <StatusBadge
                      status={entry.status}
                      transport={entry.transport}
                    />
                  ) : (
                    <ArrowRight
                      className="command-palette-arrow"
                      size={15}
                      aria-hidden="true"
                    />
                  )}
                  {index === selectedIndex && (
                    <CornerDownLeft
                      size={13}
                      className="command-palette-enter"
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>
            );
          })}
          {!entries.length &&
            !searching &&
            currentRemote?.state !== "error" && (
              <div className="command-palette-empty">
                <Search size={22} aria-hidden="true" />
                <strong>No matches found</strong>
                <span>Search by event ID, event type, receiver, or page.</span>
              </div>
            )}
        </div>
        <div
          className={`command-palette-status ${currentRemote?.state === "error" ? "command-palette-error" : ""}`}
          id={`${id}-status`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {searching && (
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
          )}
          <span>{announcement}</span>
          {currentRemote?.state === "error" && currentRemote.requestId && (
            <code className="command-palette-request">
              Request {currentRemote.requestId}
            </code>
          )}
        </div>
        <footer className="command-palette-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </section>
    </Dialog>,
    document.body,
  );
}
