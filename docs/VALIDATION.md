# Validation record

## RelayForge 2.2 Operations Center — 2026-10-18

The release passed lint, TypeScript, **143 tests with zero failures**, the production build, and a production dependency audit with zero findings. The full audit retains five high findings in the development lint chain documented in [Security](SECURITY.md). No database migration or dependency was added.

Fifteen additional checks cover complete mutually exclusive queue classification and precedence; more than 100 records; account and Live/Lab isolation; owner-wide capacity and its lower bound; pause as a separate overlay; empty reports; stable connection triage; a consistent read-only aggregate with no payload, secret, or foreign-key inspection; storage-error propagation; minimal public liveness and readiness; database failures; exact heartbeat expiry and future timestamps; and canonical Operations navigation. The existing snapshot now uses the same future-heartbeat exclusion as Operations and readiness.

`npm run verify:http` passed **six compiled HTTP smoke scripts plus the health CLI**, using temporary application/receiver databases and owned web, worker, and receiver processes. The Operations scenario checked fixed public probe bodies and no-store/request-ID headers, anonymous report rejection, strict scope parsing, account isolation, 105 paused Lab records beyond the 100-record snapshot, one disabled Live record, identical owner-wide capacity across scopes, stable audit state during reads, and eventual Lab queue drain with its failed connection identified.

The compiled interface was checked with a separate synthetic reviewer account after the previous browser session expired:

- A paused workspace retained 16 accepted events across scopes: 11 queued Lab events, one queued disabled reference event, and 484 remaining places. Lab's local due count stayed visible while paused; Live identified its disabled connection. Scope survived reload and browser Back/Forward.
- Stopping the local worker left liveness at HTTP 200. After the recorded heartbeat expired, readiness returned exactly `{"status":"not_ready"}` with HTTP 503; `health:check` exited 1. The authenticated Live screen showed no current heartbeat and explained its worker requirement. Restarting the worker restored readiness to HTTP 200 and the CLI to exit 0. No signing, policy, DNS, or receiver health was inferred from that result.
- Download report produced a JSON file through the normal browser download flow. The saved Live report matched the offline worker, one queued event, and worker-required flag; it omitted private event/credential fields. The file contains connection names and IDs, as disclosed by the interface.
- Resume allowed the worker to drain the Lab queue. Four controlled failures remained in dead state, with Notifications first in triage. Its Open recovery action selected that connection and displayed exactly four failed deliveries.
- At **1440 × 1000**, **800 × 900**, and **390 × 844**, the document had no horizontal overflow. Queue rows, infrastructure panels, and connection cards stayed within the viewport. Tab reached How queue states work from the report control, and Enter opened its explanation. Mobile navigation Escape returned to its opener; the hidden navigation remained inert while the main content was available. Temporary viewport overrides were reset.
- Command search for `readiness` found Operations Center. Escape closed the palette. A fresh compiled test tab recorded no console warnings or errors; final runtime error logs were also checked.

[Desktop Operations](operations-preview.jpg) shows the paused Lab queue; [mobile Operations](operations-mobile-preview.jpg) shows the disabled Live queue. These are targeted interaction checks, not a complete accessibility or browser compatibility audit. The [Operations guide](OPERATIONS.md) defines queue precedence, report privacy, and the limits of readiness. No production availability or throughput claim is made.

## RelayForge 2.1 Delivery Insights — 2026-10-17

The release passed lint, TypeScript, **128 tests with zero failures**, the production build, and a production dependency audit with zero findings. The full audit retains five high findings in the development lint chain documented in [Security](SECURITY.md). No dependency or database migration was added. The web application, worker, and independent reference receiver were restarted together on the compiled release.

Nine new service checks cover complete history beyond the latest-100 snapshot, Live/Lab and account isolation, identical missing/foreign connection errors, measured zero-duration samples, nearest-rank percentiles, interrupted and unfinished attempts, fixed failure categories and redaction, UTC bucket boundaries, future timestamps, retries on older events, current all-age backlog, empty windows, and a consistent read-only aggregate batch. Two new navigation checks cover canonical Insights URLs, filter round trips, safe login return paths, duplicate/invalid windows, and unrelated filter removal. Command search also resolves `p95` to Delivery Insights.

