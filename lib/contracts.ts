export type DeliveryStatus = "pending" | "delivered" | "retrying" | "dead";
export type ReceiverMode = "healthy" | "flaky" | "failing" | "timeout";

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  description: string;
  color: string;
  mode: ReceiverMode;
  deliveries: number;
  delivered: number;
  lastDurationMs: number | null;
}

export interface Delivery {
  id: string;
  eventType: string;
  endpointId: string;
  endpointName: string;
  status: DeliveryStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number | null;
  payload: string;
  latestAttempt: {
    statusCode: number | null;
    durationMs: number | null;
    error: string | null;
    createdAt: number;
    finishedAt: number | null;
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
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  createdAt: number;
  finishedAt: number | null;
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
}

export interface Snapshot {
  user: { id: string; email: string } | null;
  endpoints: Endpoint[];
  deliveries: Delivery[];
  activity: Activity[];
  metrics: {
    total: number;
    delivered: number;
    queued: number;
    dead: number;
    successRate: number;
    avgLatency: number;
    duplicatesPrevented: number;
    businessEffects: number;
  };
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
  | { type: "replay"; eventId: string }
  | { type: "pause"; paused: boolean }
  | { type: "pump" };

export interface DeliveryDetail {
  delivery: Delivery;
  attempts: Attempt[];
}
