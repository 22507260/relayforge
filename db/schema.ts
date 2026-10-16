import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
});
export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    publicId: text("public_id"),
    lastSeenAt: integer("last_seen_at"),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
    uniqueIndex("sessions_public_id_idx").on(table.publicId),
  ],
);
export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
});

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("security_events_owner_idx").on(table.owner, table.createdAt),
  ],
);

export const securityRateLimits = sqliteTable("security_rate_limits", {
  owner: text("owner")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
});

export const workerHeartbeats = sqliteTable(
  "worker_heartbeats",
  {
    id: text("id").primaryKey(),
    startedAt: integer("started_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [index("worker_heartbeats_seen_idx").on(table.lastSeenAt)],
);

export const workspaces = sqliteTable("workspaces", {
  owner: text("owner").primaryKey(),
  signingSecret: text("signing_secret").notNull(),
  queuePaused: integer("queue_paused", { mode: "boolean" })
    .notNull()
    .default(false),
  duplicatesPrevented: integer("duplicates_prevented").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});
export const endpoints = sqliteTable(
  "endpoints",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    name: text("name").notNull(),
    description: text("description").notNull(),
    color: text("color").notNull(),
    mode: text("mode").notNull(),
    purpose: text("purpose").notNull().default("standard"),
    transport: text("transport").notNull().default("demo"),
    destinationUrl: text("destination_url"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull().default(1),
    signingKeyId: text("signing_key_id"),
  },
  (table) => [index("endpoints_owner_idx").on(table.owner)],
);
export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    currentCycle: integer("current_cycle").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    nextAttemptAt: integer("next_attempt_at"),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until"),
  },
  (table) => [
    uniqueIndex("deliveries_idempotency_idx").on(
      table.owner,
      table.endpointId,
      table.idempotencyKey,
    ),
    index("deliveries_queue_idx").on(
      table.owner,
      table.status,
      table.nextAttemptAt,
    ),
  ],
);
export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    eventId: text("event_id")
      .notNull()
      .references(() => deliveries.id),
    number: integer("number").notNull(),
    cycle: integer("cycle"),
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    failureCode: text("failure_code"),
    signingKeyIds: text("signing_key_ids"),
    connectionRevision: integer("connection_revision"),
  },
  (table) => [index("attempts_event_idx").on(table.owner, table.eventId)],
);
export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    kind: text("kind").notNull(),
    eventId: text("event_id"),
    message: text("message").notNull(),
    createdAt: integer("created_at").notNull(),
    cycle: integer("cycle"),
    operationId: text("operation_id"),
  },
  (table) => [index("activity_owner_idx").on(table.owner, table.createdAt)],
);
export const receiverEffects = sqliteTable(
  "receiver_effects",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    eventId: text("event_id")
      .notNull()
      .references(() => deliveries.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("receiver_effects_event_idx").on(table.owner, table.eventId),
  ],
);

export const recoveryDemos = sqliteTable("recovery_demos", {
  owner: text("owner")
    .primaryKey()
    .references(() => workspaces.owner),
  endpointId: text("endpoint_id")
    .notNull()
    .references(() => endpoints.id),
  eventId: text("event_id")
    .notNull()
    .references(() => deliveries.id),
  previousEventId: text("previous_event_id"),
  createdAt: integer("created_at").notNull(),
  repairedAt: integer("repaired_at"),
});

export const connectionSigningKeys = sqliteTable(
  "connection_signing_keys",
  {
    keyId: text("key_id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    encryptedSecret: text("encrypted_secret").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
  },
  (table) => [
    index("connection_signing_keys_endpoint_idx").on(
      table.owner,
      table.endpointId,
    ),
  ],
);

export const producerKeys = sqliteTable(
  "producer_keys",
  {
    id: text("id").primaryKey(),
    owner: text("owner")
      .notNull()
      .references(() => workspaces.owner),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scope: text("scope").notNull().default("events:write"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("producer_keys_hash_idx").on(table.tokenHash),
    index("producer_keys_owner_idx").on(table.owner, table.createdAt),
  ],
);

export const producerRateLimits = sqliteTable("producer_rate_limits", {
  key: text("key").primaryKey(),
  owner: text("owner")
    .notNull()
    .references(() => workspaces.owner),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
  lastRequestId: text("last_request_id").notNull(),
});
