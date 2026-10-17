# RelayForge 2.1

**A webhook delivery workspace: connect, send, inspect, recover.**

RelayForge delivers signed events to allowed HTTPS services or an independent local reference receiver. A durable SQLite queue, background worker, capped retries, and preserved replay history make every delivery inspectable. Integration Studio brings the event composer and its actual attempt timeline into one screen.

The **Live** overview reports real integrations. The separate **Lab** view keeps controlled failure scenarios out of those metrics. HTTP success is shown as **Acknowledged**: it confirms the receiver's response, without claiming that an external application's business effect was applied exactly once.

**Delivery Insights** adds full-history observations for the last hour, 24 hours, or seven days: event outcomes, attempt timelines, measured p50/p95 latency, HTTP and network failure breakdowns, and the current queue. Filters keep Live, Lab, and individual connections separate.

[Insights guide](docs/INSIGHTS.md) · [Integration setup](docs/INTEGRATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [Security](docs/SECURITY.md) · [Interview guide](docs/INTERVIEW-GUIDE.md)

![RelayForge Delivery Insights](docs/insights-preview.jpg)

[Mobile Insights](docs/insights-mobile-preview.jpg) · [Live overview](docs/live-preview.jpg) · [Connections](docs/connections-preview.jpg) · [Integration Studio](docs/studio-preview.jpg) · [Recovery](docs/recovery-preview.jpg) · [Security](docs/security-preview.jpg) · [Audit explorer](docs/audit-preview.jpg) · [Command palette](docs/command-preview.jpg)

## What you can do

- Create an allowed HTTPS connection or the fixed local reference connection, with its own signing secret.
- Compose JSON in **Integration Studio**, use an idempotency key, and follow the event from acceptance through each recorded attempt.
- Create a producer API key scoped to one connection. Tokens are revealed once, expire within 90 days, and can be revoked.
- Inspect HTTP responses, network failure categories, measured durations, signing key IDs, connection revisions, and retry schedules.
- Explore **Delivery Insights** across complete stored history. Compare event outcomes with repeated attempts, examine measured latency and failure categories, and open a connection's delivery history.
- Recover dead deliveries individually or replay up to 20 reviewed selections. Replay retains the event ID, payload, idempotency key, and earlier cycles.
- Practice the persistent **Recovery Lab**: four failed attempts, repair, replay, then a successful delivery with one verified lab effect.
- Search complete delivery and audit history, inspect sessions, and manage account security. **Ctrl/Cmd + K** opens the command palette.

## Run locally

Use **Node.js 24** and npm:

```sh
npm ci
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`, create an account, and sign in. Registration creates a session immediately. Passwords require 12–128 characters; every account has an isolated workspace. Existing users and histories survive the additive migrations.

Start the worker in a second terminal from the same project directory:

```sh
npm run worker
```

The web process and worker must share `DATABASE_PATH`, which defaults to `.data/relayforge.sqlite`. Live network delivery runs **only in the worker**. Without a worker, live events remain queued; the visible dashboard can continue processing lab events. Pause blocks new claims across both paths. A heartbeat older than ten seconds is stale; the indicator is a liveness observation, not a delivery guarantee.

Stop processes with Ctrl+C. The worker finishes its current work before closing the database. A forced termination can leave an interrupted lease, which a later worker recovers.

## Enable a real integration

For a self-contained local demonstration:

```sh
npm run setup:live -- --enable-reference
```

This prepares a protected 32-byte encryption key outside the checkout, an independent receiver configuration file and database path, and local environment settings. It does not print secrets. Restart the web application and worker after configuration changes.

Open **Connections**, create a **Reference receiver** connection, and save its one-time signing secret in the receiver's protected configuration. Then run:

```sh
npm run reference:receiver
```

The receiver listens at `http://127.0.0.1:4100/webhooks`, verifies signatures, and deduplicates effects in its own SQLite database. Its `lose-first-ack` mode commits an effect and drops the first response, demonstrating why another network attempt can still produce one receiver-side effect.

For HTTPS, configure exact permitted hostnames in `RELAYFORGE_ALLOWED_HOSTS`. The worker permits HTTPS on port 443, resolves and validates all returned A/AAAA addresses before every attempt, and connects to a pinned public address with hostname and TLS verification intact. Redirects and arbitrary private addresses are not supported. The reference transport is an explicit fixed local exception, not a user-controlled URL bypass.

See [Integration setup](docs/INTEGRATIONS.md) for the receiver configuration, producer API, signature format, rotation, and failure policy. No external service account is required for the reference demonstration.

## Producer API

Create a key under **Security → Producer API keys** for an enabled live connection. Replace the placeholder with your stored token:

```sh
curl -X POST 'http://localhost:3000/api/v1/events' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: invoice-1042-paid' \
  --data '{"eventType":"invoice.paid","payload":{"invoiceId":"inv_1042","amount":14900}}'
```

The response is `202 {"eventId":"…","duplicate":false}`. Repeating the same connection, idempotency key, event type, and payload returns the original event with `duplicate:true`; conflicting content returns `409`. Acceptance persists the event before delivery. A producer key cannot select another connection or account.

## Engineering decisions

| Concern            | Implemented approach                                                           | Boundary                                                                                       |
| ------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Durable acceptance | Immutable event data and transactional idempotency in SQLite                   | Acknowledgement is separate from acceptance                                                    |
| Competing workers  | Atomic 15-second leases and token-fenced completion                            | Lease expiry can lead to another network attempt                                               |
| Real delivery      | Worker-only HTTPS with public address pinning; fixed local reference transport | Exact operator allowlist; no redirects or arbitrary URLs                                       |
| Retry policy       | Four attempts per cycle, exponential backoff with ±20% jitter                  | Live retries network failures, 408, 429, and 5xx; other unsuccessful HTTP results are terminal |
| Secret lifecycle   | AES-256-GCM connection keys and a protected external master key                | Losing the master key prevents decrypting existing live signing keys                           |
| Rotation           | New and previous signatures during a 24-hour grace period                      | Another rotation waits until the previous grace period ends                                    |
| Producer authority | Hashed one-time tokens scoped to one enabled connection                        | 10 active keys; 60 requests/key/minute and 240/workspace/minute                                |
| Receiver effects   | Lab and independent reference receiver deduplicate effects                     | External receivers must implement their own transactional deduplication                        |
| Recovery           | Preserved event identity, separate cycles, transactional bulk replay           | An operator must fix the receiver; replay does not guarantee recovery                          |
| Inspection         | Full account-owned history APIs and canonical view/filter/event URLs           | A shared link does not grant access                                                            |
| Delivery Insights  | Windowed SQL aggregates, measured latency percentiles, and current queue state | Recorded observations; no benchmark, delivery deadline, or remote-effect guarantee             |

Old attempts remain under **Legacy history** when no cycle was recorded. A stale bulk selection cannot reset a newer cycle. Eligible records are queued and skipped records are reported separately; a system write failure rolls back the operation.

## Verify the work

```sh
npm run lint
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm run build
npm run verify:http
```

CI performs these checks after a clean install. `verify:http` starts the compiled web application, worker, and independent reference receiver with temporary databases, a temporary master key, and temporary receiver configuration. It runs delivery/recovery, account security, request-error, live-integration, and Insights smoke checks, then stops its own processes and removes its checked temporary directory. **Stop any local reference receiver using port 4100 before running it.** The runner does not use your application's database or secrets.

The direct `smoke`, `security:smoke`, and `request:smoke` scripts can inspect a loopback server using synthetic accounts and leave their records in that database. Integration and Insights smoke checks require the guarded isolated runner. Consult [Validation](docs/VALIDATION.md) for actual dated results, screenshots, and dependency audit findings.

## Runtime and limits

Build and start the web application with `npm run build` and `npm start`, then supervise `npm run worker` separately. Both processes need the same database and live configuration. Deploy behind HTTPS with writable persistent disk storage. Back up the database before migration, and protect the master key separately; a database backup alone cannot restore live signing capability.

This version is a bounded portfolio application: one SQLite database, 500 accepted events per workspace, four live calls at a time per worker, a five-second total network deadline, 8 KiB response headers, and discarded response bodies. The generic snapshot includes the latest 100 deliveries; scoped overviews and Insights query the database independently, and the delivery API pages through complete history.

No production availability, traffic scale, or benchmark is claimed. Recorded live durations measure an attempted request through response headers or failure; they are not proof of remote application processing time. Email verification, forgotten-password recovery, distributed abuse controls, automated retention, and high availability remain future work.

## Code map

| Path                                        | Responsibility                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `app/components/`                           | Overview, Insights, Connections, Studio, Recovery, Security, audit, and command UI |
| `app/api/`                                  | Session management routes and the separate bearer producer API                     |
| `lib/contracts.ts`                          | Shared request and observation types                                               |
| `lib/navigation.ts`, `lib/commands.ts`      | Canonical URLs and bounded command destinations                                    |
| `lib/client-api.ts`                         | Readable error decoding, request IDs, and retry metadata                           |
| `lib/server/service.ts`                     | Acceptance, leases, cycles, lab receivers, and scoped snapshots                    |
| `lib/server/insights.ts`                    | Owned event cohorts, attempt outcomes, latency percentiles, and queue aggregates   |
| `lib/server/integrations.ts`                | Connections, producer keys, quotas, and transactional producer enqueue             |
| `lib/server/signing.ts`                     | Protected master-key loading and authenticated connection-key encryption           |
| `lib/server/transport.ts`                   | Allowed destinations, address validation, pinned HTTP transport, deadlines         |
| `lib/server/worker.ts`                      | Bounded processing lanes, independent heartbeat, and shutdown                      |
| `lib/reference/receiver.ts`                 | Independent signature verification, deduplication, and ambiguous acknowledgement   |
| `lib/server/auth.ts`, `lib/server/audit.ts` | Account sessions, security controls, and complete audit history                    |
| `db/`, `drizzle/`                           | Visible schema and checksum-tracked additive migrations                            |
| `tests/`, `scripts/verify-http.mjs`         | Policy, database races, transport, receiver, and compiled route verification       |

The project uses TypeScript, React 19, Motion, Tailwind CSS, Next.js, Node.js 24, SQLite, Drizzle, and `ipaddr.js` for address classification. Runtime schemas, transactions, and ownership checks enforce boundaries beyond TypeScript's compile-time types.