`npm run verify:http` passed **all five compiled HTTP scripts** against an isolated temporary application database, web process, standalone worker, and independent receiver. The new Insights script accepted 105 Lab events while paused, demonstrated that all 105 were counted despite the 100-record snapshot, and kept a disabled Live reference event separate. It checked authentication, strict and repeated query rejection, generic cross-account errors, private-data omission, no-store responses, and stable queue/audit state across reads. After resume it observed 104 healthy deliveries and one event with four failed attempts, then repaired and replayed that same event: 105 acknowledged events, 109 total attempts, and the four original failures retained. Connection duration percentiles were compared with the recorded attempt durations.

The compiled interface was checked in the existing synthetic reviewer workspace without creating additional events:

- Overview's View insights action and the sidebar opened the new screen. The default 24-hour Live window correctly had no recent events. Seven days showed one accepted Live event, two acknowledged attempts, and measured p50/p95 values of 4/13 ms. These are stored observations, not a performance benchmark.
- Connection and seven-day filters survived reload. Back and Forward restored the unfiltered and selected-connection URLs. Switching to Lab cleared the connection filter and showed its separate 38 events, 93 attempts, and 60 failures. Connection links opened complete delivery history with the selected scope and receiver, without implying an Insights time filter on that list.
- The expanded timeline exposed twelve exact data rows. Tab moved focus to its labelled scroll region. Command search for `p95` found Delivery Insights; Escape closed the palette, released both inert backgrounds, and restored its opener.
- At **1440 × 1000**, **800 × 900**, and **390 × 844**, the document had no horizontal overflow. Mobile metrics, controls, and connection cards stayed within the viewport. The expanded mobile table scrolled within its own 348 px region rather than widening the page. Mobile navigation Escape restored Open navigation focus. Temporary viewport overrides were reset.
- A fresh compiled browser tab recorded no console warnings or errors. The final runtime error logs were also checked.

[Desktop Insights](insights-preview.jpg) and [mobile Insights](insights-mobile-preview.jpg) capture the compiled interface. These are targeted interaction checks, not a complete accessibility or browser compatibility audit. [The Insights guide](INSIGHTS.md) defines event cohorts, attempt windows, latency samples, and queue limits.

## RelayForge 2.0 live integrations — 2026-10-16

The release passed lint, TypeScript, **117 tests with zero failures**, the production build, and a production dependency audit with zero findings. The full dependency audit still reports five high findings in the development lint dependency chain documented in [Security](SECURITY.md). These checks do not establish a production SLA or a throughput benchmark.

Coverage includes encrypted key tampering and wrong-master detection, one-time public secret boundaries, signing rotation and expiry, producer scope/isolation/revocation races, transactional quotas and rollback, immutable idempotent acceptance, migration compatibility, worker-only network delivery, four-call admission, independent heartbeat, fair progress beyond 100 blocked workspaces, lease fencing, and preserved replay cycles. The setup regression verifies protected files and rejects unexpected explicit Windows grants; the cross-platform branch checks restrictive POSIX modes.

Native transport tests cover fresh A/AAAA resolution and cancellation, mixed and changed DNS answers, special and mapped address rejection, pinned TLS connections with the original hostname, certificate rejection, proxy avoidance, redirects, five-second DNS/header deadlines, bounded response headers, and validated Retry-After. Local TLS test fixtures inject their resolver/connector and CA; production has no private-address or TLS-validation bypass flag.

`npm run verify:http` passed all four compiled HTTP scripts against temporary web, worker, and independent reference-receiver processes with separate disposable application/receiver databases and signing configuration. The integration script verifies bearer-only producer access, account isolation, expiry/revocation, quotas, stale connection revisions, pause, lost acknowledgement, four failures, signing rotation, replay, and one receiver-side effect. The runner stops only its owned processes and removes its verified temporary directory; an occupied reference port is rejected.

Before migration 0005 on 2026-10-14, the local database was backed up outside the checkout. The upgrade preserved **15 accounts, two sessions, 45 endpoints, 121 deliveries, 225 attempts, and 391 activity entries**. All old endpoints became enabled demo connections at revision 1; all 225 existing attempts retained their history with null new transport metadata. Migration count increased from five to six; SQLite integrity returned `ok`.

