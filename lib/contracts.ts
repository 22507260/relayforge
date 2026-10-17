export type DeliveryStatus = "pending" | "delivered" | "retrying" | "dead";
export type ReceiverMode = "healthy" | "flaky" | "failing" | "timeout";
export type ConnectionTransport = "demo" | "https" | "reference";

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  description: string;
  color: string;
  mode: ReceiverMode | null;
  transport: ConnectionTransport;
  enabled: boolean;
  revision: number;
  purpose: "standard" | "recovery";
  deliveries: number;
  delivered: number;
  lastDurationMs: number | null;
}

export interface Connection extends Endpoint {
  signing: {
    keyId: string;
    createdAt: number;
    previousKeyId: string | null;
    previousExpiresAt: number | null;
  } | null;
}
export interface ConnectionConfiguration {
  allowedHosts: string[];
  referenceEnabled: boolean;
  signingAvailable: boolean;
}
export interface ConnectionsResponse {
  connections: Connection[];
  configuration: ConnectionConfiguration;
}
export interface ConnectionMutationResponse {
  connection: Connection;
  signingSecret?: string;
  keyId?: string;
  snapshot: Snapshot;
}
export interface ProducerKey {
  id: string;
  name: string;
  endpointId: string;
  prefix: string;
  scope: "events:write";
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
export interface ProducerKeysResponse {
  keys: ProducerKey[];
}
export interface ProducerKeyCreationResponse {
  key: ProducerKey;
  token: string;
}
export interface EventAcceptance {
  eventId: string;
  duplicate: boolean;
}
export interface StudioAcceptance extends EventAcceptance {
  snapshot: Snapshot;
}

export interface Delivery {
  id: string;
  eventType: string;
  endpointId: string;
  endpointName: string;
  transport: ConnectionTransport;
  status: DeliveryStatus;
  attempts: number;
  currentCycle: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number | null;
  payload: string;
  latestAttempt: {
    cycle: number | null;
    statusCode: number | null;
    durationMs: number | null;
    error: string | null;
    createdAt: number;
    finishedAt: number | null;
    failureCode: string | null;
    signingKeyIds: string[];
    connectionRevision: number | null;
  } | null;
}

export interface DeliveryQuery {
  page: number;
  pageSize: number;
  search: string;
  status: DeliveryStatus | "all";
  endpointId: string;
}

export interface DeliveryPage {
  deliveries: Delivery[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface Attempt {
  id: string;
  eventId: string;
  number: number;
  cycle: number | null;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  createdAt: number;
  finishedAt: number | null;
  failureCode: string | null;
  signingKeyIds: string[];
  connectionRevision: number | null;
}

export interface Activity {
  id: string;
  kind:
    | "accepted"
    | "delivered"
    | "retry"
    | "dead"
    | "replay"
    | "duplicate"
    | "system";
  eventId: string | null;
  message: string;
  createdAt: number;
  cycle: number | null;
  operationId: string | null;
}

export interface ScopeMetrics {
  total: number;
  delivered: number;
  queued: number;
  dead: number;
  successRate: number;
  avgLatency: number;
  duplicatesPrevented: number;
  businessEffects: number;
}
export interface ScopeSnapshot {
  metrics: ScopeMetrics;
  chart: { label: string; delivered: number; failed: number }[];
  deliveries: Delivery[];
}

export type InsightsWindow = "1h" | "24h" | "7d";
export interface InsightsQuery {
  window: InsightsWindow;
  scope: "live" | "lab";
  endpointId: string;
}
export interface DeliveryInsights extends InsightsQuery {
  since: number;
  now: number;
  events: {
    accepted: number;
    acknowledged: number;
    dead: number;
    queued: number;
  };
  attempts: {
    total: number;
    completed: number;
    acknowledged: number;
    failed: number;
    inFlight: number;
    unmeasuredInterrupted: number;
    measured: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  httpStatuses: { statusCode: number | null; count: number }[];
  failures: { category: string; count: number }[];
  timeline: {
    startAt: number;
    endAt: number;
    accepted: number;
    acknowledged: number;
    failed: number;
  }[];
  endpoints: {
    endpointId: string;
    name: string;
    transport: ConnectionTransport;
    enabled: boolean;
    accepted: number;
    acknowledged: number;
    dead: number;
    queued: number;
    attempts: number;
    failedAttempts: number;
    p95Ms: number | null;
  }[];
  queue: {
    total: number;
    due: number;
    oldestCreatedAt: number | null;
    paused: boolean;
    blockedDisabled: number;
  };
}
export interface Snapshot {
  user: { id: string; email: string } | null;
  endpoints: Endpoint[];
  deliveries: Delivery[];
  activity: Activity[];
  recoveryDemo: RecoveryDemo | null;
  metrics: ScopeMetrics;
  scopes: { live: ScopeSnapshot; lab: ScopeSnapshot };
  chart: { label: string; delivered: number; failed: number }[];
  system: {
    queuePaused: boolean;
    processor: "worker" | "request-driven";
    worker: {
      activeWorkers: number;
      lastHeartbeatAt: number | null;
    };
    maxAttempts: number;
    eventLimit: number;
    snapshotLimit: number;
    now: number;
  };
}

export type Action =
  | { type: "initialize" }
  | {
      type: "send";
      endpointId: string;
      eventType: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | { type: "demo" }
  | { type: "set-receiver"; endpointId: string; mode: ReceiverMode }
  | { type: "replay"; eventId: string; expectedCycle?: number }
  | { type: "start-recovery-demo"; previousEventId?: string }
  | { type: "repair-recovery-demo"; eventId: string; expectedCycle: number }
  | { type: "replay-recovery-demo"; eventId: string; expectedCycle: number }
  | { type: "pause"; paused: boolean }
  | { type: "pump" };

export interface DeliveryDetail {
  delivery: Delivery;
  attempts: Attempt[];
}

export interface ReplaySelection {
  eventId: string;
  expectedCycle: number;
}

export interface ReplayBatchRequest {
  items: ReplaySelection[];
}

export interface ReplayBatchResult {
  eventId: string;
  outcome: "replayed" | "skipped";
  currentCycle: number | null;
}

export interface ReplayBatchResponse {
  results: ReplayBatchResult[];
  snapshot: Snapshot;
}

export interface RecoveryDemo {
  eventId: string;
  endpointId: string;
  createdAt: number;
  repairedAt: number | null;
  stage:
    | "failing"
    | "awaiting-repair"
    | "ready-to-replay"
    | "recovering"
    | "completed";
  delivery: Delivery;
  businessEffects: number;
}

export type SecurityEventKind =
  | "registered"
  | "signed-in"
  | "sign-in-failed"
  | "signed-out"
  | "session-revoked"
  | "other-sessions-revoked"
  | "password-changed";

export interface SecurityEvent {
  id: string;
  kind: SecurityEventKind;
  message: string;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  isCurrent: boolean;
}

export interface SecuritySnapshot {
  user: { id: string; email: string; createdAt: number };
  currentSessionId: string;
  sessions: SessionSummary[];
  sessionCount: number;
  events: SecurityEvent[];
  now: number;
}

export type SecurityAction =
  | { type: "revoke-session"; sessionId: string }
  | { type: "revoke-other-sessions" }
  | { type: "change-password"; currentPassword: string; newPassword: string };

export interface SecurityMutationResponse {
  security: SecuritySnapshot;
  revokedSessions: number;
}

export interface AuditRecord {
  id: string;
  category: "delivery" | "security";
  kind: Activity["kind"] | SecurityEventKind;
  eventId: string | null;
  cycle: number | null;
  operationId: string | null;
  message: string;
  createdAt: number;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  category: "all" | "delivery" | "security";
  kind: "all" | Activity["kind"] | SecurityEventKind;
  search: string;
  eventId: string;
  operationId: string;
  from: number | null;
  to: number | null;
}

export interface AuditPage {
  records: AuditRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const API_ERROR_CODES = [
  "invalid_request",
  "auth_required",
  "invalid_credentials",
  "current_password_incorrect",
  "session_changed",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "unsupported_media_type",
  "internal_error",
  "request_failed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiFailure {
  error: string;
  code: ApiErrorCode;
  requestId: string;
}
