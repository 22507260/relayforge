import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AuthService,
  hashPassword,
  SESSION_DURATION_MS,
} from "../lib/server/auth.ts";
import { SqliteDatabase } from "../lib/server/database.ts";
import { ApiError } from "../lib/server/domain.ts";
import {
  parseSecurityAction,
  validateSecurityAction,
} from "../lib/server/http.ts";
import type {
  SqlDatabase,
  SqlResult,
  SqlStatement,
} from "../lib/server/sql.ts";

const credentials = {
  email: "security-alice@example.test",
  password: "original account password",
};
const replacement = "replacement account password";
const status = (expected: number) => (error: unknown) =>
  error instanceof ApiError && error.status === expected;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture(context: TestContext) {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  let now = 1_800_000_000_000;
  const auth = new AuthService(db, () => now);
  const original = await auth.register(credentials);
  return {
    db,
    auth,
    original,
    clock: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

/** Delay one real database read to make an otherwise timing-dependent stale-read race reproducible. */
class ReadGate implements SqlDatabase {
  private db: SqliteDatabase;
  private predicate: (sql: string) => boolean;
  private used = false;
  reached: Promise<void>;
  private signal!: () => void;
  private released: Promise<void>;
  release!: () => void;
  constructor(db: SqliteDatabase, predicate: (sql: string) => boolean) {
    this.db = db;
    this.predicate = predicate;
    this.reached = new Promise((resolve) => {
      this.signal = resolve;
    });
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  prepare(sql: string): SqlStatement {
    const statement = this.db.prepare(sql);
    if (!this.used && this.predicate(sql)) {
      this.used = true;
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const value = await first<T>();
        this.signal();
        await this.released;
        return value;
      };
    }
    return statement;
  }
  batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.db.batch<T>(statements);
  }
}

test("the account migration preserves old credentials, tokens and delivery history while assigning distinct public session IDs", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-account-upgrade-"));
  const migrations = join(directory, "previous-migrations");
  mkdirSync(migrations);
  for (const name of readdirSync(join(process.cwd(), "drizzle"))) {
    if (/^000[0-3]_.*\.sql$/.test(name))
      copyFileSync(
        join(process.cwd(), "drizzle", name),
        join(migrations, name),
      );
  }
  const filename = join(directory, "account.sqlite");
  const old = new SqliteDatabase(filename, migrations);
  const token = "A".repeat(43);
  const otherToken = "B".repeat(43);
  const passwordHash = await hashPassword(credentials.password);
  old.connection
    .prepare(
      "INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)",
    )
    .run("legacy-user", credentials.email, passwordHash, 100);
  const insert = old.connection.prepare(
    "INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)",
  );
  insert.run(
    sha256(token),
    "legacy-user",
    100,
    Date.now() + SESSION_DURATION_MS,
  );
  insert.run(
    sha256(otherToken),
    "legacy-user",
    100,
    Date.now() + SESSION_DURATION_MS,
  );
  old.connection
    .exec(`INSERT INTO workspaces (owner,signing_secret,created_at) VALUES ('legacy-user','legacy-secret',100);
    INSERT INTO endpoints (id,owner,name,description,color,mode) VALUES ('legacy-endpoint','legacy-user','Legacy','','#fff','failing');
    INSERT INTO deliveries (id,owner,endpoint_id,event_type,payload,payload_hash,idempotency_key,status,attempts,created_at,updated_at,current_cycle) VALUES ('legacy-event','legacy-user','legacy-endpoint','legacy.failed','{"unchanged":true}','legacy-hash','legacy-key','dead',4,100,200,2);
    INSERT INTO attempts (id,owner,event_id,number,cycle,status_code,error,created_at,finished_at) VALUES ('legacy-attempt','legacy-user','legacy-event',4,2,503,'Legacy error',200,200);`);
  const delivery = old.connection.prepare("SELECT * FROM deliveries").get();
  const attempt = old.connection.prepare("SELECT * FROM attempts").get();
  old.close();
  const db = new SqliteDatabase(filename);
  context.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const auth = new AuthService(db);
  assert.equal((await auth.userForSession(token))?.id, "legacy-user");
  const account = await auth.getSecurity(token);
  assert.equal(account.sessionCount, 2);
  assert.equal(new Set(account.sessions.map((session) => session.id)).size, 2);
  assert.ok(
    account.sessions.every(
      (session) => session.id && session.id !== sha256(token),
    ),
  );
  assert.deepEqual(
    db.connection.prepare("SELECT * FROM deliveries").get(),
    delivery,
  );
  assert.deepEqual(
    db.connection.prepare("SELECT * FROM attempts").get(),
    attempt,
  );
  assert.equal(
    db.connection.prepare("SELECT password_hash FROM users").get()!
      .password_hash,
    passwordHash,
  );
  assert.equal((await auth.login(credentials)).user.id, "legacy-user");
});