Compiled browser checks used the existing synthetic reviewer workspace. Live initially showed zero events while Lab retained its 38 events; scope survived reload and navigation. Studio rejected invalid JSON, accepted one real reference event, recorded HTTP 200 and measured latency, and returned the same event ID on an idempotent repeat. Replay retained that ID/payload and displayed Initial delivery and Replay 1 separately. An independent receiver database check recorded two receipts in separate cycles and exactly one effect. External success is labelled Acknowledged with an explicit limit on observing remote business effects.

Connections, Studio, Security, and the live overview were checked at 390 × 844 without document-level horizontal overflow. Connection and API-key dialogs opened with a focused close control and inert backgrounds, and Escape closed them without changing credentials. [Live onboarding](live-preview.jpg), [Connections](connections-preview.jpg), [Studio](studio-preview.jpg), [mobile overview](live-mobile-preview.jpg), and [mobile Connections](connections-mobile-preview.jpg) capture the compiled interface. These are targeted interaction checks, not a complete accessibility audit.

The final connection dialog check confirmed that Escape removes the dialog and inert state and restores focus to its New connection opener. Dialogs retain their opener before background inertness can clear browser focus.

## Command navigation and request diagnostics — 2026-10-14

The command palette and structured request-error release passed lint, TypeScript, all **81 tests**, the production build, and the production dependency audit (zero findings). The suite adds 23 checks for HTTP error isolation and request IDs, safe client decoding and retry metadata, and bounded navigation search.

`npm run verify:http` passed all three HTTP smoke scripts against a separate compiled web process, standalone worker, and disposable SQLite database. The runner shuts down its child processes and removes only its verified temporary directory. CI now runs this compiled HTTP check after building.

The compiled browser interface opened the palette with input focus and inert backgrounds, searched persisted event history, and opened the selected recovery event after the palette's exit animation. The resulting single drawer received focus and retained Initial delivery and Replay 1 histories. Escape closed both surfaces. At 390 × 844, the palette had no document overflow, one dialog, focused combobox, and two inert background regions. [Desktop](command-preview.jpg) and [mobile](command-mobile-preview.jpg) captures record the interface. Credential-error and cooldown behavior are covered by automated client and HTTP tests; no existing account password was changed in browser verification.

Earlier release checks follow below.

Updated on **2026-10-13** for the account security, unified audit, and URL navigation release of RelayForge's standalone Next.js runtime and worker on Node.js 24. Earlier recovery, worker, and UI checks are dated separately below. These results describe the checks performed; they are not a throughput benchmark or a production availability claim.

The current checks add active-session management, verified password rotation, complete account audit history, and canonical dashboard URL state to the recovery and worker checks. Production HTTP and browser checks are recorded separately below.

## Automated checks

| Check                                     | Current standalone-runtime result                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                       | Passed on the account security, audit, and URL implementation                                                                        |
| `npm test`                                | 58 tests passed, 0 failed: the prior 39 checks plus 11 security, four audit, and four navigation checks                              |
| `npm run db:migrate`                      | Migration 0004 passed on the backed-up local database; existing account, session, event, attempt, and activity counts were preserved |
| `npm run build`                           | Passed on the compiled release, including `/api/security` and `/api/audit`                                                           |
| `npm run lint`                            | Passed with 0 warnings                                                                                                               |
| `npm run smoke`                           | Passed against the compiled release with the standalone worker active                                                                |
| `npm run security:smoke`                  | Passed against the same compiled release: session revocation, password rotation, strict input, and unified audit                     |
| `npm audit --omit=dev --audit-level=high` | 0 production dependency findings                                                                                                     |
| `npm audit`                               | 5 high findings in the lint dependency chain; see [Security](SECURITY.md)                                                            |

The test suite uses the same SQLite adapter as the application. It covers password hashing, credential validation, session expiry and revocation, authentication limits, payload identity, signatures, retry bounds, request validation, tenant isolation, competing SQLite connections, expired leases, stale completion, replay, receiver effect deduplication, and controlled timeout behavior.

The history checks cover strict query bounds, stable pagination across 125 records, search beyond the latest-100 snapshot, literal search characters, and account isolation. Attempt metadata checks cover replay with equal timestamps and interrupted attempts without a measured HTTP duration. Endpoint duration remains available when its measured attempt falls outside the snapshot window. These tests do not reproduce a distributed production deployment.

