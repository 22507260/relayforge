import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { ApiError } from "./domain.ts";
import { readBody, validateSecurityAction } from "./http.ts";
import type { SqlDatabase, SqlStatement } from "./sql.ts";
import type {
  SecurityAction,
  SecuritySnapshot,
  SecurityEventKind,
  SecurityMutationResponse,
} from "../contracts.ts";

export const SESSION_COOKIE = "relayforge_session";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const SESSION_TOUCH_MS = 60 * 1000;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();
export interface Credentials {
  email: string;
  password: string;
}
export interface AuthUser {
  id: string;
  email: string;
}
export interface Session {
  user: AuthUser;
  token: string;
}
export interface SecurityMutationResult extends SecurityMutationResponse {
  newSession?: Session;
}
type AuthSessionRow = AuthUser & {
  password_hash: string;
  user_created_at: number;
  public_id: string;
};
export function validateCredentials(value: unknown): Credentials {
  const parsed = credentialsSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      400,
      "Enter a valid email and a password between 12 and 128 characters.",
    );
  return parsed.data;
}
export async function parseCredentials(request: Request): Promise<Credentials> {
  const body = await readBody(request);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new ApiError(400, "Invalid JSON.");
  }
  return validateCredentials(value);
}
function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return `scrypt$32768$8$1$${salt.toString("base64")}$${derived.toString("base64")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  const fields = encoded?.split("$");
  const validFormat =
    fields?.length === 6 && fields.slice(0, 4).join("$") === "scrypt$32768$8$1";
  const salt = validFormat
    ? Buffer.from(fields![4], "base64")
    : Buffer.alloc(16);
  const expected = validFormat
    ? Buffer.from(fields![5], "base64")
    : Buffer.alloc(64);
  const valid = validFormat && salt.length === 16 && expected.length === 64;
  // A missing account performs the same expensive derivation as an existing one.
  const actual = await derivePassword(
    password,
    valid ? salt : Buffer.alloc(16),
  );
  return Boolean(valid && timingSafeEqual(actual, expected));
}
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function sessionCookie(
  token: string,
  secure = process.env.NODE_ENV === "production",
): string {
  const maxAge = token ? SESSION_DURATION_MS / 1000 : 0;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Passwords and raw session tokens never enter API snapshots or persistent session rows. */
export class AuthService {
  private db: SqlDatabase;
  private now: () => number;
  constructor(db: SqlDatabase, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }
  private async throttle(email: string): Promise<void> {
    const now = this.now();
    const results = await this.db.batch<{ attempts: number }>([
      this.db
        .prepare("DELETE FROM auth_rate_limits WHERE window_start <= ?")
        .bind(now - RATE_WINDOW_MS),
      this.db
        .prepare(
          `INSERT INTO auth_rate_limits (key, window_start, attempts) VALUES ('global', ?, 1)
        ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`,
        )
        .bind(now),
      // Once the global limit is reached, new emails cannot grow the rate-limit table.
      this.db
        .prepare(
          `INSERT INTO auth_rate_limits (key, window_start, attempts)
        SELECT ?, ?, 1 WHERE (SELECT attempts FROM auth_rate_limits WHERE key = 'global') <= 100
        ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`,
        )
        .bind(`account:${tokenHash(email)}`, now),
    ]);
    if (
      results[1].results[0].attempts > 100 ||
      results[2].results[0]?.attempts > 10
    )
      throw new ApiError(
        429,
        "Too many authentication attempts. Try again in 10 minutes.",
      );
  }
  private securityEvent(
    owner: string,
    kind: SecurityEventKind,
    message: string,
    now: number,
    condition = "1",
    values: unknown[] = [],
  ): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO security_events (id, owner, kind, message, created_at)
      SELECT ?, ?, ?, ?, ? WHERE ${condition}`,
      )
      .bind(randomUUID(), owner, kind, message, now, ...values);
  }
  private async createSession(
    user: AuthUser,
    verifiedHash: string,
  ): Promise<Session> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const results = await this.db.batch<{ public_id: string }>([
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      this.db
        .prepare(
          `INSERT INTO sessions (token_hash, public_id, user_id, created_at, expires_at, last_seen_at)
          SELECT ?, ?, id, ?, ?, ? FROM users WHERE id = ? AND password_hash = ? RETURNING public_id`,
        )
        .bind(
          tokenHash(token),
          randomUUID(),
          now,
          now + SESSION_DURATION_MS,
          now,
          user.id,
          verifiedHash,
        ),
      this.securityEvent(
        user.id,
        "signed-in",
        "Signed in to RelayForge.",
        now,
        "changes() = 1",
      ),
    ]);
    if (!results[1].results.length)
      throw new ApiError(
        401,
        "Email or password is incorrect.",
        "invalid_credentials",
      );
    return { user, token };
  }
  async register(value: unknown): Promise<Session> {
    const { email, password } = validateCredentials(value);
    await this.throttle(email);
    const passwordHash = await hashPassword(password);
    const user = { id: randomUUID(), email };
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const results = await this.db.batch<{ id: string }>([
      this.db
        .prepare(
          "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id",
        )
        .bind(user.id, email, passwordHash, now),
      this.db
        .prepare(
          `INSERT INTO sessions (token_hash, public_id, user_id, created_at, expires_at, last_seen_at)
        SELECT ?, ?, id, ?, ?, ? FROM users WHERE id = ?`,
        )
        .bind(
          tokenHash(token),
          randomUUID(),
          now,
          now + SESSION_DURATION_MS,
          now,
          user.id,
        ),
      this.securityEvent(
        user.id,
        "registered",
        "Created a RelayForge account.",
        now,
        "changes() = 1",
      ),
    ]);
    if (!results[0].results.length)
      throw new ApiError(
        409,
        "This email cannot be registered. Try signing in.",
      );
    return { user, token };
  }
  async login(value: unknown): Promise<Session> {
    const { email, password } = validateCredentials(value);
    await this.throttle(email);
    const user = await this.db
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .bind(email)
      .first<AuthUser & { password_hash: string }>();
    if (
      !(await verifyPassword(password, user?.password_hash ?? null)) ||
      !user
    ) {
      if (user)
        await this.securityEvent(
          user.id,
          "sign-in-failed",
          "A sign-in attempt used an incorrect password.",
          this.now(),
        ).run();
      throw new ApiError(
        401,
        "Email or password is incorrect.",
        "invalid_credentials",
      );
    }
    return this.createSession(
      { id: user.id, email: user.email },
      user.password_hash,
    );
  }
  async userForSession(token: string | undefined): Promise<AuthUser | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now();
    const results = await this.db.batch<AuthUser>([
      this.db
        .prepare(
          `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND expires_at > ?
        AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
        )
        .bind(now, tokenHash(token), now, now - SESSION_TOUCH_MS),
      this.db
        .prepare(
          `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        )
        .bind(tokenHash(token), now),
    ]);
    const user = results[1].results[0];
    return user ? { id: user.id, email: user.email } : null;
  }
  async logout(token: string | undefined): Promise<void> {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      const now = this.now();
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO security_events (id, owner, kind, message, created_at)
          SELECT ?, user_id, 'signed-out', 'Signed out of RelayForge.', ? FROM sessions
          WHERE token_hash = ? AND expires_at > ?`,
          )
          .bind(randomUUID(), now, tokenHash(token), now),
        this.db
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .bind(tokenHash(token)),
      ]);
    }
  }

  private async sessionForToken(
    token: string | undefined,
  ): Promise<AuthSessionRow> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApiError(401, "Sign in to manage account security.");
    const row = await this.db
      .prepare(
        `SELECT users.id, users.email, users.password_hash,
      users.created_at AS user_created_at, sessions.public_id FROM sessions
      JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .bind(tokenHash(token), this.now())
      .first<AuthSessionRow>();
    if (!row) throw new ApiError(401, "Sign in to manage account security.");
    return row;
  }

  async getSecurity(token: string | undefined): Promise<SecuritySnapshot> {
    const identity = await this.sessionForToken(token);
    const now = this.now();
    type PublicSession = {
      public_id: string;
      created_at: number;
      expires_at: number;
      last_seen_at: number | null;
    };
    type EventRow = {
      id: string;
      kind: SecurityEventKind;
      message: string;
      created_at: number;
    };
    const results = await this.db.batch<
      PublicSession | EventRow | { count: number }
    >([
      this.db
        .prepare(
          `UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND expires_at > ?
        AND (last_seen_at IS NULL OR last_seen_at <= ?)`,
        )
        .bind(now, tokenHash(token!), now, now - SESSION_TOUCH_MS),
      this.db
        .prepare(
          "SELECT public_id, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?",
        )
        .bind(tokenHash(token!), identity.id, now),
      this.db
        .prepare(
          `SELECT public_id, created_at, expires_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ?
        ORDER BY (token_hash = ?) DESC, created_at DESC, public_id DESC LIMIT 50`,
        )
        .bind(identity.id, now, tokenHash(token!)),
      this.db
        .prepare(
          "SELECT count(*) AS count FROM sessions WHERE user_id = ? AND expires_at > ?",
        )
        .bind(identity.id, now),
      this.db
        .prepare(
          "SELECT id, kind, message, created_at FROM security_events WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 20",
        )
        .bind(identity.id),
    ]);
    const current = results[1].results[0] as PublicSession | undefined;
    if (!current)
      throw new ApiError(401, "Sign in to manage account security.");
    return {
      user: {
        id: identity.id,
        email: identity.email,
        createdAt: identity.user_created_at,
      },
      currentSessionId: current.public_id,
      sessions: (results[2].results as PublicSession[]).map((row) => ({
        id: row.public_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        isCurrent: row.public_id === current.public_id,
      })),
      sessionCount: (results[3].results[0] as { count: number }).count,
      events: (results[4].results as EventRow[]).map((row) => ({
        id: row.id,
        kind: row.kind,
        message: row.message,
        createdAt: row.created_at,
      })),
      now,
    };
  }

  private async throttleSecurity(owner: string): Promise<void> {
    const now = this.now();
    const results = await this.db.batch<{ attempts: number }>([
      this.db
        .prepare(
          `INSERT INTO security_rate_limits (owner, window_start, attempts) VALUES (?, ?, 1)
        ON CONFLICT(owner) DO UPDATE SET
        attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
        RETURNING attempts`,
        )
        .bind(owner, now, now - RATE_WINDOW_MS, now - RATE_WINDOW_MS),
    ]);
    if (results[0].results[0].attempts > 5)
      throw new ApiError(
        429,
        "Too many security changes. Try again in 10 minutes.",
      );
  }

  async mutateSecurity(
    token: string | undefined,
    value: SecurityAction,
  ): Promise<SecurityMutationResult> {
    const action = validateSecurityAction(value);
    const identity = await this.sessionForToken(token);
    await this.throttleSecurity(identity.id);
    const tokenDigest = tokenHash(token!);
    const now = this.now();
    const currentExists =
      "EXISTS (SELECT 1 FROM sessions current_session WHERE current_session.token_hash = ? AND current_session.user_id = ? AND current_session.expires_at > ?)";
    const currentValues = [tokenDigest, identity.id, now];
    let revokedSessions = 0;
    let newSession: Session | undefined;

    if (action.type === "change-password") {
      if (
        !(await verifyPassword(action.currentPassword, identity.password_hash))
      )
        throw new ApiError(
          401,
          "Current password is incorrect.",
          "current_password_incorrect",
        );
      const newHash = await hashPassword(action.newPassword);
      const newToken = randomBytes(32).toString("base64url");
      const newDigest = tokenHash(newToken);
      // The hash and the authorizing session are rechecked under the write lock.
      // A concurrently verified old password cannot create a usable new session.
      const commitNow = this.now();
      const results = await this.db.batch<{ id: string }>([
        this.db
          .prepare(
            `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ? AND ${currentExists} RETURNING id`,
          )
          .bind(
            newHash,
            identity.id,
            identity.password_hash,
            tokenDigest,
            identity.id,
            commitNow,
          ),
        this.db
          .prepare(
            `INSERT INTO sessions (token_hash, public_id, user_id, created_at, expires_at, last_seen_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
          )
          .bind(
            newDigest,
            randomUUID(),
            identity.id,
            commitNow,
            commitNow + SESSION_DURATION_MS,
            commitNow,
          ),
        this.db
          .prepare(
            `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?
          AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ?)`,
          )
          .bind(identity.id, newDigest, newDigest, identity.id),
        this.securityEvent(
          identity.id,
          "password-changed",
          "Changed the account password and replaced all previous sessions.",
          commitNow,
          "EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ?)",
          [newDigest, identity.id],
        ),
      ]);
      if (!results[0].results.length)
        throw new ApiError(
          401,
          "Your session changed. Sign in again before changing your password.",
          "session_changed",
        );
      revokedSessions = results[2].meta?.changes ?? 0;
      newSession = {
        user: { id: identity.id, email: identity.email },
        token: newToken,
      };
    } else {
      if (
        action.type === "revoke-session" &&
        action.sessionId === identity.public_id
      )
        throw new ApiError(409, "Use Sign out to close your current session.");
      const oneSession = action.type === "revoke-session";
      const results = await this.db.batch<{ valid: number }>([
        this.db
          .prepare(
            `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ? AND expires_at > ?
          ${oneSession ? "AND public_id = ?" : ""} AND ${currentExists}`,
          )
          .bind(
            identity.id,
            tokenDigest,
            now,
            ...(oneSession ? [action.sessionId] : []),
            ...currentValues,
          ),
        this.securityEvent(
          identity.id,
          oneSession ? "session-revoked" : "other-sessions-revoked",
          oneSession
            ? "Revoked another active session."
            : "Revoked all other active sessions.",
          now,
          oneSession ? "changes() > 0" : currentExists,
          oneSession ? [] : currentValues,
        ),
        this.db
          .prepare(`SELECT ${currentExists} AS valid`)
          .bind(...currentValues),
      ]);
      if (!results[2].results[0].valid)
        throw new ApiError(401, "Sign in to manage account security.");
      revokedSessions = results[0].meta?.changes ?? 0;
      if (oneSession && !revokedSessions)
        throw new ApiError(404, "This active session could not be found.");
    }
    return {
      security: await this.getSecurity(newSession?.token ?? token),
      revokedSessions,
      ...(newSession ? { newSession } : {}),
    };
  }
}
