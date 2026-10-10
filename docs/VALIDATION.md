# Validation record

Recorded on **2026-10-10** for RelayForge's standalone Next.js runtime on Node.js 24, with application-owned accounts and sessions and a persistent SQLite database. These results describe the checks performed; they are not a throughput benchmark or a production availability claim.

The checks below cover the final dashboard, application accounts, and paginated delivery-history API. Automated verification was rerun after the last UI repairs and text edits.

## Automated checks

| Check                                     | Current standalone-runtime result                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run typecheck`                       | Passed on the final implementation                                                             |
| `npm test`                                | 23 tests passed, 0 failed, using the production SQLite adapter                                 |
| `npm run db:migrate`                      | Passed                                                                                         |
| `npm run build`                           | Final standard Next.js production build passed, including the delivery-history route           |
| `npm run lint`                            | Passed with 0 warnings                                                                         |
| `npm run smoke`                           | Passed against development and the final compiled production server, including the history API |
| `npm audit --omit=dev --audit-level=high` | 0 production dependency findings                                                               |
| `npm audit`                               | 5 high findings in the lint dependency chain; see [Security](SECURITY.md)                      |

The test suite uses the same SQLite adapter as the application. It covers password hashing, credential validation, session expiry and revocation, authentication limits, payload identity, signatures, retry bounds, request validation, tenant isolation, competing SQLite connections, expired leases, stale completion, replay, receiver effect deduplication, and controlled timeout behavior.

The history checks cover strict query bounds, stable pagination across 125 records, search beyond the latest-100 snapshot, literal search characters, and account isolation. Attempt metadata checks cover replay with equal timestamps and interrupted attempts without a measured HTTP duration. Endpoint duration remains available when its measured attempt falls outside the snapshot window. These tests do not reproduce a distributed production deployment.

## HTTP smoke check

The smoke check passed against development and against the compiled application started with `npm start` on port 3000. It uses a loopback URL and its own test account.

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

## Browser verification

The current account flow, dashboard, and history controls were checked in the browser:

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

Follow the [README setup](../README.md#run-locally), then run the type check, tests, and build. Keep `npm run dev` running and execute `npm run smoke` in a second terminal. Use the dashboard to inspect retries, repair a receiver, replay an event, and reload.

No throughput, external network latency, or availability benchmark is claimed. Dependency audit results are time-specific; rerun them when the dependency tree changes.
