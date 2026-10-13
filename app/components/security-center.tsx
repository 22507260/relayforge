"use client";

import { AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type {
  SecurityAction,
  SecurityMutationResponse,
  SecuritySnapshot,
  SessionSummary,
} from "@/lib/contracts";
import {
  Button,
  CloseButton,
  Dialog,
  EmptyState,
  fullDate,
  relativeTime,
} from "./relay-ui";

export function SecurityCenter({
  busy,
  version,
  load,
  mutate,
  connectionError,
  onDialogChange,
  openActivity,
  activityHref,
}: {
  busy: boolean;
  version: number;
  load: (signal: AbortSignal) => Promise<SecuritySnapshot>;
  mutate: (action: SecurityAction) => Promise<SecurityMutationResponse>;
  connectionError: (error: unknown) => void;
  onDialogChange: (open: boolean) => void;
  openActivity: () => void;
  activityHref: string;
}) {
  const [data, setData] = useState<SecuritySnapshot | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirmation, setConfirmation] = useState<
    SessionSummary | "others" | null
  >(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [success, setSuccess] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const dialogErrorRef = useRef<HTMLParagraphElement>(null);
  const [dialogError, setDialogError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((security) => {
        if (!controller.signal.aborted) {
          setData(security);
          setError("");
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load account security.",
        );
        connectionError(err);
      });
    return () => controller.abort();
  }, [load, version, retry, connectionError]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (passwordError) formErrorRef.current?.focus();
  }, [passwordError]);
  useEffect(() => {
    if (dialogError) dialogErrorRef.current?.focus();
  }, [dialogError]);
  useEffect(() => {
    onDialogChange(Boolean(confirmation));
    return () => onDialogChange(false);
  }, [confirmation, onDialogChange]);
  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setSuccess("");
    setPasswordError("");
    if (newPassword.length < 12 || newPassword.length > 128) {
      setPasswordError("Use a new password between 12 and 128 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("The new passwords do not match.");
      return;
    }
    try {
      const result = await mutate({
        type: "change-password",
        currentPassword,
        newPassword,
      });
      if (!mounted.current) return;
      setData(result.security);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      setSuccess(
        `Password changed. Your current session was renewed and ${result.revokedSessions} previous ${result.revokedSessions === 1 ? "session was" : "sessions were"} closed.`,
      );
    } catch (err) {
      if (mounted.current)
        setPasswordError(
          err instanceof Error
            ? err.message
            : "Unable to change your password.",
        );
    }
  };
  const revoke = async () => {
    if (!confirmation || busy) return;
    setDialogError("");
    try {
      const result = await mutate(
        confirmation === "others"
          ? { type: "revoke-other-sessions" }
          : { type: "revoke-session", sessionId: confirmation.id },
      );
      if (!mounted.current) return;
      setData(result.security);
      setConfirmation(null);
      setSuccess(
        `${result.revokedSessions} ${result.revokedSessions === 1 ? "session" : "sessions"} closed. Your current session is still active.`,
      );
    } catch (err) {
      if (mounted.current)
        setDialogError(
          err instanceof Error
            ? err.message
            : "Unable to close the selected sessions.",
        );
    }
  };
  const others = Math.max(0, (data?.sessionCount ?? 1) - 1);
  return (
    <>
      <div className="page-header">
        <div>
          <span className="page-eyebrow">ACCOUNT PROTECTION</span>
          <h1>Security center</h1>
          <p>
            Manage access to your workspace and review recorded security events.
          </p>
        </div>
        <span className="security-header-mark">
          <ShieldCheck size={26} />
        </span>
      </div>
      {error && (
        <p ref={errorRef} tabIndex={-1} className="notice error" role="alert">
          {error}
          <Button
            variant="secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </Button>
        </p>
      )}
      {success && (
        <div className="security-success" role="status">
          <ShieldCheck size={17} />
          <span>{success}</span>
          <button
            className="icon-button"
            aria-label="Dismiss security notice"
            onClick={() => setSuccess("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {!data ? (
        <div className="panel list-loading">
          <LoaderCircle className="spin" size={23} />
          Loading account security…
        </div>
      ) : (
        <>
          <div className="security-summary">
            <div>
              <span className="security-summary-icon">
                <ShieldCheck size={21} />
              </span>
              <div>
                <small>ACCOUNT</small>
                <strong>{data.user.email}</strong>
                <span>Created {fullDate(data.user.createdAt)}</span>
              </div>
            </div>
            <div>
              <small>ACTIVE SESSIONS</small>
              <strong className="security-session-count">
                {data.sessionCount}
              </strong>
              <span>Including this browser</span>
            </div>
            <div>
              <small>SESSION LIFETIME</small>
              <strong>7 days</strong>
              <span>Other sessions close when your password changes</span>
            </div>
          </div>
          <div className="security-grid">
            <section className="panel security-sessions">
              <div className="security-panel-heading">
                <div>
                  <span className="page-eyebrow">WORKSPACE ACCESS</span>
                  <h2>Active sessions</h2>
                  <p>
                    Last request shows authenticated activity, including
                    automatic refreshes.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy || !others}
                  onClick={() => {
                    setDialogError("");
                    setConfirmation("others");
                  }}
                >
                  <LogOut size={15} />
                  Close other sessions
                </Button>
              </div>
              {data.sessionCount > data.sessions.length && (
                <p className="security-cap-note">
                  Showing the current session and {data.sessions.length - 1}{" "}
                  other sessions of {data.sessionCount} total. Close other
                  sessions applies to all {others}.
                </p>
              )}
              <div className="security-session-list">
                {data.sessions.map((session) => (
                  <div className="security-session" key={session.id}>
                    <span
                      className={`security-session-icon ${session.isCurrent ? "current" : ""}`}
                    >
                      <KeyRound size={18} />
                    </span>
                    <div className="security-session-info">
                      <div>
                        <strong>
                          {session.isCurrent
                            ? "This browser session"
                            : "Browser session"}
                        </strong>
                        {session.isCurrent && (
                          <span className="security-current">CURRENT</span>
                        )}
                      </div>
                      <code title={session.id}>
                        Session {session.id.slice(0, 12)}
                      </code>
                      <p>
                        <span>Created {fullDate(session.createdAt)}</span>
                        <span>Expires {fullDate(session.expiresAt)}</span>
                      </p>
                      <small>
                        <Clock3 size={12} />
                        Last request:{" "}
                        {session.lastSeenAt === null
                          ? "Not recorded"
                          : relativeTime(session.lastSeenAt, data.now)}
                      </small>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={busy || session.isCurrent}
                      title={
                        session.isCurrent
                          ? "Use Sign out in the navigation to close your current session."
                          : "Close this session"
                      }
                      onClick={() => {
                        setDialogError("");
                        setConfirmation(session);
                      }}
                    >
                      {session.isCurrent ? "Current" : "Close"}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
            <section className="panel security-password">
              <div className="security-panel-heading">
                <div>
                  <span className="page-eyebrow">CREDENTIALS</span>
                  <h2>Change password</h2>
                  <p>
                    Confirm your current password. Other sessions will be
                    closed.
                  </p>
                </div>
                <KeyRound size={20} />
              </div>
              <form onSubmit={changePassword}>
                <label htmlFor="current-password">Current password</label>
                <div className="security-password-input">
                  <input
                    id="current-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    required
                    maxLength={128}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={
                      showPassword ? "Hide passwords" : "Show passwords"
                    }
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={128}
                  disabled={busy}
                  aria-describedby="password-guidance"
                />
                <p id="password-guidance" className="security-form-guidance">
                  Use 12–128 characters. A long, unique passphrase works well.
                </p>
                <label htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  minLength={12}
                  maxLength={128}
                  disabled={busy}
                />
                {passwordError && (
                  <p
                    ref={formErrorRef}
                    tabIndex={-1}
                    className="inline-error"
                    role="alert"
                  >
                    {passwordError}
                  </p>
                )}
                <Button type="submit" disabled={busy}>
                  {busy ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <ShieldCheck size={16} />
                  )}
                  Update password
                </Button>
              </form>
            </section>
          </div>
          <section className="panel security-events">
            <div className="security-panel-heading">
              <div>
                <span className="page-eyebrow">RECORDED HISTORY</span>
                <h2>Recent security events</h2>
                <p>
                  Latest {data.events.length} records. Explore the full history
                  in Activity.
                </p>
              </div>
              <a
                className="text-button"
                href={activityHref}
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
                  openActivity();
                }}
              >
                Open audit explorer <ArrowRight size={15} />
              </a>
            </div>
            {!data.events.length ? (
              <EmptyState
                title="No security events recorded"
                description="Account and session actions will appear here."
              />
            ) : (
              data.events.map((event) => (
                <div className="security-event" key={event.id}>
                  <span>
                    <ShieldCheck size={16} />
                  </span>
                  <div>
                    <strong>{event.kind.replaceAll("-", " ")}</strong>
                    <p>{event.message}</p>
                  </div>
                  <time title={fullDate(event.createdAt)}>
                    {relativeTime(event.createdAt, data.now)}
                  </time>
                </div>
              ))
            )}
          </section>
        </>
      )}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {confirmation && (
              <Dialog
                title="Close sessions"
                onClose={() => {
                  if (!busy) setConfirmation(null);
                }}
              >
                <div className="modal-head">
                  <div>
                    <span className="page-eyebrow">CONFIRM ACCESS CHANGE</span>
                    <h2>
                      {confirmation === "others"
                        ? "Close other sessions?"
                        : "Close this session?"}
                    </h2>
                  </div>
                  <CloseButton
                    onClick={() => {
                      if (!busy) setConfirmation(null);
                    }}
                    label="Cancel session revocation"
                  />
                </div>
                <div className="modal-body">
                  <p className="security-confirm-copy">
                    {confirmation === "others"
                      ? `All ${others} other active sessions will be signed out. This browser stays connected.`
                      : `The selected browser session, created ${fullDate(confirmation.createdAt)}, will lose access immediately. This browser stays connected.`}
                  </p>
                  {dialogError && (
                    <p
                      ref={dialogErrorRef}
                      tabIndex={-1}
                      className="inline-error"
                      role="alert"
                    >
                      {dialogError}
                    </p>
                  )}
                </div>
                <div className="modal-foot">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmation(null)}
                  >
                    Cancel
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={revoke}>
                    {busy ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <LogOut size={16} />
                    )}
                    Close{" "}
                    {confirmation === "others" ? "other sessions" : "session"}
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