## Account security, audit, and URL checks — 2026-10-13

Eleven security tests cover migration compatibility; the 50-session and 20-event bounds; current-session ordering; public-ID separation from authentication tokens; ownership and current-session revocation guards; password verification and rotation; audit-failure rollback for password changes and both revocation actions; stale-login verification; revocation during asynchronous password work; competing password changes; and persistent per-account security limits. The race checks use real SQLite connections and controlled checkpoints rather than relying on scheduling luck.

Four audit tests traverse 67 delivery/security records without repeated pages, check deterministic equal-time ordering, combine account-scoped event/operation/date/literal-text filters, and reject ambiguous or excessive queries. Four navigation tests cover URL round trips, independent recovery filters, canonical bounded defaults, and local-only login returns. These pure navigation tests verify serialization; actual browser history behavior is checked separately in the compiled interface.

Before applying migration 0004, the existing local database was backed up outside the repository. The upgrade retained **11 accounts, two sessions, 97 deliveries, 192 attempts, and 324 activity entries**. Both sessions received separate public IDs and retained unknown last-request timestamps until used. The migration count increased from four to five and SQLite's integrity check returned `ok`.

### Compiled HTTP and browser checks

Both HTTP scripts passed with the compiled web application and standalone worker using the same database. The security script creates two synthetic accounts and 20 healthy events, verifies old cookies become unusable after revocation and password rotation, and checks that response JSON contains no submitted credentials, raw tokens, or token hashes. It checks same-origin and strict-schema failures, the security mutation quota, ownership, full audit pagination beyond 30 entries, and operation/date/search filters. Bounded HTTP polling waits for claims and replay to finish before comparing audit pages, preventing worker timing from changing the result mid-check. Password changes affect only the script's own synthetic account.

The compiled interface was checked in the existing synthetic reviewer workspace:

- Security retained its URL after reload and displayed its migrated current session. A disposable session row with no usable authentication token and a ten-minute expiry was added to this test account to exercise the revocation UI. Escape closed the all-other-sessions confirmation and restored focus to its opener. Confirming individual revocation removed the fixture, preserved the current session, and added the visible security audit entry. Dialog backgrounds were inert.
- Password fields use the correct current/new-password autocomplete attributes, and Show/Hide changes the empty fields' types. No existing account password was entered or changed through the browser. Actual credential rotation and rejection cases were checked by the HTTP script and service tests.
- Activity showed **143 account-owned records**, including delivery and security categories. Selecting ten rows and Next produced records 11–20; reload, Back, and Forward preserved and restored the correct URL and page. A replay operation link returned its two associated records.
- A linked event opened its five-attempt drawer with separate replay and legacy history. Reload restored the operation filter and open event; Escape removed the event parameter while preserving the operation. Event links exposed ordinary dashboard URLs.
- Search survived reload through its canonical URL. A UTC range restored both native date fields and its two matching records from URL state; Apply dates retained the range, and Clear dates removed it. Native date-field typing was not automated; server date validation is covered by tests and HTTP checks.
- Recovery retained its completed guide and event-specific effect. Changing the row count cleared selection; a filtered one-record list survived reload. Its review showed the receiver's current healthy state, and Escape returned to the selection without replaying it.
- At **390 × 844**, Security and Activity had no document-level horizontal overflow. Session panels, audit category/action controls, and UTC date fields stayed within the viewport. Mobile menu Escape restored focus to Open navigation. Security also had no horizontal overflow at **800 × 900**. Temporary viewport overrides were cleared after testing.
- The captured production browser console and runtime error logs contained no warnings or errors.

[Security desktop](security-preview.jpg), [mobile Security](security-mobile-preview.jpg), and [Audit Explorer](audit-preview.jpg) show the compiled interface. These are targeted interaction checks, not a complete accessibility or browser compatibility audit. Email verification, forgotten-password recovery, and reviewed public-service abuse controls remain outside this release.

## Recovery verification — 2026-10-12

Nine service and migration checks, plus one real child-worker check, passed using native SQLite:

