import { join } from "node:path";
import {
  createVerificationRuntime,
  VerificationError,
} from "./verification-runtime.mjs";

if (process.argv.length !== 2) {
  console.error("Use npm run verify:http without custom arguments.");
  process.exitCode = 1;
} else {
  let fixture;
  try {
    fixture = await createVerificationRuntime();
    const reference = await fixture.startReference();
    const { runtime: web, url } = await fixture.startWeb();
    const worker = fixture.startWorker();
    for (const script of [
      "smoke",
      "security-smoke",
      "request-smoke",
      "integration-smoke",
      "insights-smoke",
      "operations-smoke",
      "health-check",
    ]) {
      fixture.stage(script);
      fixture.assertRunning(web, worker, reference);
      await fixture.run(script, [`scripts/${script}.mjs`, url]);
    }
    const backupFile = join(fixture.directory, "verified-backup.sqlite");
    fixture.stage("online database backup and check");
    await fixture.run("database-backup", [
      "scripts/database-maintenance.mjs",
      "backup",
      "--database",
      fixture.environment.DATABASE_PATH,
      "--output",
      backupFile,
    ]);
    await fixture.run("database-check", [
      "scripts/database-maintenance.mjs",
      "check",
      "--database",
      backupFile,
    ]);
    fixture.assertRunning(web, worker, reference);
    console.log(
      "All compiled HTTP and online backup checks passed using an isolated temporary database.",
    );
  } catch (error) {
    console.error(
      `HTTP verification failed during ${fixture?.phase ?? "preparation"}. Child output is withheld to avoid exposing fixture credentials.`,
    );
    if (error instanceof VerificationError) console.error(error.message);
    process.exitCode = 1;
  } finally {
    try {
      await fixture?.cleanup();
    } catch {
      console.error(
        "HTTP verification cleanup failed; owned fixture files were preserved for local review.",
      );
      process.exitCode = 1;
    }
  }
}
