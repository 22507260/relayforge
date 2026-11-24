import {
  createVerificationRuntime,
  VerificationError,
} from "./verification-runtime.mjs";
import { runRecoveryScenario } from "./recovery-scenario.mjs";

if (process.argv.length !== 2) {
  if (process.argv.length === 3 && process.argv[2] === "--help")
    console.log(
      "Run npm run build, then npm run verify:recovery. Uses only owned temporary fixtures and fixed loopback port 4100; no custom targets are accepted.",
    );
  else {
    console.error(
      "Use npm run verify:recovery without custom targets or paths.",
    );
    process.exitCode = 1;
  }
} else {
  let fixture;
  let report;
  try {
    fixture = await createVerificationRuntime({
      prefix: "relayforge-recovery-",
    });
    fixture.stage("independent reference receiver startup");
    const reference = await fixture.startReference();
    report = await runRecoveryScenario(fixture);
    fixture.assertRunning(reference);
  } catch (error) {
    console.error(
      `Recovery verification failed during ${fixture?.phase ?? "preparation"}. Child output is withheld to avoid exposing fixture credentials.`,
    );
    if (error instanceof VerificationError) console.error(error.message);
    process.exitCode = 1;
  } finally {
    try {
      await fixture?.cleanup();
    } catch {
      console.error(
        "Recovery verification cleanup failed; owned fixture files were preserved for local review.",
      );
      process.exitCode = 1;
    }
  }
  if (!process.exitCode && report)
    console.log(
      JSON.stringify({
        ...report,
        status: "ok",
        operation: "recovery-rehearsal",
      }),
    );
}
