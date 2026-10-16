"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Copy,
  FlaskConical,
  Globe2,
  KeyRound,
  LoaderCircle,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Terminal,
  Webhook,
  Wrench,
} from "lucide-react";
import type {
  Connection,
  ConnectionsResponse,
  ConnectionMutationResponse,
  Endpoint,
  ReceiverMode,
  Snapshot,
} from "@/lib/contracts";
import { api } from "@/lib/client-api";
import {
  Button,
  CloseButton,
  Dialog,
  EmptyState,
  formatDuration,
  formatNumber,
  fullDate,
} from "./relay-ui";
import { RequestFeedback } from "./request-feedback";
import "./integrations.css";

export function TransportBadge({
  endpoint,
}: {
  endpoint: Pick<Endpoint, "transport">;
}) {
  const Icon =
    endpoint.transport === "demo"
      ? FlaskConical
      : endpoint.transport === "reference"
        ? Terminal
        : Globe2;
  return (
    <span
      className={`rf-transport ${endpoint.transport === "demo" ? "" : "live"}`}
    >
      <Icon size={10} />
      {endpoint.transport === "demo"
        ? "LAB"
        : endpoint.transport === "reference"
          ? "REFERENCE"
          : "HTTPS"}
    </span>
  );
}

export function ConnectionState({ endpoint }: { endpoint: Endpoint }) {
  const state = !endpoint.enabled
    ? { label: "Disabled", tone: "" }
    : endpoint.transport === "demo"
      ? {
          label: endpoint.mode ?? "Lab receiver",
          tone: endpoint.mode === "healthy" ? "positive" : "warning",
        }
      : !endpoint.deliveries
        ? { label: "Not tested", tone: "" }
        : endpoint.delivered
          ? { label: "Has acknowledgements", tone: "positive" }
          : { label: "Awaiting acknowledgement", tone: "warning" };
  return (
    <span className={`rf-state ${state.tone}`}>
      <i />
      {state.label}
    </span>
  );
}

export function ProductFlow({
  current = "Connect",
}: {
  current?: "Connect" | "Send" | "Inspect" | "Recover";
}) {
  return (
    <div className="rf-flow" aria-label="Integration workflow">
      {["Connect", "Send", "Inspect", "Recover"].map((step, i) => (
        <span key={step} className={step === current ? "current" : ""}>
          {i > 0 && <ArrowRight size={12} />}
          <b>{String(i + 1).padStart(2, "0")}</b>
          {step}
        </span>
      ))}
      <small>SIGNED · PERSISTED · TRACEABLE</small>
    </div>
  );
}

