# RelayForge

**A webhook reliability lab that makes failure, retries, and recovery visible.**

Send an event, make a receiver fail, inspect every attempt, and replay a delivery after recovery. RelayForge combines an animated operations dashboard with a persistent queue, idempotency, signed payloads, and explicit failure states.

The Recovery workspace brings failed deliveries into one view. Select up to 20 records for a reviewed bulk replay, inspect separate replay cycles, or follow a persistent Recovery Lab scenario from four failed attempts to a successful recovery.

The Security workspace shows active sessions, lets you revoke other sessions, and changes your password after checking the current one. Activity searches the complete account-owned delivery and security audit history. Navigation, filters, pagination, and event drawers have shareable URLs that survive reloads and browser history navigation.

Press **Ctrl/Cmd + K**, or use the toolbar's command button, to find a screen, receiver, or event. Type at least two characters to search the complete delivery history, then use arrow keys and Enter to open a result. Escape closes the palette and returns focus. Searches stay scoped to your account.

This is a working portfolio MVP. Its receivers are controlled demonstrations. A standalone worker advances the persistent queue without a browser; dashboard requests provide a fallback when no recent worker heartbeat is observed. It makes reliability behavior inspectable without claiming to be a production delivery service.

[Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [Interview guide](docs/INTERVIEW-GUIDE.md) · [Security](docs/SECURITY.md) · [Roadmap](docs/ROADMAP.md)

![RelayForge dashboard with persisted events, attempt metrics, and controlled receivers](docs/preview.jpg)

[Account screen](docs/login-preview.jpg) · [Mobile dashboard](docs/mobile-preview.jpg) · [Worker and engineering view](docs/worker-preview.jpg) · [Recovery workspace](docs/recovery-preview.jpg) · [Mobile recovery](docs/recovery-mobile-preview.jpg) · [Security workspace](docs/security-preview.jpg) · [Audit explorer](docs/audit-preview.jpg) · [Mobile security](docs/security-mobile-preview.jpg) · [Command palette](docs/command-preview.jpg) · [Mobile commands](docs/command-mobile-preview.jpg)

## Try the failure path

For a guided demonstration, open **Recovery** and start the **Recovery Lab**. Its dedicated receiver fails until the event reaches dead state. Repair it, replay the same event, and inspect the initial delivery and replay histories alongside its single receiver effect. Progress survives reloads and sign-in. The guide uses real queue processing; run the worker or keep the visible dashboard open for request fallback.

The guide owns its receiver settings and replay controls. It does not change existing receivers. After completion, run it again to create a new event while preserving the earlier history.

1. Open the dashboard and run the demo scenario.
2. Switch a receiver between healthy, flaky, failing, and timeout behavior.
3. Inspect a delivery's payload and attempt history as retries progress.
4. Restore a failing receiver, then replay its dead delivery.
5. Compare accepted events, duplicate submissions, and receiver business effects.

The project gives you concrete questions to investigate: what happens when two processors compete, an attempt is interrupted, or the same event arrives again?

## Engineering decisions

| Concern               | Implemented approach                                                                                        | Boundary                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Durable state         | SQLite stores deliveries and attempts; a standalone worker processes due work                               | Autonomous progress requires a running worker with access to the database      |
| Duplicate submissions | A unique key scoped to tenant and endpoint identifies an accepted event                                     | A reused key with a different payload or event type returns `409`              |
| Competing processors  | Atomic lease claims and token-checked completion                                                            | An expired lease can lead to another attempt                                   |
| Recovery              | Four automatic attempts, backoff with jitter, dead state, and manual replay                                 | Receiver recovery is not guaranteed                                            |
| Receiver effects      | A unique event constraint deduplicates demo effects                                                         | Real receivers need their own transactional idempotency                        |
| Payload authenticity  | HMAC-SHA256 with a timestamp and five-minute validity window                                                | The processor uses an in-process receiver, not an external HTTP call           |
| Tenant isolation      | Application-owned accounts and server-side sessions scope data and dashboard actions                        | Authentication and recovery policies need review before a public deployment    |
| Account security      | Public session identifiers, revocation, current-password verification, and atomic password/session rotation | Email verification and forgotten-password recovery remain future work          |
| Inspection            | Account-scoped audit pagination and URL-backed filters and event drawers                                    | Links carry identifiers and filter state; access still requires authentication |
| Destination safety    | Only built-in receiver destinations are accepted                                                            | Arbitrary external webhook URLs are unsupported                                |

Replay retains the event ID, payload, and idempotency key. It resets the current attempt budget while preserving attempt history. Neither idempotency nor leasing provides exactly-once network delivery.

Each tracked replay increments the delivery cycle. Attempts recorded before cycle tracking was introduced remain under **Legacy history**; their cycle boundaries are not inferred. Bulk replay includes the selected cycle as a concurrency guard, skips records that are no longer eligible, and commits each replay's state and audit together in one transaction. A database failure rolls back the whole batch.

## Stack

- **TypeScript** across browser, API contracts, and server logic.
- **React 19, Motion, and Tailwind CSS** for the interactive dashboard.
- **Next.js and Node.js 24** for the application runtime.
- **SQLite and Drizzle** for persistent state and migrations.
- **Node's test runner** for focused reliability checks.

One language keeps the frontend and backend approachable. Runtime validation, database constraints, and server-owned authorization still matter: TypeScript alone does not validate network requests or enforce access control.

## Run locally

Use **Node.js 24** and npm:

```sh
npm ci
npm run db:migrate
npm run dev
```

Open `http://localhost:3000`, create an account, and sign in. Registration signs you in immediately. Passwords must contain 12–128 characters. The application owns its email/password authentication and session handling. Each account has an isolated workspace.

Start autonomous processing in a second terminal from the same project directory:

```sh
npm run worker
```

The worker uses Node.js 24 and the same `DATABASE_PATH` as the web application. With the worker running, scheduled retries can progress after every browser is closed. Without it, the dashboard pumps due work while open. Pause still prevents new claims. The dashboard uses a persisted heartbeat to distinguish a recently observed worker from the request fallback; a heartbeat older than ten seconds is considered stale. This is a liveness observation, not a promise that a particular delivery will succeed.

Stop the worker with Ctrl+C. Its signal handler stops scheduling new passes and waits for an ongoing pump before closing the database. A forced termination can interrupt an attempt; the existing lease recovery and completion fencing handle subsequent processing.

Development uses Next.js's webpack mode after repeated reloads were observed in the Windows checkout during local verification. Production uses the standard `next build` command.

The migration command applies the committed SQLite migrations. The database defaults to `.data/relayforge.sqlite`; set `DATABASE_PATH` to change its location. The application also applies pending migrations when the database opens. Keep the database on writable, persistent storage when deploying so account and delivery history survive restarts.

To run the production build:

```sh
npm run build
npm start
```

Deploy to a Node.js environment with persistent disk storage and HTTPS. The project does not require a particular hosting provider or an external identity account.

Run `npm run worker` as a separately supervised process alongside `npm start`. Both processes must use the same database file and have access to the committed migrations; using the same working directory keeps relative paths consistent. A web server by itself does not start the autonomous worker. The worker processes the built-in receivers in-process and does not send outbound webhook requests.

## Verify the work

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs these commands and a production dependency audit after a clean dependency install. The [validation record](docs/VALIDATION.md) contains the dated check results and known full-audit findings. For behavior beyond unit tests, run the demo, observe scheduled retries, replay after receiver recovery, and refresh to confirm that delivery history persists. To inspect autonomous processing, start the worker, enqueue a flaky delivery, close all dashboard tabs, and reopen the application after its retries. Closing the tab stops dashboard-driven processing; a running worker can continue it.

With the development server running, use a second terminal for the real HTTP smoke check:

```sh
npm run smoke
```

It checks authentication, same-origin protection, account isolation, duplicate submissions, immutable replay cycles, paused bulk recovery, and the guided repair-to-delivery path. It only accepts loopback URLs and creates two test accounts, three events in the primary workspace, and one event in the isolation workspace. Run the worker alongside the web server; the check can also advance request fallback while polling its own test data.

With the same local server running, `npm run security:smoke` checks session revocation, password rotation, strict security/audit requests, and audit isolation using separate synthetic accounts. It changes only its own test account's password. The checks leave their test records in the local database.

`npm run request:smoke` checks the API failure contract, server-owned request IDs, privacy, and rate-limit responses using synthetic accounts. API failures retain their readable `error` message and add a stable `code` and `requestId`. Login and Security display rate-limit waiting periods; error details expose only a validated request ID for diagnosis.

After `npm run build`, run **`npm run verify:http`** to execute all three HTTP checks with a separately launched web server and worker on a loopback port. This runner uses a new temporary database, shuts down its own processes, and removes that temporary directory. It does not use the local application's database. CI runs this compiled HTTP verification after the build.

No throughput, availability, or latency benchmark is claimed. Dashboard durations describe controlled receiver attempts; they do not measure external network performance. Each workspace accepts up to 500 events. The overview snapshot returns the latest 100 deliveries; the delivery-history API pages through the workspace's full accepted history with server-side search, status, and endpoint filters.

## Code map

| Path                      | Responsibility                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `app/`                    | Dashboard and HTTP route entry points                                                 |
| `lib/contracts.ts`        | Shared actions, snapshot, paginated delivery-history, and detail types                |
| `lib/server/auth.ts`      | Credential validation, password hashing, session lifecycle, and authentication limits |
| `lib/server/audit.ts`     | Unified account-owned delivery and security audit queries                             |
| `lib/navigation.ts`       | Canonical URL state and safe local sign-in return destinations                        |
| `lib/commands.ts`         | Bounded command search and canonical navigation destinations                          |
| `lib/client-api.ts`       | Shared HTTP decoding, failure codes, request IDs, and retry metadata                  |
| `lib/server/database.ts`  | Native SQLite adapter, transactional batches, and migration tracking                  |
| `lib/server/service.ts`   | Acceptance, leases, processing, receiver effects, and snapshots                       |
| `lib/server/worker.ts`    | Autonomous queue passes, worker heartbeat, and graceful shutdown                      |
| `scripts/worker.mjs`      | Node.js worker entry point and local environment loading                              |
| `scripts/verify-http.mjs` | Isolated compiled web/worker runtime and bounded HTTP smoke verification              |
| `lib/server/domain.ts`    | Retry policy, canonical JSON, hashing, and signatures                                 |
| `lib/server/http.ts`      | Runtime validation, request bounds, and API errors                                    |
| `db/` and `drizzle/`      | Database schema and committed migrations                                              |
| `tests/`                  | Reproducible reliability checks                                                       |
| `docs/`                   | Architecture, demo narrative, and next milestones                                     |

Start with [the architecture](docs/ARCHITECTURE.md) to follow acceptance, claim, receiver handling, and completion. The [interview guide](docs/INTERVIEW-GUIDE.md) covers the tradeoffs worth explaining before adding features.

## Design references

The design draws on [Stripe's webhook guidance](https://docs.stripe.com/webhooks), including duplicate events and signature verification, and [AWS's discussion of safe retries with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). RelayForge demonstrates these ideas in a controlled environment; it does not implement either provider's service or protocol.
