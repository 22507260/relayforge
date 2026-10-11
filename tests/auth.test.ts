import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthService,
  SESSION_DURATION_MS,
  sessionCookie,
  validateCredentials,
} from "../lib/server/auth.ts";
import { SqliteDatabase } from "../lib/server/database.ts";
import { ApiError } from "../lib/server/domain.ts";
import { RelayService } from "../lib/server/service.ts";

const alice = {
  email: "alice@example.test",
  password: "correct horse battery staple",
};
const bob = { email: "bob@example.test", password: "another long password" };
const status = (expected: number) => (error: unknown) =>
  error instanceof ApiError && error.status === expected;

test("registration stores a salted password hash and a hashed opaque session token", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db);
  const session = await auth.register({
    ...alice,
    email: "  ALICE@example.test  ",
  });
  assert.equal(session.user.email, alice.email);
  assert.equal(session.token.length, 43);
  const row = db.connection.prepare("SELECT password_hash FROM users").get()!;
  assert.match(String(row.password_hash), /^scrypt\$32768\$8\$1\$/);
  assert.equal(String(row.password_hash).includes(alice.password), false);
  const sessionRow = db.connection
    .prepare("SELECT token_hash FROM sessions")
    .get()!;
  assert.equal(String(sessionRow.token_hash).length, 64);
  assert.notEqual(sessionRow.token_hash, session.token);
  assert.deepEqual(await auth.userForSession(session.token), session.user);
  assert.equal(await auth.userForSession("forged-session"), null);
  assert.equal(await auth.userForSession("A".repeat(43)), null);
  await assert.rejects(auth.register(alice), status(409));
});

test("login uses uniform credential errors, a new session, and revocable expiring cookies", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  let now = 1_800_000_000_000;
  const auth = new AuthService(db, () => now);
  const original = await auth.register(alice);
  let existingMessage = "";
  let missingMessage = "";
  try {
    await auth.login({ ...alice, password: "incorrect password" });
  } catch (error) {
    existingMessage = (error as Error).message;
  }
  try {
    await auth.login({
      ...alice,
      email: "missing@example.test",
      password: "incorrect password",
    });
  } catch (error) {
    missingMessage = (error as Error).message;
  }
  assert.equal(existingMessage, "Email or password is incorrect.");
  assert.equal(missingMessage, existingMessage);
  const loggedIn = await auth.login(alice);
  assert.notEqual(loggedIn.token, original.token);
  assert.equal(loggedIn.user.id, original.user.id);
  await auth.logout(original.token);
  assert.equal(await auth.userForSession(original.token), null);
  assert.equal(
    (await auth.userForSession(loggedIn.token))?.id,
    original.user.id,
  );
  now += SESSION_DURATION_MS;
  assert.equal(await auth.userForSession(loggedIn.token), null);
  assert.match(
    sessionCookie(loggedIn.token, true),
    /HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/,
  );
  assert.equal(sessionCookie(loggedIn.token, false).includes("Secure"), false);
  assert.match(
    sessionCookie("", true),
    /relayforge_session=;.*Max-Age=0; Secure$/,
  );
});

test("authentication throttling persists across connections and expires after its window", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "relayforge-auth-"));
  const filename = join(directory, "auth.sqlite");
  const first = new SqliteDatabase(filename);
  const second = new SqliteDatabase(filename);
  context.after(() => {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let now = 1_800_000_000_000;
  const auth = new AuthService(first, () => now);
  const authOtherConnection = new AuthService(second, () => now);
  await auth.register(alice);
  for (let attempt = 0; attempt < 9; attempt++)
    await assert.rejects(
      auth.login({ ...alice, password: "incorrect password" }),
      status(401),
    );
  await assert.rejects(authOtherConnection.login(alice), status(429));
  now += 10 * 60 * 1000;
  const session = await authOtherConnection.login(alice);
  assert.equal(session.user.email, alice.email);
  assert.deepEqual(
    second.connection
      .prepare("SELECT name FROM relayforge_migrations ORDER BY name")
      .all()
      .map((row) => row.name),
    readdirSync(join(process.cwd(), "drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort(),
  );
  const rateRows = second.connection
    .prepare("SELECT count(*) AS count FROM auth_rate_limits")
    .get()!.count;
  second.connection
    .prepare("UPDATE auth_rate_limits SET attempts = 100 WHERE key = 'global'")
    .run();
  for (let attempt = 0; attempt < 20; attempt++) {
    await assert.rejects(
      authOtherConnection.login({
        ...alice,
        email: `new-${attempt}@example.test`,
      }),
      status(429),
    );
  }
  assert.equal(
    second.connection
      .prepare("SELECT count(*) AS count FROM auth_rate_limits")
      .get()!.count,
    rateRows,
  );
});

test("real account sessions map to isolated relay workspaces", async (context) => {
  const db = new SqliteDatabase(":memory:");
  context.after(() => db.close());
  const auth = new AuthService(db);
  const aliceSession = await auth.register(alice);
  const bobSession = await auth.register(bob);
  const aliceUser = (await auth.userForSession(aliceSession.token))!;
  const bobUser = (await auth.userForSession(bobSession.token))!;
  const aliceRelay = new RelayService(db, aliceUser.id);
  const bobRelay = new RelayService(db, bobUser.id);
  await aliceRelay.initialize();
  await bobRelay.initialize();
  const endpoint = (await aliceRelay.snapshot()).endpoints.find(
    (row) => row.mode === "healthy",
  )!;
  const eventId = await aliceRelay.send(endpoint.id, "invoice.paid", {
    amount: 42,
  });
  await assert.rejects(bobRelay.detail(eventId), status(404));
  await assert.rejects(bobRelay.send(endpoint.id, "invoice.paid"), status(404));
  assert.equal((await bobRelay.snapshot()).metrics.total, 0);
  assert.equal((await aliceRelay.snapshot()).metrics.total, 1);
});

test("credentials reject short passwords, invalid emails, oversized passwords, and extra fields", () => {
  for (const value of [
    { ...alice, password: "short" },
    { ...alice, password: "a".repeat(129) },
    { ...alice, email: "invalid" },
    { ...alice, userId: "another-user" },
  ])
    assert.throws(() => validateCredentials(value), status(400));
});
