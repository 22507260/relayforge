import { SqliteDatabase } from "../lib/server/database.ts";

/** Tests use the production database adapter with an isolated in-memory default. */
export class SqliteTestDatabase extends SqliteDatabase {
  constructor(filename = ":memory:") {
    super(filename);
  }
}
