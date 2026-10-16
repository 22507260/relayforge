# Interview guide

RelayForge is a useful portfolio project when you can reproduce its behavior, find the responsible code, and explain its limits. The polished interface is an entry point; the delivery and security decisions give an interviewer something concrete to investigate. No project guarantees a job offer.

## A 90-second demonstration

Prepare the worker and independent reference receiver before the interview. Configure a reference connection and its one-time signing secret, then use `lose-first-ack` mode. Be clear about setup performed before the demonstration.

| Time    | Action                                                                   | Explain                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–15 s  | Open Live Overview and Connections                                       | “Live HTTP integrations are separate from controlled Lab metrics. Each connection has an immutable destination and its own encrypted signing key.”               |
| 15–35 s | Send JSON with an idempotency key in Integration Studio                  | “Acceptance persists the event before any network delivery. The producer API uses a bearer key scoped to this connection.”                                       |
| 35–55 s | Follow the network failure and subsequent acknowledgement                | “The independent receiver committed the effect, then dropped the first reply. The sender cannot know that the effect happened from the failed request.”          |
| 55–70 s | Inspect the same event's attempts; check receiver storage evidence       | “Two attempts can still produce one effect because the receiver deduplicates the stable event identity in its own transaction.”                                  |
| 70–90 s | Send the same producer input again, then show Security keys and Recovery | “A matching repeat returns the original event. Tokens are hashed, expire, and revoke immediately; manual replay starts another cycle without replacing history.” |

The dashboard cannot inspect arbitrary external receiver storage. Use the reference receiver's recorded effect count or automated integration evidence when discussing that effect, rather than claiming that HTTP 200 proves it.

For a guided operator story, use Recovery Lab: four persisted HTTP 500 attempts, a dead event, repair, and replay with one verified lab effect. Reload midway to show persisted progress. A separate bulk example explains why selections contain expected cycles and why changed records are skipped without partially committing an operator action.

For autonomy, enqueue a live event with the worker running, close the dashboard, and reopen it to inspect timestamps. Repeat with the worker stopped: live events wait safely, while browser fallback is limited to Lab. A heartbeat proves a recent database write, not receiver health or guaranteed delivery.

## Explain the project in one paragraph

“I built RelayForge to make webhook delivery and recovery inspectable. A React dashboard and scoped producer API persist immutable events in SQLite before delivery. A separate Node.js worker claims work with leases, signs envelopes with encrypted per-connection keys, and sends bounded HTTP requests only to allowed destinations. Public DNS addresses are validated and pinned while hostname and TLS verification remain intact. Attempts record real responses or network failures, and replay preserves identity with separate cycles. An independent receiver reproduces a committed effect with a lost acknowledgement and deduplicates the retry in its own database. The application has clear single-database limits and does not claim exactly-once network delivery or production availability.”

## Questions to prepare for

