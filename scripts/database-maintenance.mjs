import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { protectFile } from "./protected-file.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(project, "drizzle");

class MaintenanceError extends Error {}

function sourcePath(filename) {
  try {
    const actual = realpathSync(resolve(filename));
    const stats = statSync(actual);
    if (!stats.isFile()) throw new Error();
    if (stats.nlink > 1)
      throw new MaintenanceError(
        "Hard-linked source databases are unsupported; use the original database with no hard-link aliases.",
      );
    return actual;
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError(
      "An existing regular database file is required.",
    );
  }
}

function inspect(database, directory) {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
    throw new MaintenanceError("Database integrity validation failed.");
  if (database.prepare("PRAGMA foreign_key_check").get())
    throw new MaintenanceError("Database foreign-key validation failed.");

  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = database
    .prepare("SELECT name, checksum FROM relayforge_migrations ORDER BY name")
    .all();
  if (!applied.length || applied.length > names.length)
    throw new MaintenanceError("Database migration history is incompatible.");
  for (const [index, row] of applied.entries()) {
    if (row.name !== names[index])
      throw new MaintenanceError("Database migration history is incompatible.");
    const checksum = createHash("sha256")
      .update(readFileSync(join(directory, names[index]), "utf8"))
      .digest("hex");
    if (row.checksum !== checksum)
      throw new MaintenanceError(
        "An applied migration checksum does not match.",
      );
  }
  // Verify baseline tables as well as the ledger, without reading account data.
  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  for (const table of [
    "workspaces",
    "endpoints",
    "deliveries",
    "attempts",
    "activity",
    "receiver_effects",
  ])
    if (!tables.has(table))
      throw new MaintenanceError("The database is not a RelayForge database.");
  return {
    integrity: "ok",
    foreignKeys: "ok",
    migrations: {
      applied: applied.length,
      pending: names.length - applied.length,
    },
  };
}

/** Inspect a consistent read snapshot; never open the migrating application adapter. */
export function checkDatabase(filename, directory = migrationsDirectory) {
  const actual = sourcePath(filename);
  let database;
  try {
    database = new DatabaseSync(actual, { readOnly: true, timeout: 5000 });
    database.exec("PRAGMA query_only = ON; BEGIN;");
    return { ...inspect(database, directory), bytes: statSync(actual).size };
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError(
      "Database validation failed; no changes were applied.",
    );
  } finally {
    database?.close();
  }
}

function ensureAbsent(filename) {
  try {
    lstatSync(filename);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new MaintenanceError("The backup destination cannot be inspected.");
  }
  throw new MaintenanceError(
    "The backup destination or a sidecar already exists.",
  );
}

function destinationPath(filename, source) {
  let parent;
  try {
    parent = realpathSync(dirname(resolve(filename)));
    if (!statSync(parent).isDirectory()) throw new Error();
  } catch {
    throw new MaintenanceError(
      "The backup destination directory must already exist.",
    );
  }
  const destination = join(parent, basename(resolve(filename)));
  const normalize = (path) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  if (
    [source, `${source}-wal`, `${source}-shm`, `${source}-journal`].some(
      (path) => normalize(path) === normalize(destination),
    )
  )
    throw new MaintenanceError(
      "The source database and its sidecars cannot be a backup destination.",
    );
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    ensureAbsent(`${destination}${suffix}`);
  return destination;
}

/** Publish only a fully verified snapshot, with atomic refusal to overwrite a file. */
export async function backupDatabase(filename, output) {
  const source = sourcePath(filename);
  const destination = destinationPath(output, source);
  checkDatabase(source);
  const parent = dirname(destination);
  const staging = mkdtempSync(join(parent, ".relayforge-backup-"));
  let database;
  try {
    protectFile(staging);
    const snapshot = join(staging, "snapshot.sqlite");
    closeSync(openSync(snapshot, "wx", 0o600));
    protectFile(snapshot);
    database = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
    await backup(database, snapshot);
    database.close();
    database = undefined;
    const report = checkDatabase(snapshot);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(snapshot)) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const handle = openSync(snapshot, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // A hard link is atomic and fails if another process created the final path.
    // Staging in the same directory guarantees the same filesystem.
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      ensureAbsent(`${destination}${suffix}`);
    linkSync(snapshot, destination);
    return { ...report, sha256 };
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    throw new MaintenanceError(
      "Backup failed; an existing destination was not overwritten.",
    );
  } finally {
    database?.close();
    const target = resolve(staging);
    if (
      dirname(target) !== parent ||
      !basename(target).startsWith(".relayforge-backup-")
    )
      throw new MaintenanceError(
        "The temporary backup path failed its cleanup check.",
      );
    rmSync(target, { recursive: true, force: true });
  }
}

function usage() {
  console.log(
    "npm run db:backup -- --output <new.sqlite> [--database <source.sqlite>]\n" +
      "npm run db:check -- [--database <existing.sqlite>]",
  );
}

async function main() {
  try {
    const operation = process.argv[2];
    if (operation !== "backup" && operation !== "check")
      throw new MaintenanceError("Choose the backup or check operation.");
    let values;
    try {
      ({ values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          database: { type: "string" },
          output: { type: "string" },
          help: { type: "boolean" },
        },
        strict: true,
        allowPositionals: false,
      }));
    } catch {
      throw new MaintenanceError("Invalid arguments. Use --help for usage.");
    }
    if (values.help) return usage();
    if (
      (operation === "backup" && !values.output?.trim()) ||
      (operation === "check" && values.output !== undefined) ||
      (values.database !== undefined && !values.database.trim())
    )
      throw new MaintenanceError("Invalid arguments. Use --help for usage.");
    for (const filename of [".env.local", ".env"])
      if (existsSync(filename)) loadEnvFile(filename);
    const source =
      values.database ??
      (process.env.DATABASE_PATH || ".data/relayforge.sqlite");
    const report =
      operation === "backup"
        ? await backupDatabase(source, values.output)
        : checkDatabase(source);
    console.log(JSON.stringify({ status: "ok", operation, ...report }));
  } catch (error) {
    console.error(
      error instanceof MaintenanceError
        ? error.message
        : "Database maintenance failed; no account or configuration details are logged.",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