test("security snapshots cap sessions, prioritize the current session and exclude authentication material", async (context) => {
  const { db, auth, original, advance, clock } = await fixture(context);
  const insert = db.connection.prepare(
    "INSERT INTO sessions (token_hash,user_id,created_at,expires_at,public_id,last_seen_at) VALUES (?,?,?,?,?,?)",
  );
  for (let index = 0; index < 54; index++)
    insert.run(
      sha256(`extra-${index}`),
      original.user.id,
      clock() + index + 1,
      clock() + SESSION_DURATION_MS,
      `public-${index}`,
      null,
    );
  insert.run(
    sha256("expired"),
    original.user.id,
    clock() - SESSION_DURATION_MS,
    clock(),
    "public-expired",
    null,
  );
  const insertEvent = db.connection.prepare(
    "INSERT INTO security_events (id,owner,kind,message,created_at) VALUES (?,?,?,?,?)",
  );
  for (let index = 0; index < 24; index++)
    insertEvent.run(
      `security-history-${index}`,
      original.user.id,
      "signed-in",
      "Signed in to RelayForge.",
      clock() + index + 1,
    );
  advance(65_000);
  await auth.userForSession(original.token);
  const account = await auth.getSecurity(original.token);
  assert.equal(account.sessionCount, 55);
  assert.equal(account.sessions.length, 50);
  assert.equal(account.events.length, 20);
  assert.equal(account.events[0].id, "security-history-23");
  assert.equal(account.events.at(-1)?.id, "security-history-4");
  assert.equal(account.sessions[0].isCurrent, true);
  assert.equal(account.currentSessionId, account.sessions[0].id);
  assert.ok(
    account.sessions[0].lastSeenAt && account.sessions[0].lastSeenAt <= clock(),
  );
  assert.ok(
    !account.sessions.some((session) => session.id === "public-expired"),
  );
  const serialized = JSON.stringify(account);
  for (const secret of [
    original.token,
    sha256(original.token),
    credentials.password,
    "password_hash",
    "token_hash",
    "scrypt$",
  ])
    assert.ok(!serialized.includes(secret));
  assert.equal(
    await auth.userForSession(account.currentSessionId),
    null,
    "Public session IDs cannot authenticate",
  );
  await assert.rejects(auth.getSecurity(undefined), status(401));
});

test("revocation is owner scoped, refuses the current session and records fixed security messages", async (context) => {
  const { auth, original } = await fixture(context);
  const second = await auth.login(credentials);
  const third = await auth.login(credentials);
  const foreign = await auth.register({
    email: "security-bob@example.test",
    password: "another account password",
  });
  const foreignId = (await auth.getSecurity(foreign.token)).currentSessionId;
  const currentId = (await auth.getSecurity(original.token)).currentSessionId;
  const secondId = (await auth.getSecurity(second.token)).currentSessionId;
  await assert.rejects(
    auth.mutateSecurity(original.token, {
      type: "revoke-session",
      sessionId: currentId,
    }),
    status(409),
  );
  const errors = [];
  for (const sessionId of [foreignId, "unknown-session"]) {
    try {
      await auth.mutateSecurity(original.token, {
        type: "revoke-session",
        sessionId,
      });
    } catch (error) {
      assert.ok(status(404)(error));
      errors.push((error as Error).message);
    }
  }
  assert.equal(
    errors[0],
    errors[1],
    "Unknown and foreign IDs have indistinguishable responses",
  );
  const revoked = await auth.mutateSecurity(original.token, {
    type: "revoke-session",
    sessionId: secondId,
  });
  assert.equal(revoked.revokedSessions, 1);
  assert.equal(await auth.userForSession(second.token), null);
  assert.equal((await auth.userForSession(third.token))?.id, original.user.id);
  const others = await auth.mutateSecurity(original.token, {
    type: "revoke-other-sessions",
  });
  assert.equal(others.revokedSessions, 1);
  assert.equal(await auth.userForSession(third.token), null);
  assert.equal((await auth.userForSession(foreign.token))?.id, foreign.user.id);
  assert.ok(
    others.security.events.some((event) => event.kind === "session-revoked"),
  );
  assert.ok(
    others.security.events.some(
      (event) => event.kind === "other-sessions-revoked",
    ),
  );
  for (const event of others.security.events) {
    assert.ok(!event.message.includes(secondId));
    assert.ok(!event.message.includes(credentials.email));
    assert.ok(!event.message.includes(original.token));
  }
});

