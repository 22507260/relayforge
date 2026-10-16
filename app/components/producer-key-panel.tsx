"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  ProducerKey,
  ProducerKeyCreationResponse,
  ProducerKeysResponse,
  Snapshot,
} from "@/lib/contracts";
import { api } from "@/lib/client-api";
import {
  Button,
  CloseButton,
  Dialog,
  EmptyState,
  fullDate,
  relativeTime,
} from "./relay-ui";
import { RequestFeedback } from "./request-feedback";
import "./integrations.css";

export function ProducerKeyPanel({
  snapshot,
  connectionError,
  onDialogChange,
  connections,
}: {
  snapshot: Snapshot;
  connectionError: (error: unknown) => void;
  onDialogChange: (open: boolean) => void;
  connections: () => void;
}) {
  const [keys, setKeys] = useState<ProducerKey[] | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<"create" | "revoke" | null>(null);
  const [target, setTarget] = useState<ProducerKey | null>(null);
  const [name, setName] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [days, setDays] = useState(90);
  const [token, setToken] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  const destinations = snapshot.endpoints.filter(
    (endpoint) => endpoint.transport !== "demo" && endpoint.enabled,
  );
  useEffect(() => {
    const controller = new AbortController();
    api<ProducerKeysResponse>(
      "/api/producer-keys",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setKeys(result.keys);
          setError(null);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err);
          connectionError(err);
        }
      });
    return () => controller.abort();
  }, [retry, snapshot.system.now, connectionError]);
  useEffect(() => {
    onDialogChange(Boolean(dialog));
    return () => onDialogChange(false);
  }, [dialog, onDialogChange]);
  const close = () => {
    if (pendingRef.current) return;
    onDialogChange(false);
    setDialog(null);
    setToken(null);
    setSaved(false);
    setDialogError(null);
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (token) {
      if (saved) close();
      return;
    }
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setDialogError(null);
    try {
      const response = await api<ProducerKeyCreationResponse>(
        "/api/producer-keys",
        { name: name.trim(), endpointId, expiresInDays: days },
      );
      setToken(response.token);
      setSaved(false);
      setRetry((value) => value + 1);
    } catch (err) {
      setDialogError(err);
      connectionError(err);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const revoke = async () => {
    if (!target || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setDialogError(null);
    try {
      await api(
        `/api/producer-keys/${encodeURIComponent(target.id)}`,
        undefined,
        undefined,
        "DELETE",
      );
      setRetry((value) => value + 1);
      onDialogChange(false);
      setDialog(null);
      setTarget(null);
    } catch (err) {
      setDialogError(err);
      connectionError(err);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const active = (keys ?? []).filter(
    (key) => key.revokedAt === null && key.expiresAt > snapshot.system.now,
  ).length;
  return (
    <section className="rf-key-panel">
      <div className="rf-section-label">
        <div>
          <h2>Producer API keys</h2>
          <p>
            One connection per key. Send events from your application with
            events:write access.
          </p>
        </div>
        <Button
          disabled={!destinations.length || active >= 10 || pending}
          onClick={(event) => {
            openerRef.current = event.currentTarget;
            setDialog("create");
            setName("");
            setEndpointId(destinations[0]?.id ?? "");
            setDays(90);
            setToken(null);
            setDialogError(null);
            setSaved(false);
          }}
        >
          <Plus size={14} />
          Create key
        </Button>
      </div>
      <RequestFeedback error={error} focus={false} />
      <div className="rf-key-list">
        {!keys && !error ? (
          <div className="rf-inline-loader">
            <LoaderCircle size={18} className="spin" />
            Loading producer keys…
          </div>
        ) : !keys?.length ? (
          <EmptyState
            title="Keep your producer credentials separate"
            description="Create a scoped key for an enabled live connection. It is revealed once, expires automatically, and can be revoked at any time."
          >
            {!destinations.length && (
              <Button variant="secondary" onClick={connections}>
                Create a live connection
              </Button>
            )}
          </EmptyState>
        ) : (
          keys.map((key) => {
            const revoked = key.revokedAt !== null;
            const expired = key.expiresAt <= snapshot.system.now;
            const endpoint = snapshot.endpoints.find(
              (item) => item.id === key.endpointId,
            );
            return (
              <article
                key={key.id}
                className={`rf-key-row ${revoked || expired ? "revoked" : ""}`}
              >
                <div>
                  <strong>{key.name}</strong>
                  <code>{key.prefix}••••••••</code>
                </div>
                <div>
                  <strong>{endpoint?.name ?? "Connection unavailable"}</strong>
                  <small>events:write · One connection</small>
                </div>
                <div>
                  <strong>
                    {revoked ? "Revoked" : expired ? "Expired" : "Active"}
                  </strong>
                  <small title={fullDate(key.expiresAt)}>
                    Expires{" "}
                    {new Date(key.expiresAt).toLocaleDateString("en-GB", {
                      dateStyle: "medium",
                    })}
                  </small>
                  <small>
                    {key.lastUsedAt === null
                      ? "Never used"
                      : `Used ${relativeTime(key.lastUsedAt, snapshot.system.now).toLowerCase()}`}
                  </small>
                </div>
                <Button
                  variant="ghost"
                  disabled={revoked || pending}
                  onClick={(event) => {
                    openerRef.current = event.currentTarget;
                    setTarget(key);
                    setDialog("revoke");
                    setDialogError(null);
                  }}
                >
                  <Trash2 size={13} />
                  Revoke
                </Button>
              </article>
            );
          })
        )}
      </div>
      <div className="rf-config-note">
        <ShieldCheck size={18} />
        <div>
          <strong>{active} of 10 active keys</strong>Keys expire within 90 days.
          Each key allows 60 requests per minute, with 240 requests per minute
          across your workspace. The raw token is never stored in the database.
        </div>
      </div>
      {dialog &&
        createPortal(
          <Dialog
            returnFocus={openerRef}
            title={
              dialog === "revoke"
                ? "Revoke producer key"
                : token
                  ? "Save producer API key"
                  : "Create producer API key"
            }
            onClose={close}
          >
            <form
              onSubmit={
                dialog === "create"
                  ? create
                  : (event) => {
                      event.preventDefault();
                      void revoke();
                    }
              }
            >
              <div className="modal-head">
                <div>
                  <span className="modal-icon">
                    <KeyRound size={21} />
                  </span>
                  <div>
                    <h2>
                      {dialog === "revoke"
                        ? "Revoke this API key?"
                        : token
                          ? "Save your producer key"
                          : "Create a producer key"}
                    </h2>
                    <p>
                      {dialog === "revoke"
                        ? target?.name
                        : "A credential scoped to one live connection."}
                    </p>
                  </div>
                </div>
                <CloseButton
                  onClick={close}
                  label="Close producer key dialog"
                />
              </div>
              <div className="modal-body">
                {dialog === "revoke" ? (
                  <div className="rf-config-note">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>
                        New requests will be rejected immediately.
                      </strong>
                      Accepted events remain in the queue. Update your producer
                      application with a new key to continue sending.
                    </div>
                  </div>
                ) : token ? (
                  <>
                    <div className="rf-secret">
                      <h3>
                        <KeyRound size={16} />
                        This token is shown once.
                      </h3>
                      <p>
                        Store it in your application’s secret configuration.
                        Closing this dialog removes it from this page.
                      </p>
                      <code>{token}</code>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(token)
                            .catch(() =>
                              setDialogError(
                                new Error(
                                  "Select the token to copy it manually.",
                                ),
                              ),
                            )
                        }
                      >
                        <Copy size={13} />
                        Copy API key
                      </Button>
                    </div>
                    <label className="rf-key-check">
                      <input
                        type="checkbox"
                        checked={saved}
                        onChange={(event) => setSaved(event.target.checked)}
                      />
                      I saved this key in a secure place.
                    </label>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span className="field-label">Key name</span>
                      <input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        required
                        maxLength={80}
                        autoComplete="off"
                        placeholder="e.g. Billing producer"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">Connection scope</span>
                      <span className="select-wrap">
                        <select
                          value={endpointId}
                          onChange={(event) =>
                            setEndpointId(event.target.value)
                          }
                          required
                        >
                          {destinations.map((endpoint) => (
                            <option key={endpoint.id} value={endpoint.id}>
                              {endpoint.name}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </span>
                      <span className="field-hint">
                        This key can only enqueue events for this connection.
                      </span>
                    </label>
                    <label className="field">
                      <span className="field-label">Expires in</span>
                      <span className="select-wrap">
                        <select
                          value={days}
                          onChange={(event) =>
                            setDays(Number(event.target.value))
                          }
                        >
                          <option value={7}>7 days</option>
                          <option value={30}>30 days</option>
                          <option value={90}>90 days</option>
                        </select>
                        <ChevronDown size={15} />
                      </span>
                    </label>
                  </>
                )}
                <RequestFeedback error={dialogError} />
              </div>
              <div className="modal-foot">
                <Button variant="ghost" onClick={close} disabled={pending}>
                  {token ? "Close" : "Cancel"}
                </Button>
                <Button
                  type="submit"
                  variant={dialog === "revoke" ? "danger" : "primary"}
                  disabled={pending || Boolean(token && !saved)}
                >
                  {pending ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : token ? (
                    <Check size={15} />
                  ) : dialog === "revoke" ? (
                    <Trash2 size={15} />
                  ) : (
                    <KeyRound size={15} />
                  )}
                  {pending
                    ? "Saving…"
                    : token
                      ? "Done"
                      : dialog === "revoke"
                        ? "Revoke key"
                        : "Create key"}
                </Button>
              </div>
            </form>
          </Dialog>,
          document.body,
        )}
    </section>
  );
}
