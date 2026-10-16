import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SqlDatabase } from "./sql.ts";

export type SigningKey = { keyId: string; secret: Buffer };
export type SigningStoreOptions = {
  keyFile?: string;
  projectDirectory?: string;
};

/** A missing, unsafe or mismatched encryption configuration never falls back to plaintext. */
export class SigningConfigurationError extends Error {
  constructor() {
    super(
      "Connection signing is unavailable. Check the protected master key configuration.",
    );
    this.name = "SigningConfigurationError";
  }
}

function outsideDirectory(filename: string, directory: string): boolean {
  const path = relative(directory, filename);
  return (
    !!path && (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  );
}

function masterKey(options: SigningStoreOptions): Buffer {
  try {
    const filename = options.keyFile ?? process.env.RELAYFORGE_MASTER_KEY_FILE;
    if (!filename || !isAbsolute(filename))
      throw new SigningConfigurationError();
    const project = realpathSync(
      /* turbopackIgnore: true */ resolve(
        /* turbopackIgnore: true */ options.projectDirectory ?? process.cwd(),
      ),
    );
    const actual = realpathSync(/* turbopackIgnore: true */ filename);
    if (!outsideDirectory(actual, project))
      throw new SigningConfigurationError();
    const stats = statSync(/* turbopackIgnore: true */ actual);
    if (!stats.isFile() || stats.size !== 32)
      throw new SigningConfigurationError();
    // Windows protection is enforced by the file ACL. On POSIX, reject group/world access.
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
      throw new SigningConfigurationError();
    const key = readFileSync(/* turbopackIgnore: true */ actual);
    if (key.byteLength !== 32) throw new SigningConfigurationError();
    return key;
  } catch {
    throw new SigningConfigurationError();
  }
}

function context(owner: string, endpointId: string, keyId: string): Buffer {
  return Buffer.from(JSON.stringify([owner, endpointId, keyId]));
}

export function decodeSigningSecret(secret: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new SigningConfigurationError();
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== secret)
    throw new SigningConfigurationError();
  return bytes;
}

export class SigningKeyStore {
  private options: SigningStoreOptions;
  constructor(options: SigningStoreOptions = {}) {
    this.options = options;
  }
  available(): boolean {
    try {
      masterKey(this.options);
      return true;
    } catch {
      return false;
    }
  }
  create(
    owner: string,
    endpointId: string,
    keyId: string,
  ): { secret: string; encryptedSecret: string } {
    const secret = randomBytes(32).toString("base64url");
    return {
      secret,
      encryptedSecret: this.encrypt(owner, endpointId, keyId, secret),
    };
  }
  encrypt(
    owner: string,
    endpointId: string,
    keyId: string,
    secret: string,
  ): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      masterKey(this.options),
      nonce,
    );
    cipher.setAAD(context(owner, endpointId, keyId));
    const ciphertext = Buffer.concat([
      cipher.update(decodeSigningSecret(secret)),
      cipher.final(),
    ]);
    return [
      "v1",
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(":");
  }
  decrypt(
    owner: string,
    endpointId: string,
    keyId: string,
    encryptedSecret: string,
  ): Buffer {
    try {
      const parts = encryptedSecret.split(":");
      if (
        parts.length !== 4 ||
        parts[0] !== "v1" ||
        parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      )
        throw new SigningConfigurationError();
      const nonce = Buffer.from(parts[1], "base64url");
      const ciphertext = Buffer.from(parts[2], "base64url");
      const tag = Buffer.from(parts[3], "base64url");
      if (nonce.length !== 12 || ciphertext.length !== 32 || tag.length !== 16)
        throw new SigningConfigurationError();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        masterKey(this.options),
        nonce,
      );
      decipher.setAAD(context(owner, endpointId, keyId));
      decipher.setAuthTag(tag);
      const result = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      if (result.length !== 32) throw new SigningConfigurationError();
      return result;
    } catch {
      throw new SigningConfigurationError();
    }
  }
}

export function signConnectionBody(
  keys: SigningKey[],
  timestamp: number,
  body: string,
): { keyId: string; signature: string }[] {
  return keys.map(({ keyId, secret }) => ({
    keyId,
    signature: createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex"),
  }));
}

export async function loadConnectionSigningKeys(
  db: SqlDatabase,
  owner: string,
  endpointId: string,
  now: number,
  options: SigningStoreOptions = {},
): Promise<SigningKey[]> {
  const result = await db
    .prepare(
      `SELECT k.key_id, k.encrypted_secret, e.signing_key_id AS current_key_id
    FROM connection_signing_keys k JOIN endpoints e ON e.id = k.endpoint_id AND e.owner = k.owner
    WHERE k.owner = ? AND k.endpoint_id = ? AND e.transport IN ('https', 'reference')
      AND (k.key_id = e.signing_key_id OR k.expires_at > ?)
    ORDER BY CASE WHEN k.key_id = e.signing_key_id THEN 0 ELSE 1 END, k.created_at DESC`,
    )
    .bind(owner, endpointId, now)
    .all<{
      key_id: string;
      encrypted_secret: string;
      current_key_id: string | null;
    }>();
  if (result.results.length < 1 || result.results.length > 2)
    throw new SigningConfigurationError();
  if (
    result.results.filter((row) => row.key_id === row.current_key_id).length !==
    1
  )
    throw new SigningConfigurationError();
  const store = new SigningKeyStore(options);
  return result.results.map((row) => ({
    keyId: row.key_id,
    secret: store.decrypt(owner, endpointId, row.key_id, row.encrypted_secret),
  }));
}
