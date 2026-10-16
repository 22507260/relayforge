# Roadmap

RelayForge 2.0 implements live integrations: constrained HTTPS and an independent reference receiver, encrypted connection signing keys with rotation, scoped producer credentials, Integration Studio, and separate Live/Lab metrics. The [validation record](VALIDATION.md) describes the checks performed; this roadmap makes no delivery-date or production-capacity promise.

## Implemented

- Durable SQLite acceptance, payload idempotency, owner isolation, lease-fenced claims and completion, and a standalone worker.
- Worker-only network delivery, four concurrent calls per worker, independent heartbeat updates, and fair bounded workspace scheduling. Browser fallback processes only Lab deliveries.
- Exact HTTPS hostname allowlists, public-address DNS checks on every attempt, pinned connections, TLS verification, a total deadline, bounded headers, and no redirects.
- Per-connection encrypted signing keys, a protected external master key, 24-hour rotation grace, and one-time secret disclosure.
- Endpoint-scoped producer API keys with expiry, revocation, transactional authorization and quotas.
- Recovery triage, bounded bulk replay, preserved delivery cycles, a persistent Recovery Lab, and independent receiver tests for lost acknowledgements and deduplicated effects.
- Connections, Integration Studio, account security, full audit navigation, canonical dashboard URLs, command search, and request diagnostics.

## Current boundaries

- Web and workers share one writable SQLite file. Production supervision, representative load measurements, alerts, and restore drills need deployment-specific evidence.
- HTTPS destinations require an operator-configured exact hostname. Arbitrary URLs, redirects, custom ports, and private destinations are unsupported. The reference transport has one explicit fixed loopback address.
- The application observes HTTP acknowledgement. Receiver-side idempotency is required for business effects; RelayForge makes no exactly-once network guarantee.
- Historical Lab signing secrets remain in the application database. Live connection signing keys use encryption and an external master key; backups must preserve that original key separately.
- Workspaces retain a 500-event capacity. Snapshots return the latest 100 deliveries and 30 activities; history APIs paginate complete records and scoped overviews query independent totals and recent events.
- Legacy attempts keep unknown cycle boundaries. Their original history is preserved without inventing a cycle number.
- Email verification, forgotten-password recovery, a reviewed public-service abuse policy, billing, and an SLA remain outside this release.

## Next: deployment and recovery evidence

Provide supervised web/worker deployment, documented encrypted-key and database backup/restore procedures, health checks, and alerting. Run recovery drills for process termination, storage failure, wrong or missing key configuration, and sustained receiver outages.

Acceptance requires reproducible procedures and observed outcomes in the actual deployment environment.

## Next: measured performance and storage evaluation

Publish a representative workload, environment, raw results, queue lag, attempt percentiles, duplicate contention, and database cost. Evaluate a Postgres adapter only against a concrete workload; preserve tenant isolation, transactional acceptance, lease fencing, and replay history in the same behavioral suite.

## Next: lifecycle policies

Define tested retention and deduplication windows, archival, workspace capacity, receiver key retirement, and account recovery. Keep event, attempt, acknowledgement, and business-effect metrics distinct as those policies evolve.

## Portfolio checklist

- A clean checkout installs, migrates, builds, and starts from the README.
- CI runs lint, type checking, tests, a production dependency audit, a build, and isolated compiled HTTP checks.
- A short demonstration shows acceptance, a recorded failure, repair, and replay of the same event.
- Screenshots, protocol documentation, and architecture match the verified release.
- The project owner can explain and modify the reliability and security boundaries.
