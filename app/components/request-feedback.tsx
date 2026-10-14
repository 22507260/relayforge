"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { RequestError } from "@/lib/client-api";
import "./request-feedback.css";

export function useRetryCountdown(error: unknown): number {
  const retryAt = error instanceof RequestError ? error.retryAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    let timer: number | undefined;
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt && timer !== undefined)
        window.clearInterval(timer);
    };
    const initial = window.setTimeout(refresh, 0);
    if (retryAt > Date.now()) timer = window.setInterval(refresh, 1000);
    return () => {
      window.clearTimeout(initial);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [retryAt]);
  return retryAt === null ? 0 : Math.max(0, Math.ceil((retryAt - now) / 1000));
}

export function RequestFeedback({
  error,
  fallback = "The request could not be completed. Please try again.",
  focus = true,
}: {
  error: unknown;
  fallback?: string;
  focus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const remaining = useRetryCountdown(error);
  const requestId = error instanceof RequestError ? error.requestId : null;
  const copied = requestId !== null && copiedId === requestId;
  const copyFailed = requestId !== null && failedId === requestId;
  useEffect(() => {
    if (error && focus) ref.current?.focus();
  }, [error, focus]);
  if (!error) return null;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;
  return (
    <div className="request-feedback" ref={ref} tabIndex={-1} role="alert">
      <p>{message}</p>
      {remaining > 0 && (
        <span className="request-feedback-retry" aria-live="off">
          Try again in{" "}
          {Math.floor(remaining / 60) > 0
            ? `${Math.floor(remaining / 60)} min `
            : ""}
          {remaining % 60} sec.
        </span>
      )}
      {requestId && (
        <details className="request-feedback-details">
          <summary>Request details</summary>
          <div>
            <code>{requestId}</code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(requestId);
                  setCopiedId(requestId);
                  setFailedId(null);
                } catch {
                  setFailedId(requestId);
                }
              }}
              aria-label="Copy request ID"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy ID"}
            </button>
          </div>
          {copyFailed && <small>Select the request ID to copy it.</small>}
        </details>
      )}
    </div>
  );
}
