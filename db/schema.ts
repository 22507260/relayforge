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
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);
export const authRateLimits = sqliteTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: integer("window_start").notNull(),
  attempts: integer("attempts").notNull(),
});

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
    statusCode: integer("status_code"),
    error: text("error"),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
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
