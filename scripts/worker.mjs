import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { SqliteDatabase } from "../lib/server/database.ts";
import { RelayWorker } from "../lib/server/worker.ts";

for (const filename of [".env.local", ".env"]) {
  if (existsSync(filename)) loadEnvFile(filename);
}

const controller = new AbortController();
const shutdown = () => controller.abort();
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

let db;
try {
  db = new SqliteDatabase();
  const worker = new RelayWorker(db, {
    onError: (error) => {
      const name = error instanceof Error ? error.name : "UnknownError";
      // Log an error category without account details, payloads, or signing data.
      console.error(`RelayForge worker cycle failed (${name}); retrying.`);
    },
  });
  console.log(
    "RelayForge worker started. Processing durable queues independently of the browser.",
  );
  await worker.run(controller.signal);
  console.log("RelayForge worker stopped after finishing its current claims.");
} catch (error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  console.error(`RelayForge worker stopped (${name}).`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  db?.close();
}
