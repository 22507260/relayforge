import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql.ts";

class Statement implements SqlStatement {
  private values: SQLInputValue[] = [];
  private database: DatabaseSync;
  private sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: unknown[]): SqlStatement {
    this.values = values as SQLInputValue[];
    return this;
  }
  execute<T>(): SqlResult<T> {
    const results = this.database.prepare(this.sql).all(...this.values) as T[];
    const changes = this.database.prepare("SELECT changes() AS count").get()!;
    return { results, meta: { changes: Number(changes.count) } };
  }
  async all<T>(): Promise<SqlResult<T>> {
    return this.execute<T>();
  }
  async first<T>(): Promise<T | null> {
    return this.execute<T>().results[0] ?? null;
  }
  async run(): Promise<SqlResult> {
    return this.execute<Record<string, unknown>>();
  }
}

/** One SQLite connection per process, with transactional batches and durable WAL. */
export class SqliteDatabase implements SqlDatabase {
  readonly connection: DatabaseSync;
  constructor(
    filename = databasePath(),
    migrationsDirectory = join(process.cwd(), "drizzle"),
  ) {
    if (filename !== ":memory:")
      mkdirSync(dirname(resolve(/* turbopackIgnore: true */ filename)), {
        recursive: true,
      });
    this.connection = new DatabaseSync(filename);
    this.connection.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;",
    );
    try {
      this.migrate(migrationsDirectory);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }
  private migrate(directory: string): void {
    this.connection.exec(
      "CREATE TABLE IF NOT EXISTS relayforge_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      for (const name of readdirSync(directory)
        .filter((file) => file.endsWith(".sql"))
        .sort()) {
        const sql = readFileSync(join(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const previous = this.connection
          .prepare("SELECT checksum FROM relayforge_migrations WHERE name = ?")
          .get(name);
        if (previous) {
          if (previous.checksum !== checksum)
            throw new Error(`Applied migration changed: ${name}`);
          continue;
        }
        this.connection.exec(sql);
        this.connection
          .prepare(
            "INSERT INTO relayforge_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
          )
          .run(name, checksum, Date.now());
      }
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  prepare(sql: string): SqlStatement {
    return new Statement(this.connection, sql);
  }
  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof Statement))
          throw new TypeError("Statements must belong to this SQLite adapter.");
        return statement.execute<T>();
      });
      this.connection.exec("COMMIT");
      return results;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.connection.close();
  }
}

export function databasePath(): string {
  return resolve(
    /* turbopackIgnore: true */
    process.env.DATABASE_PATH || join(".data", "relayforge.sqlite"),
  );
}
const globalDatabase = globalThis as typeof globalThis & {
  relayforgeDatabase?: SqliteDatabase;
};
export function database(): SqliteDatabase {
  return (globalDatabase.relayforgeDatabase ??= new SqliteDatabase());
}
export function migrateDatabase(filename = databasePath()): void {
  const connection = new SqliteDatabase(filename);
  connection.close();
}