| Check                          | Observed result                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration compatibility        | A database with only migrations 0000–0002 retained its original event fields, attempt error, and audit entry. Older attempts and activity kept a null cycle; subsequent replay attempts recorded cycle 2.                                                                                                           |
| Identity and cycle history     | Replay retained the event ID, endpoint, payload, hash, idempotency key, and creation time. Four cycle-1 failures remained unchanged; a successful replay recorded attempt 1 in cycle 2. Replaying a delivered event did not add a second receiver effect.                                                           |
| Mixed selections and isolation | Eligible dead records replayed; stale cycles, active leases, non-dead records, guide-managed records, and inaccessible IDs skipped. Foreign and nonexistent IDs returned the same generic skipped result.                                                                                                           |
| Transaction rollback           | An injected audit-insert failure rolled back both deliveries and their audit records, preserving their prior cycles and attempts.                                                                                                                                                                                   |
| Competing replay requests      | Two independent SQLite connections submitted the same expected cycle. One replayed and one skipped; the cycle advanced once and one replay audit was recorded.                                                                                                                                                      |
| Bounds and paused processing   | Empty, duplicate, oversized, zero-cycle, and fractional-cycle requests were rejected before mutation. Valid replay while paused retained its old history and zero new attempts until resumed.                                                                                                                       |
| Full recovery history          | A dead-record query found an older event outside the snapshot's latest 100 and correctly paginated 125 recovery candidates.                                                                                                                                                                                         |
| Persisted guide and restart    | Repeated start retained one event. Four real fallback claims led to repair and replay of that same event, separate cycle history, and one event-specific effect. A new service instance read the saved stage; repeated guarded restart created one replacement and preserved the previous event and attempts.       |
| Workspace capacity             | Starting a guide at the 500-event limit returned a capacity error without leaving an orphan receiver or scenario.                                                                                                                                                                                                   |
| Autonomous guide processing    | A standalone child worker used actual retry delays, recorded four HTTP `500` failures in cycle 1, and delivered the repaired event with HTTP `200` in cycle 2. No browser or HTTP pump advanced the queue. Pause prevented claims; the event ID and original four attempts were retained, with one receiver effect. |

Before applying migration 0003 to the local application database, a backup was saved outside the repository. The upgrade preserved **92 deliveries, 173 attempts, and nine accounts**. All 173 existing attempt cycles remained null, and SQLite's integrity check passed. These counts describe the local upgrade inspection, not a benchmark or an assertion about another checkout's data.

### Recovery HTTP and browser checks

The development browser was checked using request-driven fallback on **2026-10-12**:

- Recovery Lab progressed through four recorded HTTP `500` failures, receiver repair, and a successful Replay 1. Completion retained the same event and showed one event-specific receiver effect.
- A pre-migration dead delivery retained its HTTP `500` result, measured 1 ms duration, and four attempts grouped under Legacy history. Escape closed the detail drawer, and the sidebar and main column had `inert` applied while it was open.

The expanded HTTP smoke passed against the final compiled production application with the standalone worker active:

| Request or behavior                   | Observed result                                                                                                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account and session flow              | Registration and sign-in issued application sessions; sign-out revoked access. Client-supplied identity headers did not authenticate.                                                                      |
| Mutation protection and replay bounds | Anonymous replay returned `401`; cross-origin replay returned `403`; empty, duplicate, oversized, invalid-cycle, and extra-field requests returned `400`.                                                  |
| Cross-account privacy                 | A foreign detail read returned `404`. Foreign and nonexistent batch selections produced identical generic skipped results.                                                                                 |
| Mixed and stale replay                | The eligible dead standard event queued in cycle 2. Delivered, guide-managed, foreign, and missing selections skipped; resubmitting its old cycle also skipped.                                            |
| Pause and immutable history           | Replay while paused created zero new attempts. After resume, the same payload and original four attempts remained, with one successful cycle-2 attempt appended.                                           |
| Persisted Recovery Lab                | Repeated start retained one scenario; four failures led to repair, replay, and completion of the same event with one event-specific receiver effect. Signing out and back in restored its completed stage. |
| Existing reliability contracts        | Matching idempotency submissions retained the event and effect; conflicting payload returned `409`. History bounds, status/search filtering, and stored latest-attempt metadata remained valid.            |

