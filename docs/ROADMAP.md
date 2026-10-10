# Roadmap

The current version is a working portfolio MVP: a persistent request-driven queue, a dashboard, and controlled receivers. These milestones are proposed work, not completed features or delivery dates.

## Current limitations

- Queue progress depends on pump requests. Persistent state does not provide autonomous processing.
- The processor invokes a controlled receiver in-process. It does not deliver to external systems or reproduce network acknowledgement loss.
- Only built-in receiver destinations are supported.
- The application manages accounts and sessions. Email verification, password recovery, and public-deployment abuse controls remain future work.
- Signing secrets are stored in the demo database; encryption and rotation are not implemented.
- Unit tests alone cannot establish production database race behavior or crash recovery.
- Workspaces accept up to 500 events; snapshots expose the latest 100 deliveries and 30 activities. Delivery history supports pagination and server-side filtering, but retention policies and larger workspace capacity remain future work.
- Replay history has no explicit cycle identifier; attempt numbers restart for each replay.
- There is no published load benchmark, SLA, billing system, or production incident record.
- No exactly-once network delivery guarantee is made.

## 1. Autonomous processing

Separate processing from the dashboard with a scheduled job, durable queue consumer, or standalone daemon suited to the deployment environment. Keep the API and UI useful when no browser is open.

**Acceptance criteria:** enqueue work and close every browser; verify delivery continues. Terminate a processor after claim and verify recovery after lease expiry. Race processors against the same event and confirm database claim protection. Capture these experiments in repeatable integration tests.

Resolve scheduling before adding infrastructure solely for appearance.

## 2. Database adapter and Postgres evaluation

Extract the persistence contract and implement a Postgres adapter. Preserve tenant scoping, atomic claims, unique idempotency constraints, and attempt history. Evaluate whether the deployment workload benefits from the change.

**Acceptance criteria:** run the same behavioral suite against SQLite and Postgres; document transaction and lease semantics; verify concurrent claims and duplicate inserts; provide versioned migrations and reproducible local setup.

Both implementations must preserve behavior for the adapter boundary to be useful.

## 3. External destinations and secret lifecycle

Design destination registration, constrained egress, encrypted signing secrets, rotation, and revocation. Review SSRF before accepting arbitrary URLs: redirects, private addresses, DNS changes, and outbound policy all affect the boundary. Replace the controlled adapter with bounded real HTTP calls and test ambiguous outcomes.

**Acceptance criteria:** an explicit security model; disallowed destination and redirect tests; bounded request/response sizes; real timeouts; no secret leakage; a documented signature contract; a receiver test that commits an effect but withholds acknowledgement.

## 4. Operational policies

Add a retry taxonomy, terminal failure handling, dead-letter triage, replay-cycle identity, retention, and richer history navigation. Preserve the current rejection of an idempotency key reused with different payload or type, and define how long deduplication records remain.

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
