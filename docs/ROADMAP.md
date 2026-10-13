# Roadmap

The current version is a working portfolio MVP: a persistent queue, a standalone worker, a dashboard with request fallback, and controlled receivers. The first milestone describes the worker addition and its verification boundary. Later milestones are proposed work, not completed features or delivery dates.

## Current limitations

- Autonomous progress depends on a running worker with access to the same SQLite file as the web application. Without a recent worker heartbeat, the dashboard falls back to pump requests. A heartbeat is an observation of liveness, not a delivery or availability guarantee.
- The processor invokes a controlled receiver in-process. It does not deliver to external systems or reproduce network acknowledgement loss.
- Only built-in receiver destinations are supported.
- The application manages accounts and sessions. Email verification, password recovery, and public-deployment abuse controls remain future work.
- Signing secrets are stored in the demo database; encryption and rotation are not implemented.
- Unit tests alone cannot establish production database race behavior or crash recovery.
- Workspaces accept up to 500 events; overview snapshots expose the latest 100 deliveries and 30 activities. Separate delivery-history and unified audit APIs support full-history pagination and server-side filtering. Retention policies and larger workspace capacity remain future work.
- Attempts recorded before cycle tracking remain in Legacy history; their original cycle boundaries cannot be reconstructed reliably.
- There is no published load benchmark, SLA, billing system, or production incident record.
- No exactly-once network delivery guarantee is made.

The current account controls include active-session inspection, other-session revocation, verified password changes, and a unified security/delivery audit explorer. Dashboard views, filters, pagination, and event drawers have canonical URLs. These implemented controls do not provide email verification, forgotten-password recovery, or a reviewed public-service abuse policy.

## 1. Autonomous processing — implementation and verification

A standalone Node.js worker separates queue progress from the dashboard. It uses the same native SQLite adapter and lease-fenced processor as the API, writes a persisted heartbeat, and waits for an ongoing pump on graceful shutdown. The UI can distinguish recent worker observations from request-driven fallback. The worker still invokes controlled receivers in-process.

**Verification status — 2026-10-11:** implemented and checked. The full suite passed 29 tests, including six worker runtime checks covering processing without HTTP/browser pumps, pause, heartbeat expiry, competing processes, actual process termination and 15-second lease recovery, graceful abort, final-budget recovery, and idempotent shutdown before database closure. The compiled dashboard showed browser fallback while the worker was offline and worker mode after restart. See the [validation record](VALIDATION.md) for the exact evidence and limits.

The runtime checks use native SQLite and actual child processes for autonomous execution, competing claims, and forced termination. Graceful lifecycle checks use the loop's abort signal. This demonstrates the local worker boundary; deployment supervision, platform-wide signal behavior, and production operational properties need separate evidence.

Further work includes supervised deployment, alerts, recovery drills, and measured behavior under representative load. Starting a local worker does not establish those operational properties.

## 2. Database adapter and Postgres evaluation

Extract the persistence contract and implement a Postgres adapter. Preserve tenant scoping, atomic claims, unique idempotency constraints, and attempt history. Evaluate whether the deployment workload benefits from the change.

**Acceptance criteria:** run the same behavioral suite against SQLite and Postgres; document transaction and lease semantics; verify concurrent claims and duplicate inserts; provide versioned migrations and reproducible local setup.

Both implementations must preserve behavior for the adapter boundary to be useful.

## 3. External destinations and secret lifecycle

Design destination registration, constrained egress, encrypted signing secrets, rotation, and revocation. Review SSRF before accepting arbitrary URLs: redirects, private addresses, DNS changes, and outbound policy all affect the boundary. Replace the controlled adapter with bounded real HTTP calls and test ambiguous outcomes.

**Acceptance criteria:** an explicit security model; disallowed destination and redirect tests; bounded request/response sizes; real timeouts; no secret leakage; a documented signature contract; a receiver test that commits an effect but withholds acknowledgement.

## 4. Operational policies

Recovery now provides dead-letter triage, bounded bulk replay with cycle guards, an explicit replay history, and a persistent recovery demonstration. Remaining work includes a retry taxonomy, terminal failure handling, retention, and richer audit navigation. Preserve the current rejection of an idempotency key reused with different payload or type, and define how long deduplication records remain.

**Acceptance criteria:** operator actions are audited; replay history is unambiguous; retention is tested; metrics distinguish events, attempts, acknowledgements, and effects; terminal failures do not consume unnecessary retries.

## 5. Measured performance and deployment evidence

Create a representative workload. Measure queue lag, attempt duration percentiles, duplicate contention, database cost, and recovery under failure. Publish environment, procedure, and raw results before claiming capacity.

**Acceptance criteria:** a reproducible benchmark and baseline; bounded changes evaluated against it; deployed health checks and alerts; a documented restore procedure; reviewed authentication, authorization, secrets, and dependency updates.

## Portfolio completion checklist

- A clean checkout installs, migrates, builds, and starts from the README.
- CI runs type checking, tests, and build without editing migrations.
- A short demo shows a failure, its recorded cause, and recovery.
- Architecture documents match the implementation.
- Deployment links and screenshots correspond to a verified version.
- The project owner can explain and modify the reliability path without depending on a prepared script.