The smoke uses request pumps while waiting for queue results. Autonomous progress without browser or HTTP pumps is established by the separate child-worker test, not by the smoke run. The expanded script creates two isolated test accounts, three events in its primary workspace, and one event in the second workspace for isolation checks.

The final compiled production interface was checked with the worker active:

- Opening the compiled production application restored the completed guide with the same event, Replay 1, and one event-specific effect. The interface showed Worker online.
- Its detail drawer showed five attempts in separate groups: four HTTP `500` attempts under Initial delivery and one HTTP `200` attempt under Replay 1. The managed event offered Open recovery guide instead of a generic replay control.
- Selecting two legacy dead deliveries opened a review showing both healthy receivers and the preserved event data. The sidebar and main column had `inert` applied. Escape and Cancel closed the dialog, restored focus to Replay selected (2), and did not submit a replay.
- Changing the search filter cleared selection and disabled Replay. An empty search result recovered to the original seven dead deliveries after clearing the filter.
- Confirming the two-record replay showed **2 events requeued, 0 skipped**; the failed list decreased from seven to five. The worker processed the healthy queue.
- At **390 × 844**, the mobile card view had no document-level horizontal overflow. A card checkbox opened a one-record review dialog within the viewport; Escape restored focus to Replay selected (1), and Clear reset selection.
- At **800 × 900**, the responsive card view exposed all five Inspect attempts controls without document-level horizontal overflow.
- The captured production browser console contained no warnings or errors.

[Recovery desktop screenshot](recovery-preview.jpg) shows the completed guide. [Recovery mobile screenshot](recovery-mobile-preview.jpg) shows the card view and two-record replay result. These are targeted interaction checks, not a complete accessibility or browser compatibility audit.

## Worker runtime checks — 2026-10-11

Six tests cover the standalone worker using isolated native SQLite databases:

| Check                                       | Observed result                                                                                                                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processing without HTTP or browser pumps    | A child process completed a flaky delivery with `503`, `503`, then `200`. A paused workspace retained zero attempts and progressed after its persisted pause state was cleared.                                                 |
| Heartbeat expiry and per-instance shutdown  | Two observed workers were counted independently. Stopping one preserved the other's heartbeat; advancing beyond the ten-second freshness window returned request-driven mode. Replacement processing cleaned stale rows.        |
| Competing processes and an API pump         | Two standalone processes and a request pump processed 36 healthy events with one recorded attempt and one receiver business effect per event.                                                                                   |
| Forced process termination and restart      | A child was terminated with `SIGKILL` after a recorded claim. Its replacement waited for the actual 15-second lease to expire, without editing timestamps, recorded the interrupted attempt, and delivered on the next attempt. |
| Graceful abort and exhausted-lease recovery | Aborting the worker loop waited for an active controlled timeout attempt to finish and removed its heartbeat. A replacement recovered an expired final-budget claim into dead state.                                            |
| Idempotent stop before database closure     | Stopping an idle run loop, closing its database, and awaiting the loop completed without a second cleanup query against the closed handle.                                                                                      |

The child-process checks ran on Windows. Graceful shutdown is exercised through the worker loop's abort signal; this does not claim that native operating-system signal delivery was tested on every platform. Receivers remain controlled in-process adapters. The checks do not establish external delivery, supervised deployment, throughput, or high availability.

## Earlier HTTP smoke check — 2026-10-11

On **2026-10-11**, the smoke check passed against the compiled application started with `npm start` on port 3000 while the standalone worker was active. Development and production smoke checks also passed during the previous UI validation on 2026-10-10. Each run uses a loopback URL and its own test account.

| Request or behavior                                     | Observed result                                               |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| Register an account                                     | `201` and an authenticated session                            |
| Sign in with valid credentials                          | `200`                                                         |
| Sign out                                                | `200`                                                         |
| Reuse the revoked session                               | `401`                                                         |
| Cross-origin dashboard mutation                         | `403`                                                         |
| Initialize, send, and delivery detail                   | Persisted state and attempt history returned                  |
| Repeated key and matching payload                       | Accepted event retained without an additional business effect |
| Repeated key with changed payload                       | `409`                                                         |
| Anonymous delivery-history read                         | `401`                                                         |
| Search and status-filtered history read                 | `200`, including persisted latest-attempt metadata            |
| Unknown, duplicated, or oversized pagination parameters | `400`                                                         |
| Authenticated snapshot                                  | Correct account email returned                                |

