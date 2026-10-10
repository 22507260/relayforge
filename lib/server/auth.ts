import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { ApiError } from "./domain.ts";
import { readBody } from "./http.ts";
import type { SqlDatabase } from "./sql.ts";

export const SESSION_COOKIE = "relayforge_session";
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
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
  private async createSession(user: AuthUser): Promise<Session> {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    await this.db.batch([
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
      this.db
        .prepare(
          "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(tokenHash(token), user.id, now, now + SESSION_DURATION_MS),
    ]);
    return { user, token };
  }
  async register(value: unknown): Promise<Session> {
    const { email, password } = validateCredentials(value);
    await this.throttle(email);
    const passwordHash = await hashPassword(password);
    const user = { id: randomUUID(), email };
    const inserted = await this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id",
      )
      .bind(user.id, email, passwordHash, this.now())
      .first();
    if (!inserted)
      throw new ApiError(
        409,
        "This email cannot be registered. Try signing in.",
      );
    return this.createSession(user);
  }
  async login(value: unknown): Promise<Session> {
    const { email, password } = validateCredentials(value);
    await this.throttle(email);
    const user = await this.db
      .prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
      .bind(email)
      .first<AuthUser & { password_hash: string }>();
    if (!(await verifyPassword(password, user?.password_hash ?? null)) || !user)
      throw new ApiError(401, "Email or password is incorrect.");
    return this.createSession({ id: user.id, email: user.email });
  }
  async userForSession(token: string | undefined): Promise<AuthUser | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const user = await this.db
      .prepare(
        `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      )
      .bind(tokenHash(token), this.now())
      .first<AuthUser>();
    return user ? { id: user.id, email: user.email } : null;
  }
  async logout(token: string | undefined): Promise<void> {
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token))
      await this.db
        .prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(tokenHash(token))
        .run();
  }
}
