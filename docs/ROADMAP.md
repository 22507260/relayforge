# Roadmap

RelayForge 2.2 adds Operations Center to the live integration workspace: all-age queue classifications, worker freshness, workspace capacity, a local diagnostic download, and minimal public process/readiness probes. Delivery Insights continues to report windowed event and attempt observations. The [validation record](VALIDATION.md) describes the checks performed; this roadmap makes no delivery-date or production-capacity promise.

## Implemented

- Durable SQLite acceptance, payload idempotency, owner isolation, lease-fenced claims and completion, and a standalone worker.
- Worker-only network delivery, four concurrent calls per worker, independent heartbeat updates, and fair bounded workspace scheduling. Browser fallback processes only Lab deliveries.
- Exact HTTPS hostname allowlists, public-address DNS checks on every attempt, pinned connections, TLS verification, a total deadline, bounded headers, and no redirects.
- Per-connection encrypted signing keys, a protected external master key, 24-hour rotation grace, and one-time secret disclosure.
- Endpoint-scoped producer API keys with expiry, revocation, transactional authorization and quotas.
- Recovery triage, bounded bulk replay, preserved delivery cycles, a persistent Recovery Lab, and independent receiver tests for lost acknowledgements and deduplicated effects.
- Connections, Integration Studio, account security, full audit navigation, canonical dashboard URLs, command search, and request diagnostics.
- Delivery Insights with Live/Lab and connection filters, bounded UTC windows, twelve timeline buckets, measured p50/p95 latency, HTTP/network breakdowns, and separate all-age queue observations.
- Operations Center with complete owned queue partitions, scoped connection attention, pause state, shared-worker freshness, owner-wide remaining event capacity, and diagnostic JSON download.
- Minimal public liveness and database/worker readiness probes, plus a dependency-free health-check command for a supervised deployment.

## Current boundaries

- Web and workers share one writable SQLite file. Production supervision, representative load measurements, alerts, and restore drills need deployment-specific evidence.
- HTTPS destinations require an operator-configured exact hostname. Arbitrary URLs, redirects, custom ports, and private destinations are unsupported. The reference transport has one explicit fixed loopback address.
- The application observes HTTP acknowledgement. Receiver-side idempotency is required for business effects; RelayForge makes no exactly-once network guarantee.
- Historical Lab signing secrets remain in the application database. Live connection signing keys use encryption and an external master key; backups must preserve that original key separately.
- Workspaces retain a 500-event capacity. Snapshots return the latest 100 deliveries and 30 activities; history APIs paginate complete records, scoped overviews query independent totals, and Insights aggregates full persisted history within its selected window.
- Insights describes recorded observations. Event cohorts use acceptance time and current status; attempt windows include retries and replays, including attempts on older events. Queue counts do not establish worker readiness or future delivery success.
- Operations explains local queue state without testing receivers or reading signing keys. Health readiness checks database access and a fresh shared worker; it can pass while a connection is disabled or misconfigured, and it requires a worker even when no Live events are queued.
- Legacy attempts keep unknown cycle boundaries. Their original history is preserved without inventing a cycle number.
- Email verification, forgotten-password recovery, a reviewed public-service abuse policy, billing, and an SLA remain outside this release.

## Next: deployment and recovery evidence

Provide supervised web/worker deployment, documented encrypted-key and database backup/restore procedures, and deployment-specific alerts using the implemented public probes and account-owned observations. Run recovery drills for process termination, storage failure, wrong or missing key configuration, and sustained receiver outages. Health endpoints alone do not supply supervision, alert delivery, or restore evidence.

Acceptance requires reproducible procedures and observed outcomes in the actual deployment environment.

## Next: measured performance and storage evaluation

Use the recorded attempt observations as inputs to a reproducible workload, then publish its environment, raw results, queue lag, duplicate contention, and database cost. The Insights dashboard itself is not a benchmark. Evaluate a Postgres adapter only against a concrete workload; preserve tenant isolation, transactional acceptance, lease fencing, and replay history in the same behavioral suite.

## Next: lifecycle policies

Define tested retention and deduplication windows, archival, workspace capacity, receiver key retirement, and account recovery. Keep event, attempt, acknowledgement, and business-effect metrics distinct as those policies evolve.

## Portfolio checklist

- A clean checkout installs, migrates, builds, and starts from the README.
- CI runs lint, type checking, tests, a production dependency audit, a build, and isolated compiled HTTP checks.
- A short demonstration shows acceptance, a recorded failure, repair, and replay of the same event.
- Screenshots, protocol documentation, and architecture match the verified release.
- The project owner can explain and modify the reliability and security boundaries.
