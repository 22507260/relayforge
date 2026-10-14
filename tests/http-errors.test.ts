import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthService } from "../lib/server/auth.ts";
import { SqliteDatabase } from "../lib/server/database.ts";
import { ApiError } from "../lib/server/domain.ts";
import { json, route } from "../lib/server/http.ts";
import type { ApiErrorCode, ApiFailure } from "../lib/contracts.ts";
import type {
  SqlDatabase,
  SqlResult,
  SqlStatement,
} from "../lib/server/sql.ts";

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Hold one real read so a committed account change occurs before its write. */
class ReadGate implements SqlDatabase {
  private db: SqliteDatabase;
  private predicate: (sql: string) => boolean;
  private used = false;
  private signal!: () => void;
  reached: Promise<void>;
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

async function failure(response: Response): Promise<ApiFailure> {
  const body = (await response.json()) as ApiFailure;
  assert.deepEqual(Object.keys(body).sort(), ["code", "error", "requestId"]);
  assert.match(body.requestId, uuid);
  assert.equal(response.headers.get("x-request-id"), body.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return body;
}

test("API status defaults preserve safe messages and expose stable error codes", async () => {
  const cases: [number, ApiErrorCode][] = [
    [400, "invalid_request"],
    [401, "auth_required"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [503, "internal_error"],
    [422, "request_failed"],
  ];
  const ids = new Set<string>();
  for (const [status, code] of cases) {
    const response = await route(async () => {
      throw new ApiError(status, "A safe public explanation.");
    });
    assert.equal(response.status, status);
    const body = await failure(response);
    assert.equal(body.error, "A safe public explanation.");
    assert.equal(body.code, code);
    ids.add(body.requestId);
  }
  assert.equal(
    ids.size,
    cases.length,
    "Each invocation receives a fresh request ID",
  );
});

test("distinct authentication failures retain their explicit 401 codes", async () => {
  const codes: ApiErrorCode[] = [
    "invalid_credentials",
    "current_password_incorrect",
    "session_changed",
  ];
  for (const code of codes) {
    const response = await route(async () => {
      throw new ApiError(
        401,
        "Authentication action could not complete.",
        code,
      );
    });
    assert.equal(response.status, 401);
    assert.equal((await failure(response)).code, code);
  }
});

test("successful responses receive server-owned IDs without changing cookies, body or retry headers", async () => {
  const request = new Request("http://localhost:3000/api/example", {
    headers: { "x-request-id": "client-selected-id" },
  });
  const response = await route(async () => {
    const result = json({ accepted: true }, 201);
    result.headers.set("x-request-id", request.headers.get("x-request-id")!);
    result.headers.set("set-cookie", "example=opaque; HttpOnly");
    result.headers.set("retry-after", "600");
    return result;
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { accepted: true });
  const requestId = response.headers.get("x-request-id")!;
  assert.match(requestId, uuid);
  assert.notEqual(requestId, request.headers.get("x-request-id"));
  assert.equal(response.headers.get("set-cookie"), "example=opaque; HttpOnly");
  assert.equal(response.headers.get("retry-after"), "600");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("unexpected exceptions redact names, messages, stacks and arbitrary objects from responses and logs", async (context) => {
  const entries: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => {
    entries.push(values);
  });
  const secret = "private-token-password-request-body";
  const error = new Error(`https://example.test/private?token=${secret}`);
  error.name = secret;
  error.stack = secret;
  const thrown = [error, { secret, name: secret, message: secret }, secret];
  for (const value of thrown) {
    const response = await route(async () => {
      throw value;
    });
    assert.equal(response.status, 500);
    const body = await failure(response);
    assert.equal(body.code, "internal_error");
    assert.equal(
      body.error,
      "The service could not complete this request. Try again shortly.",
    );
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.deepEqual(entries.at(-1), [
      "RelayForge request failed",
      body.requestId,
      value instanceof Error ? "Error" : "NonError",
    ]);
  }
  assert.equal(entries.length, thrown.length);
  assert.ok(!JSON.stringify(entries).includes(secret));
});

test("incorrect login and current password codes preserve a valid session and its account state", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db);
  const credentials = {
    email: "request-errors@example.test",
    password: "correct original account password",
  };
  const session = await auth.register(credentials);
  const initial = await auth.getSecurity(session.token);
  const login = await route(async () =>
    json(
      await auth.login({
        ...credentials,
        password: "incorrect login account password",
      }),
    ),
  );
  assert.equal(login.status, 401);
  assert.equal((await failure(login)).code, "invalid_credentials");
  const password = await route(async () =>
    json(
      await auth.mutateSecurity(session.token, {
        type: "change-password",
        currentPassword: "incorrect current account password",
        newPassword: "different replacement account password",
      }),
    ),
  );
  assert.equal(password.status, 401);
  assert.equal((await failure(password)).code, "current_password_incorrect");
  const after = await auth.getSecurity(session.token);
  assert.equal(after.currentSessionId, initial.currentSessionId);
  assert.equal(after.sessionCount, initial.sessionCount);
  assert.deepEqual(after.user, initial.user);
  assert.ok(!after.events.some((event) => event.kind === "password-changed"));
  assert.deepEqual(await auth.userForSession(session.token), session.user);
});

test("a stale verified login reports invalid_credentials and cannot replace the winning session", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db);
  const credentials = {
    email: "request-login-race@example.test",
    password: "correct original login password",
  };
  const original = await auth.register(credentials);
  const gate = new ReadGate(db, (sql) =>
    sql.includes("SELECT id, email, password_hash FROM users WHERE email"),
  );
  const delayed = route(async () =>
    json(await new AuthService(gate).login(credentials)),
  );
  await gate.reached;
  const changed = await auth.mutateSecurity(original.token, {
    type: "change-password",
    currentPassword: credentials.password,
    newPassword: "winning replacement login password",
  });
  gate.release();
  const response = await delayed;
  assert.equal(response.status, 401);
  assert.equal((await failure(response)).code, "invalid_credentials");
  assert.ok(changed.newSession);
  assert.equal(
    (await auth.getSecurity(changed.newSession.token)).sessionCount,
    1,
  );
  assert.equal(await auth.userForSession(original.token), null);
});

test("a password operation authorized before a winning change reports session_changed", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db);
  const credentials = {
    email: "request-password-race@example.test",
    password: "correct original security password",
  };
  const original = await auth.register(credentials);
  const gate = new ReadGate(
    db,
    (sql) =>
      sql.includes("users.password_hash") && sql.includes("sessions.public_id"),
  );
  const delayed = route(async () =>
    json(
      await new AuthService(gate).mutateSecurity(original.token, {
        type: "change-password",
        currentPassword: credentials.password,
        newPassword: "losing replacement security password",
      }),
    ),
  );
  await gate.reached;
  const changed = await auth.mutateSecurity(original.token, {
    type: "change-password",
    currentPassword: credentials.password,
    newPassword: "winning replacement security password",
  });
  gate.release();
  const response = await delayed;
  assert.equal(response.status, 401);
  assert.equal((await failure(response)).code, "session_changed");
  assert.ok(changed.newSession);
  const current = await auth.getSecurity(changed.newSession.token);
  assert.equal(current.sessionCount, 1);
  assert.equal(
    current.events.filter((event) => event.kind === "password-changed").length,
    1,
  );
  assert.equal(await auth.userForSession(original.token), null);
});