export function ConnectionsPanel({
  snapshot,
  update,
  inspect,
  studio,
  recovery,
  setMode,
  connectionError,
  onDialogChange,
  busy,
}: {
  snapshot: Snapshot;
  update: (snapshot: Snapshot) => void;
  inspect: (endpointId: string) => void;
  studio: (endpointId?: string) => void;
  recovery: () => void;
  setMode: (endpointId: string, mode: ReceiverMode) => void;
  connectionError: (error: unknown) => void;
  onDialogChange: (open: boolean) => void;
  busy: boolean;
}) {
  const [result, setResult] = useState<ConnectionsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<"create" | "rotate" | null>(null);
  const [target, setTarget] = useState<Connection | null>(null);
  const [transport, setTransport] = useState<"https" | "reference">("https");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [secret, setSecret] = useState<{
    value: string;
    keyId: string;
    connectionId: string;
    transport: Endpoint["transport"];
  } | null>(null);
  const [savedSecret, setSavedSecret] = useState(false);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const pendingRef = useRef(false);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<ConnectionsResponse>("/api/connections", undefined, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setResult(data);
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
  }, [snapshot.system.now, retry, connectionError]);
  useEffect(() => {
    onDialogChange(Boolean(dialog));
    return () => onDialogChange(false);
  }, [dialog, onDialogChange]);
  const close = () => {
    if (pendingRef.current) return;
    onDialogChange(false);
    setDialog(null);
    setSecret(null);
    setDialogError(null);
    setSavedSecret(false);
  };
  const begin = (event: { currentTarget: HTMLElement }) => {
    openerRef.current = event.currentTarget;
    setName("");
    setUrl("");
    setDescription("");
    setSecret(null);
    setSavedSecret(false);
    setDialogError(null);
    setTransport(
      result?.configuration.allowedHosts.length
        ? "https"
        : result?.configuration.referenceEnabled
          ? "reference"
          : "https",
    );
    setDialog("create");
  };
  const run = async (
    operation: () => Promise<ConnectionMutationResponse>,
    inDialog = false,
  ) => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    if (inDialog) setDialogError(null);
    else setError(null);
    try {
      const response = await operation();
      update(response.snapshot);
      if (response.signingSecret) {
        setSecret({
          value: response.signingSecret,
          keyId: response.keyId ?? response.connection.signing?.keyId ?? "",
          connectionId: response.connection.id,
          transport: response.connection.transport,
        });
        setSavedSecret(false);
      } else if (inDialog) close();
    } catch (err) {
      if (inDialog) setDialogError(err);
      else setError(err);
      connectionError(err);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(
      () =>
        api<ConnectionMutationResponse>("/api/connections", {
          name: name.trim(),
          description: description.trim(),
          transport,
          ...(transport === "https" ? { url: url.trim() } : {}),
        }),
      true,
    );
  };
  const live = snapshot.endpoints.filter(
    (endpoint) => endpoint.transport !== "demo",
  );
  const lab = snapshot.endpoints.filter(
    (endpoint) => endpoint.transport === "demo",
  );
  const connections = result?.connections ?? [];
  const configuration = result?.configuration;
  const card = (endpoint: Endpoint) => {
    const connection = connections.find((item) => item.id === endpoint.id);
    return (
      <article
        key={endpoint.id}
        className={`rf-connection ${!endpoint.enabled ? "disabled" : ""}`}
      >
        <div className="rf-connection-top">
          <span
            className={`rf-connection-symbol ${endpoint.transport === "demo" ? "lab" : ""}`}
          >
            {endpoint.transport === "demo" ? (
              <FlaskConical size={20} />
            ) : endpoint.transport === "reference" ? (
              <Terminal size={20} />
            ) : (
              <Globe2 size={20} />
            )}
          </span>
          <div>
            <h3>{endpoint.name}</h3>
            <code className="rf-connection-url" title={endpoint.url}>
              {endpoint.url}
            </code>
          </div>
          <TransportBadge endpoint={endpoint} />
        </div>
        <p className="rf-connection-desc">
          {endpoint.description ||
            (endpoint.transport === "demo"
              ? "A controlled receiver for practicing failures and recovery."
              : "Signed events delivered by the background worker.")}
        </p>
        <div className="rf-connection-stats">
          <div>
            <span>Accepted events</span>
            <strong>{formatNumber(endpoint.deliveries)}</strong>
          </div>
          <div>
            <span>
              {endpoint.transport === "demo" ? "Delivered" : "Acknowledged"}
            </span>
            <strong>{formatNumber(endpoint.delivered)}</strong>
          </div>
          <div>
            <span>Last duration</span>
            <strong>{formatDuration(endpoint.lastDurationMs)}</strong>
          </div>
        </div>
        {endpoint.transport === "demo" && endpoint.purpose !== "recovery" && (
          <div className="behavior-control" style={{ padding: "16px 22px" }}>
            <span className="control-label">Lab behavior</span>
            <div>
              {(
                ["healthy", "flaky", "failing", "timeout"] as ReceiverMode[]
              ).map((mode) => (
                <button
                  key={mode}
                  aria-pressed={mode === endpoint.mode}
                  className={
                    mode === endpoint.mode ? `active behavior-${mode}` : ""
                  }
                  disabled={busy || pending}
                  onClick={() => setMode(endpoint.id, mode)}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="rf-connection-foot">
          <ConnectionState endpoint={endpoint} />
          <span className="rf-foot-spacer" />
          <button className="text-button" onClick={() => inspect(endpoint.id)}>
            Inspect <ArrowRight size={13} />
          </button>
          <button
            className="text-button"
            disabled={busy || pending || !endpoint.enabled}
            onClick={() =>
              endpoint.purpose === "recovery" ? recovery() : studio(endpoint.id)
            }
          >
            {endpoint.purpose === "recovery" ? (
              <Wrench size={13} />
            ) : (
              <Send size={13} />
            )}
            {endpoint.purpose === "recovery" ? "Recovery guide" : "Send event"}
          </button>
        </div>
        {connection && endpoint.transport !== "demo" && (
          <div className="rf-connection-foot">
            <span className="rf-state">
              <KeyRound size={12} />
              <span title={connection.signing?.keyId}>
                {connection.signing
                  ? `Key ${connection.signing.keyId.slice(0, 12)}`
                  : "Signing unavailable"}
              </span>
            </span>
            <span className="rf-foot-spacer" />
            <button
              className="text-button"
              disabled={
                busy ||
                pending ||
                !configuration?.signingAvailable ||
                Boolean(
                  connection.signing?.previousExpiresAt &&
                  connection.signing.previousExpiresAt > snapshot.system.now,
                )
              }
              onClick={(event) => {
                openerRef.current = event.currentTarget;
                setTarget(connection);
                setDialogError(null);
                setSecret(null);
                setSavedSecret(false);
                setDialog("rotate");
              }}
            >
              <RotateCcw size={12} />
              Rotate key
            </button>
            <button
              className="text-button"
              disabled={busy || pending}
              onClick={() =>
                void run(() =>
                  api<ConnectionMutationResponse>(
                    `/api/connections/${encodeURIComponent(endpoint.id)}`,
                    {
                      enabled: !endpoint.enabled,
                      expectedRevision: endpoint.revision,
                    },
                    undefined,
                    "PATCH",
                  ),
                )
              }
            >
              {endpoint.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        )}
        {connection?.signing?.previousExpiresAt &&
          connection.signing.previousExpiresAt > snapshot.system.now && (
            <div className="rf-observation">
              Two signatures are active until{" "}
              {fullDate(connection.signing.previousExpiresAt)}. Another rotation
              becomes available after this grace period.
            </div>
          )}
      </article>
    );
  };
  return (
    <>
      <div className="rf-product-header">
        <div>
          <span className="rf-eyebrow">
            <i />
            BUILD / CONNECTIONS
          </span>
          <h1>Where events become outcomes.</h1>
          <p>
            Connect a real destination, sign every delivery, and keep its entire
            story in one place.
          </p>
        </div>
        <div className="rf-header-actions">
          <Button
            disabled={
              busy ||
              pending ||
              !configuration?.signingAvailable ||
              !(
                configuration.allowedHosts.length ||
                configuration.referenceEnabled
              )
            }
            onClick={begin}
          >
            <Plus size={16} />
            New connection
          </Button>
        </div>
      </div>
      <ProductFlow />
      {error && <RequestFeedback error={error} focus={false} />}
      {!result && !error && (
        <div className="rf-inline-loader">
          <LoaderCircle size={18} className="spin" />
          Loading connection settings…
        </div>
      )}
      {!result && error && (
        <Button
          variant="secondary"
          onClick={() => setRetry((value) => value + 1)}
        >
          <RotateCcw size={15} />
          Retry
        </Button>
      )}
      <div className="rf-section-label">
        <div>
          <h2>Live connections</h2>
          <p>
            Real HTTP delivery. Individual signing keys. Complete attempt
            history.
          </p>
        </div>
        <span>
          {live.length} CONNECTION{live.length === 1 ? "" : "S"}
        </span>
      </div>
      {live.length ? (
        <div className="rf-connections-grid">{live.map(card)}</div>
      ) : (
        <section className="rf-studio-panel">
          <EmptyState
            title="Your first integration starts here"
            description="Add an allowed HTTPS destination or the independent reference receiver to send your first real webhook."
          >
            <Button
              disabled={
                !configuration?.signingAvailable ||
                !(
                  configuration.allowedHosts.length ||
                  configuration.referenceEnabled
                )
              }
              onClick={begin}
            >
              <Plus size={15} />
              Create connection
            </Button>
          </EmptyState>
        </section>
      )}
      {configuration && (
        <div className="rf-config-note">
          <ShieldCheck size={19} />
          <div>
            <strong>
              {configuration.signingAvailable
                ? "Destinations are checked before every attempt."
                : "Live signing needs server configuration."}
            </strong>
            {configuration.signingAvailable ? (
              <>
                HTTPS destinations must use an allowed hostname.{" "}
                {configuration.allowedHosts.length ? (
                  <>
                    Allowed:{" "}
                    <code>{configuration.allowedHosts.join(", ")}</code>.
                  </>
                ) : (
                  "No HTTPS hostnames are enabled yet."
                )}{" "}
                {configuration.referenceEnabled &&
                  "The local reference receiver is available."}
              </>
            ) : (
              "Configure the encryption key outside the project before creating live connections."
            )}
          </div>
        </div>
      )}
      <div className="rf-section-label">
        <div>
          <h2>Reliability Lab</h2>
          <p>
            Practice retries and recovery without sending to external services.
          </p>
        </div>
        <span>ISOLATED METRICS</span>
      </div>
      <div className="rf-connections-grid">{lab.map(card)}</div>
      {dialog &&
        createPortal(
          <Dialog
            returnFocus={openerRef}
            title={
              secret
                ? "Save your signing secret"
                : dialog === "create"
                  ? "Create a connection"
                  : "Rotate signing key"
            }
            onClose={close}
          >
            <form
              onSubmit={
                dialog === "create" && !secret
                  ? create
                  : (event) => {
                      event.preventDefault();
                      if (secret && savedSecret) {
                        const id = secret.connectionId;
                        close();
                        studio(id);
                      } else if (dialog === "rotate" && target)
                        void run(
                          () =>
                            api<ConnectionMutationResponse>(
                              `/api/connections/${encodeURIComponent(target.id)}/rotate`,
                              { expectedRevision: target.revision },
                            ),
                          true,
                        );
                    }
              }
            >
              <div className="modal-head">
                <div>
                  <span className="modal-icon">
                    <Webhook size={21} />
                  </span>
                  <div>
                    <h2>
                      {secret
                        ? "Save the signing secret"
                        : dialog === "create"
                          ? "Create a connection"
                          : "Rotate the signing key"}
                    </h2>
                    <p>
                      {secret
                        ? "Use this secret in your receiver to verify deliveries."
                        : dialog === "create"
                          ? "A destination with its own signing identity."
                          : target?.name}
                    </p>
                  </div>
                </div>
                <CloseButton onClick={close} label="Close connection dialog" />
              </div>
              <div className="modal-body">
                {dialog === "create" && (
                  <div className="rf-modal-step">
                    <span className={!secret ? "active" : ""}>
                      01 Destination
                    </span>
                    <span className={secret ? "active" : ""}>
                      02 Signing setup
                    </span>
                    <span>03 First event</span>
                  </div>
                )}
                {secret ? (
                  <>
                    <div className="rf-secret">
                      <h3>
                        <KeyRound size={17} />
                        Shown once. Keep it safe.
                      </h3>
                      <p>
                        This secret is encrypted at rest. It will not appear
                        again after you close this dialog.
                      </p>
                      <code>{secret.value}</code>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(secret.value)
                            .catch(() =>
                              setDialogError(
                                new Error(
                                  "Select the secret to copy it manually.",
                                ),
                              ),
                            );
                        }}
                      >
                        <Copy size={13} />
                        Copy signing secret
                      </Button>
                    </div>
                    <div className="rf-config-note">
                      <Webhook size={17} />
                      <div style={{ minWidth: 0 }}>
                        <strong>Connection ID</strong>
                        <code style={{ overflowWrap: "anywhere" }}>
                          {secret.connectionId}
                        </code>
                        <button
                          type="button"
                          className="text-button"
                          style={{ marginTop: 9 }}
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(secret.connectionId)
                              .catch(() =>
                                setDialogError(
                                  new Error(
                                    "Select the connection ID to copy it manually.",
                                  ),
                                ),
                              )
                          }
                        >
                          <Copy size={12} />
                          Copy connection ID
                        </button>
                      </div>
                    </div>
                    <div className="rf-config-note">
                      <ShieldCheck size={17} />
                      <div>
                        <strong>Signature verification</strong>Verify the
                        timestamp and HMAC signature using key ID{" "}
                        <code>{secret.keyId}</code>.{" "}
                        {dialog === "rotate" &&
                          "The previous key remains valid for 24 hours while you update your receiver."}
                      </div>
                    </div>
                    {secret.transport === "reference" && (
                      <div className="rf-secret">
                        <h3>
                          <Terminal size={17} />
                          Reference receiver configuration
                        </h3>
                        <p>
                          {dialog === "rotate"
                            ? "Add the new key to this connection’s existing keys. Keep its previous key with the recorded expiry during the 24-hour grace period."
                            : "Add this connection entry to your protected receiver file. Keep any existing connections and the receiver’s selected mode."}
                        </p>
                        <pre
                          className="rf-curl"
                          style={{
                            padding: 13,
                            borderRadius: 7,
                            marginBottom: 12,
                          }}
                          tabIndex={0}
                        >
                          {JSON.stringify(
                            {
                              mode: "healthy",
                              connections: [
                                {
                                  endpointId: secret.connectionId,
                                  keys: [
                                    {
                                      keyId: secret.keyId,
                                      secret: secret.value,
                                    },
                                  ],
                                },
                              ],
                            },
                            null,
                            2,
                          )}
                        </pre>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(
                                JSON.stringify(
                                  {
                                    mode: "healthy",
                                    connections: [
                                      {
                                        endpointId: secret.connectionId,
                                        keys: [
                                          {
                                            keyId: secret.keyId,
                                            secret: secret.value,
                                          },
                                        ],
                                      },
                                    ],
                                  },
                                  null,
                                  2,
                                ),
                              )
                              .catch(() =>
                                setDialogError(
                                  new Error(
                                    "Select the receiver configuration to copy it manually.",
                                  ),
                                ),
                              )
                          }
                        >
                          <Copy size={13} />
                          Copy receiver configuration
                        </Button>
                      </div>
                    )}
                    <label className="rf-key-check">
                      <input
                        type="checkbox"
                        checked={savedSecret}
                        onChange={(event) =>
                          setSavedSecret(event.target.checked)
                        }
                      />
                      I saved this secret in my receiver configuration.
                    </label>
                  </>
                ) : dialog === "rotate" ? (
                  <>
                    <div className="rf-config-note">
                      <RotateCcw size={18} />
                      <div>
                        <strong>Rotate without interrupting delivery.</strong>A
                        new signing key will be created. Both signatures are
                        sent for 24 hours so your receiver can accept either key
                        while you update its configuration.
                      </div>
                    </div>
                    <p className="field-hint">
                      Current key:{" "}
                      <code>{target?.signing?.keyId ?? "Unavailable"}</code>
                      {target?.signing?.previousExpiresAt
                        ? ` · Previous key valid until ${fullDate(target.signing.previousExpiresAt)}`
                        : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="rf-type-picker">
                      <button
                        type="button"
                        aria-pressed={transport === "https"}
                        disabled={!configuration?.allowedHosts.length}
                        onClick={() => setTransport("https")}
                      >
                        <Globe2 size={19} />
                        <span>
                          <strong>HTTPS destination</strong>
                          <small>
                            Your application, on an allowed hostname.
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={transport === "reference"}
                        disabled={!configuration?.referenceEnabled}
                        onClick={() => setTransport("reference")}
                      >
                        <Terminal size={19} />
                        <span>
                          <strong>Reference receiver</strong>
                          <small>Independent local HTTP service.</small>
                        </span>
                      </button>
                    </div>
                    <label className="field">
                      <span className="field-label">Connection name</span>
                      <input
                        autoComplete="off"
                        required
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={80}
                        placeholder="e.g. Billing service"
                      />
                    </label>
                    {transport === "https" && (
                      <label className="field">
                        <span className="field-label">Destination URL</span>
                        <input
                          type="url"
                          required
                          autoComplete="off"
                          value={url}
                          onChange={(event) => setUrl(event.target.value)}
                          maxLength={2048}
                          placeholder="https://your-domain.com/webhooks"
                        />
                        <span className="field-hint">
                          HTTPS · port 443 · allowed hostname · no query string.
                          Create a new connection to change this address.
                        </span>
                      </label>
                    )}
                    {transport === "reference" && (
                      <div className="rf-config-note">
                        <Terminal size={17} />
                        <div>
                          <strong>Local reference receiver</strong>
                          <code>http://127.0.0.1:4100/webhooks</code>
                          <br />
                          Runs independently and verifies signatures before
                          recording one effect per event.
                        </div>
                      </div>
                    )}
                    <label className="field">
                      <span className="field-label">
                        Description <small>Optional</small>
                      </span>
                      <input
                        autoComplete="off"
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                        maxLength={240}
                        placeholder="What happens when this service receives an event?"
                      />
                    </label>
                  </>
                )}
                <RequestFeedback error={dialogError} />
              </div>
              <div className="modal-foot">
                <Button variant="ghost" onClick={close} disabled={pending}>
                  {secret ? "Close" : "Cancel"}
                </Button>
                <Button
                  type="submit"
                  disabled={pending || (secret !== null && !savedSecret)}
                >
                  {pending ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : secret ? (
                    <Send size={16} />
                  ) : dialog === "rotate" ? (
                    <RotateCcw size={16} />
                  ) : (
                    <ArrowRight size={16} />
                  )}
                  {pending
                    ? "Saving…"
                    : secret
                      ? "Send the first event"
                      : dialog === "rotate"
                        ? "Rotate signing key"
                        : "Create connection"}
                </Button>
              </div>
            </form>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