This sends real HTTP requests to the local API. The delivery processor still calls its controlled receiver in-process. Passing the check does not establish external webhook delivery or behavior under network acknowledgement loss.

## Worker browser verification — 2026-10-11

The final compiled production application was checked with the worker stopped and restarted:

- With no fresh worker heartbeat, the header showed Browser fallback and the sidebar showed Worker offline · browser fallback. The tooltip described the stale heartbeat, and the interface explained visible-page processing every three seconds.
- After the worker started, a subsequent live snapshot showed Worker online, the sidebar showed Worker heartbeat just now, and Engineering showed Background worker connected.
- The workspace retained 37 accepted events, 30 delivered and seven dead, through the process changes.

[Worker dashboard screenshot](worker-preview.jpg) shows the worker release interface. These observations check status transitions and persisted state; the no-browser processing and crash recovery evidence comes from the runtime tests above.

## Earlier browser verification — 2026-10-10

The account flow, dashboard, and history controls were checked in the browser before the worker addition:

- Signing in again restored persisted demo records; a workspace with 24 demo events remained available.
- Reloading the final production build restored 25 accepted events: 18 delivered and seven dead.
- An incorrect password returned the uniform credential error and focused its alert.
- At a 390 × 844 viewport, the email/password form remained fully visible without document-level horizontal overflow.
- With 12 matching deliveries and 10 rows per page, Next showed records 11–12 of 12.
- Closing the event form did not submit an event; the background remained inert while the dialog was open.
- Sending `qa.payment.completed` while processing was paused created the 25th persisted event, queued with zero attempts. Resume delivered it with HTTP `200` and a recorded 18 ms duration.
- At a 390 px viewport, the dashboard had no horizontal overflow. Opening mobile navigation made the main content inert; Escape closed navigation and restored focus to its opener.
- Notifications' Send test action selected the Notifications endpoint. Invalid JSON produced a validation message without accepting an event; Escape closed the form.
- Changing Notifications to healthy and opening its history applied the correct endpoint filter and returned eight records. Replaying a dead delivery preserved its ID and payload, retained four historical HTTP `500` attempts, and added a fifth HTTP `200` attempt. The current replay budget showed one of four attempts.
- The Last attempt tab displayed stored response metadata, timestamps, and measured duration. Focus remained on that tab through a three-second poll while the sidebar and main content stayed inert.
- The final interface showed the correct empty search result and records 11–20 of 25 on page two with 10 rows per page. Tablet and desktop layouts had no document-level horizontal overflow at 768 px and 1440 px.
- Mobile sign-out returned to the new login page; signing in again restored the same workspace. The final browser tab had no captured errors or warnings.

Additional targeted checks to repeat when changing the interface:

- Create an account, sign out, sign in again, and verify that anonymous access is denied.
- Run the demo. Healthy receivers should succeed on attempt 1, flaky receivers on attempt 3, and failing receivers should reach dead state after attempt 4.
- Reload and confirm that dashboard metrics and delivery history persist.
- Verify modal focus, Escape dismissal, keyboard search, and mobile navigation.

These are targeted interaction checks, not a complete accessibility or browser compatibility audit. The dashboard screenshot illustrates the application interface.

## Reproduce

Follow the [README setup](../README.md#run-locally), then run the type check, tests, and build. Keep the web application running, start `npm run worker` in a second terminal with the same `DATABASE_PATH`, and execute `npm run smoke` and `npm run security:smoke` in another terminal. Open Security to inspect active sessions and Activity to filter complete audit history. Use Next, reload, and Back/Forward to inspect preserved URL state; open an event link to restore its drawer. Open Recovery to inspect failed deliveries, select standard records for bulk replay, and run Recovery Lab through failure, repair, and replay. Reload to inspect its persisted stage and grouped cycle history. Stop and restart the worker to inspect the observed processing mode. `npm test` includes isolated migration, credential and replay race/rollback, URL boundary, child-process, and worker lifecycle checks.

No throughput, external network latency, or availability benchmark is claimed. Dependency audit results are time-specific; rerun them when the dependency tree changes.
