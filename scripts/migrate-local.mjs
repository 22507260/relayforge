import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { migrateDatabase } from "../lib/server/database.ts";

for (const filename of [".env.local", ".env"]) {
  if (existsSync(filename)) loadEnvFile(filename);
}

migrateDatabase(process.env.DATABASE_PATH);
console.log("SQLite migrations applied.");