| Question                                              | Discuss                                                                                                                                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why build this instead of another CRUD application?   | State transitions, competing workers, producer authority, DNS policy, ambiguous acknowledgements, and recovery are visible user behavior.                                     |
| What happens if two workers see one event?            | A conditional transactional lease claim admits one current owner; reading a due row alone does not establish authority.                                                       |
| What if a worker finishes after losing its lease?     | Result writes require its token. Fencing prevents stale state overwrite, while receiver deduplication still protects repeated effects.                                        |
| Why are network attempts and effects different?       | A receiver can commit and lose its reply. The independent receiver reproduces this case; a retry must reuse stable identity.                                                  |
| Is delivery exactly once?                             | No. Separate producer event deduplication, at-least-repeated network attempts, and receiver-side transactional effects.                                                       |
| What does HTTP 202 mean here?                         | The event was accepted into the durable queue. It does not mean delivery succeeded. Matching duplicates return the original event ID.                                         |
| Why can a live 2xx result say only Acknowledged?      | Sender-visible HTTP success cannot verify an arbitrary remote application’s business transaction.                                                                             |
| How do you prevent SSRF and DNS rebinding?            | Exact operator allowlist, HTTPS/443 URL rules, all A/AAAA addresses checked on every attempt, mixed/special address rejection, and pinned lookup with Host/SNI/TLS intact.    |
| Why is localhost allowed for the reference receiver?  | It is an explicit server-enabled transport with a fixed address, separate from user-configurable HTTPS URLs.                                                                  |
| Why not follow redirects?                             | A redirect creates another destination/authorization boundary. This version treats non-success redirects as terminal.                                                         |
| How is the total timeout implemented?                 | A five-second deadline spans DNS through response headers, cancels the resolver, and destroys the request. A socket idle timeout alone would not enforce that boundary.       |
| Which failures retry?                                 | Network/DNS/TLS/deadline errors, HTTP 408, 429, and 5xx within four attempts; other non-success HTTP outcomes are terminal. Valid 429/503 Retry-After is bounded to 24 hours. |
| Can a revoked producer key still use an earlier read? | Authority, expiry, revocation, connection state, quotas, and enqueue are checked under the same immediate transaction.                                                        |
| Are the signing secret and producer token the same?   | No. A signing secret authenticates outbound envelopes and is encrypted; an inbound producer token authorizes one connection and is stored as a hash.                          |
| How does signing-key rotation avoid disruption?       | A revision-guarded transaction creates the new current key and gives the old key 24 hours. Both signatures appear during overlap.                                             |
| What if the master key disappears?                    | Affected live work remains queued without spending attempts. The original protected key must be restored; plaintext fallback or silent replacement would break the boundary.  |
| How is replay different from automatic retry?         | Replay is a deliberate new cycle on the original event, with a fresh four-attempt budget and preserved old attempts.                                                          |
| Why SQLite?                                           | It makes the bounded project easy to run and inspect. Immediate transactions, leases, and quota checks are visible before adding distributed infrastructure.                  |
| What does the heartbeat establish?                    | Recent access to this database. It is written independently every two seconds, but does not establish queue health or receiver success.                                       |
| What do duration values measure?                      | Attempt time until response headers or failure. They are not remote business-processing time or a production performance benchmark.                                           |
| Why is the Live/Lab overview server-scoped?           | Totals and recent rows must remain correct even when the generic latest-100 snapshot mostly contains the other scope.                                                         |
| What would you improve next?                          | Measured workload/retention policy, operational alerting, account recovery, deployment egress controls, and a database adapter justified by evidence.                         |

## Read the implementation

1. `lib/contracts.ts`, `db/schema.ts`, and migrations: transport identity, ownership, cycles, key metadata, constraints.
2. `lib/server/integrations.ts`: connection/revision management and transactional producer acceptance with quotas.
3. `lib/server/signing.ts`: external master loading, authenticated encryption, and rotation signatures.
4. `lib/server/transport.ts`: URL policy, public address checks, pinned request, bounded headers, and cancellation.
5. `lib/server/service.ts`: durable acceptance, claim, fencing, retry/replay, and scoped observations.
6. `lib/server/worker.ts`: lane admission, independent heartbeat, fairness rounds, and shutdown.
7. `lib/reference/receiver.ts`: verification and atomic effect/receipt handling before the ambiguous reply.
8. Authentication and audit: session authority, password races, ownership, stable errors, and safe URLs.
9. Tests and `scripts/verify-http.mjs`: distinguish policy/unit checks, database races, real socket/receiver behavior, and compiled route smoke checks.
10. Product components: follow persisted observations into onboarding, Studio, inspector, and Recovery controls.

Explain account-security races with the same discipline as producer revocation. Password verification happens outside the write lock, so committing must recheck the verified hash and authorizing session. A public session ID or copied event URL is a selection identifier, not an authentication grant.

Explain why the command palette waits for its dialog to close before navigating to a drawer, why obsolete search results are cancelled, and why error message text must not decide whether the client signs out. These are frontend correctness decisions supported by the same bounded server contracts.

## Evidence before claims

Use [Validation](VALIDATION.md) for actual check results. Show reproducible experiments for lease races, revocation, DNS policy, lost acknowledgement, and rollback; use measured workloads for performance claims. Do not invent traffic scale, production incidents, paying customers, or availability guarantees. The project's deliberate limits are part of its engineering explanation.