test("password changes require the old password, rotate the current cookie and revoke every old session without affecting another account", async (context) => {
  const { auth, original } = await fixture(context);
  const other = await auth.login(credentials);
  const foreign = await auth.register({
    email: "security-password-bob@example.test",
    password: "another account password",
  });
  const before = await auth.getSecurity(original.token);
  await assert.rejects(
    auth.mutateSecurity(original.token, {
      type: "change-password",
      currentPassword: "wrong old password",
      newPassword: replacement,
    }),
    status(401),
  );
  assert.equal(
    (await auth.getSecurity(original.token)).sessionCount,
    before.sessionCount,
  );
  const changed = await auth.mutateSecurity(original.token, {
    type: "change-password",
    currentPassword: credentials.password,
    newPassword: replacement,
  });
  assert.ok(changed.newSession);
  assert.notEqual(changed.newSession.token, original.token);
  assert.equal(changed.revokedSessions, 2);
  assert.equal(changed.security.sessionCount, 1);
  assert.equal(await auth.userForSession(original.token), null);
  assert.equal(await auth.userForSession(other.token), null);
  assert.equal(
    (await auth.userForSession(changed.newSession.token))?.id,
    original.user.id,
  );
  assert.equal((await auth.userForSession(foreign.token))?.id, foreign.user.id);
  await assert.rejects(auth.login(credentials), status(401));
  assert.equal(
    (await auth.login({ ...credentials, password: replacement })).user.id,
    original.user.id,
  );
  assert.ok(
    changed.security.events.some((event) => event.kind === "password-changed"),
  );
});

test("a failed audit insert rolls back a password change and all session revocations", async (context) => {
  const { db, auth, original } = await fixture(context);
  const second = await auth.login(credentials);
  const hash = db.connection
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(original.user.id)!.password_hash;
  db.connection.exec(
    "CREATE TRIGGER reject_password_audit BEFORE INSERT ON security_events WHEN NEW.kind = 'password-changed' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
  );
  await assert.rejects(
    auth.mutateSecurity(original.token, {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: replacement,
    }),
  );
  assert.equal(
    db.connection
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(original.user.id)!.password_hash,
    hash,
  );
  assert.equal((await auth.getSecurity(original.token)).sessionCount, 2);
  assert.equal((await auth.userForSession(second.token))?.id, original.user.id);
  assert.equal(
    db.connection
      .prepare(
        "SELECT count(*) AS count FROM security_events WHERE kind = 'password-changed'",
      )
      .get()!.count,
    0,
  );
});

test("failed security audit writes preserve targeted sessions and every session in a revoke-all operation", async (context) => {
  const { db, auth, original } = await fixture(context);
  const second = await auth.login(credentials);
  const third = await auth.login(credentials);
  const secondId = (await auth.getSecurity(second.token)).currentSessionId;
  db.connection.exec(
    "CREATE TRIGGER reject_revocation_audit BEFORE INSERT ON security_events WHEN NEW.kind IN ('session-revoked', 'other-sessions-revoked') BEGIN SELECT RAISE(ABORT, 'forced failure'); END;",
  );
  await assert.rejects(
    auth.mutateSecurity(original.token, {
      type: "revoke-session",
      sessionId: secondId,
    }),
  );
  await assert.rejects(
    auth.mutateSecurity(original.token, { type: "revoke-other-sessions" }),
  );
  assert.equal((await auth.getSecurity(original.token)).sessionCount, 3);
  assert.equal((await auth.userForSession(second.token))?.id, original.user.id);
  assert.equal((await auth.userForSession(third.token))?.id, original.user.id);
  assert.equal(
    db.connection
      .prepare(
        "SELECT count(*) AS count FROM security_events WHERE kind IN ('session-revoked','other-sessions-revoked')",
      )
      .get()!.count,
    0,
  );
});

test("a login that verified stale credentials cannot issue a session after the password changes", async (context) => {
  const { db, auth, original, clock } = await fixture(context);
  const gate = new ReadGate(
    db,
    (sql) => /password_hash/.test(sql) && /WHERE email/.test(sql),
  );
  const concurrent = new AuthService(gate, clock);
  const login = concurrent.login(credentials);
  const rejected = assert.rejects(login, status(401));
  await gate.reached;
  try {
    await auth.mutateSecurity(original.token, {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: replacement,
    });
  } finally {
    gate.release();
  }
  await rejected;
  assert.equal(
    db.connection
      .prepare("SELECT count(*) AS count FROM sessions WHERE user_id = ?")
      .get(original.user.id)!.count,
    1,
  );
});

test("a password operation cannot resurrect a session revoked after its initial authorization read", async (context) => {
  const { db, auth, original, clock } = await fixture(context);
  const survivor = await auth.login(credentials);
  const gate = new ReadGate(
    db,
    (sql) => /password_hash/.test(sql) && /sessions/.test(sql),
  );
  const concurrent = new AuthService(gate, clock);
  const change = concurrent.mutateSecurity(original.token, {
    type: "change-password",
    currentPassword: credentials.password,
    newPassword: replacement,
  });
  const rejected = assert.rejects(change, status(401));
  await gate.reached;
  try {
    await auth.mutateSecurity(survivor.token, {
      type: "revoke-other-sessions",
    });
  } finally {
    gate.release();
  }
  await rejected;
  assert.equal(await auth.userForSession(original.token), null);
  assert.equal(
    (await auth.userForSession(survivor.token))?.id,
    original.user.id,
  );
  assert.equal((await auth.login(credentials)).user.id, original.user.id);
});

test("simultaneous password changes from one session permit one committed change and one valid replacement session", async (context) => {
  const { auth, original } = await fixture(context);
  const outcomes = await Promise.allSettled([
    auth.mutateSecurity(original.token, {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: "concurrent replacement one",
    }),
    auth.mutateSecurity(original.token, {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: "concurrent replacement two",
    }),
  ]);
  const fulfilled = outcomes.filter((result) => result.status === "fulfilled");
  const rejected = outcomes.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(status(401)(rejected[0].reason));
  assert.equal(fulfilled[0].value.security.sessionCount, 1);
  assert.equal(
    (await auth.userForSession(fulfilled[0].value.newSession!.token))?.id,
    original.user.id,
  );
});

test("account mutation limits survive a new service instance and expire without locking another account", async (context) => {
  const { db, auth, original, clock, advance } = await fixture(context);
  for (let index = 0; index < 5; index++)
    await auth.mutateSecurity(original.token, {
      type: "revoke-other-sessions",
    });
  const renewed = new AuthService(db, clock);
  await assert.rejects(
    renewed.mutateSecurity(original.token, { type: "revoke-other-sessions" }),
    status(429),
  );
  const foreign = await auth.register({
    email: "security-rate-bob@example.test",
    password: "another account password",
  });
  assert.equal(
    (
      await renewed.mutateSecurity(foreign.token, {
        type: "revoke-other-sessions",
      })
    ).revokedSessions,
    0,
  );
  advance(10 * 60 * 1000);
  assert.equal(
    (
      await renewed.mutateSecurity(original.token, {
        type: "revoke-other-sessions",
      })
    ).revokedSessions,
    0,
  );
});

test("security actions reject ambiguous, excessive and unrecognized input before mutation", async () => {
  const invalid = [
    { type: "revoke-session", sessionId: "" },
    { type: "revoke-session", sessionId: "x".repeat(101) },
    { type: "revoke-session", sessionId: "../other" },
    { type: "revoke-other-sessions", owner: "other" },
    { type: "change-password", currentPassword: "", newPassword: replacement },
    {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: "short",
    },
    {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: credentials.password,
    },
    {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: "x".repeat(129),
    },
    {
      type: "change-password",
      currentPassword: credentials.password,
      newPassword: replacement,
      userId: "other",
    },
  ];
  for (const value of invalid)
    assert.throws(() => validateSecurityAction(value), status(400));
  assert.deepEqual(
    await parseSecurityAction(
      new Request("http://localhost/api/security", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "revoke-other-sessions" }),
      }),
    ),
    { type: "revoke-other-sessions" },
  );
  await assert.rejects(
    parseSecurityAction(
      new Request("http://localhost/api/security", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{broken",
      }),
    ),
    status(400),
  );
});
