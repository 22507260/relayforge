# Interview guide

RelayForge is useful as a portfolio project when you can reproduce its behavior, locate the responsible code, and explain the first version's boundaries. A polished UI attracts attention; reasoning about failure gives an interviewer something substantive to discuss. No project guarantees a job offer.

## A 60-second demo

| Time    | Action                                                                | What to explain                                                                                                                |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0–10 s  | Open the dashboard and run the demo                                   | “This is a persistent webhook reliability lab. Acceptance, retries, and receiver effects are visible.”                         |
| 10–25 s | Open Deliveries, filter failed events, and inspect an attempt history | “Each failure is recorded. Retry policy schedules recovery instead of losing the event.”                                       |
| 25–40 s | Show Engineering's duplicate-prevention count and the stored event    | “The demo submits one key twice. Producer deduplication prevents another queue record.”                                        |
| 40–50 s | Restore receiver health in Endpoints and replay its dead event        | “Replay preserves identity and payload. Its history remains visible, and the receiver deduplicates effects.”                   |
| 50–60 s | Show Engineering's processor boundary and architecture                | “Processing is request-driven, and receivers run in-process. Autonomous scheduling and external delivery are next milestones.” |

If the retry cap needs more time, prepare a dead event before the timed demo and explain how it reached that state. Do not present prepared data as a transition that happened during the demonstration.

## Explain the project in one paragraph

"I built RelayForge to explore webhook recovery under failure. A React dashboard submits validated actions to a TypeScript Next.js API, which persists queue state in SQLite. The application manages accounts and sessions, and every workspace operation is scoped to the authenticated user. The processor leases due work, signs an envelope, records each attempt, and schedules capped retries with jitter. Controlled receivers demonstrate failures and idempotent effects. Processing currently advances through dashboard requests, and the receiver call is in-process; the next step is an autonomous worker with real delivery and crash tests."

## Questions to be ready for

| Interview prompt                                            | A useful answer should cover                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Why build this instead of another CRUD app?                 | State transitions, competing processors, duplicates, observability, and recovery are visible product behavior.                                                                                               |
| What happens if two workers see the same event?             | Inspect the conditional lease update and its returned row. A prior read alone does not prevent races.                                                                                                        |
| What if a worker finishes after losing its lease?           | Completion writes require its token. It cannot overwrite a newer claim, although receiver idempotency remains necessary.                                                                                     |
| What if an external receiver commits but its reply is lost? | The sender has an ambiguous result and may retry. The receiver needs transactional effect deduplication. This MVP's in-process adapter does not reproduce that network failure.                              |
| Is delivery exactly once?                                   | No. Distinguish network attempts, accepted producer events, and the deduplicated demo effect.                                                                                                                |
| What if the same key is reused with different JSON?         | Canonical JSON ignores key ordering, but a changed event type or payload returns `409`. Keys are scoped to owner and endpoint.                                                                               |
| What happens when I close the tab?                          | Records persist; the request-driven processor waits until pumping resumes.                                                                                                                                   |
| How is replay different from retry?                         | Retry follows automatic policy. Replay is an explicit action on completed or dead work; identity stays fixed, the attempt budget resets, and history remains.                                                |
| Why can I replay a delivered event?                         | It exercises receiver idempotency. An acknowledgement can repeat without applying another demo effect.                                                                                                       |
| How do you prevent access to another user's event?          | Derive ownership from server-side identity and scope every operation. Hidden controls and unguessable IDs are insufficient.                                                                                  |
| Why not accept any webhook URL?                             | That feature requires controlled egress, address validation, redirect handling, and SSRF tests. The current scope uses built-in receivers.                                                                   |
| What does HMAC protect?                                     | Envelope authenticity and integrity under a secret, plus a bounded timestamp window. It is separate from authorization and effect deduplication.                                                             |
| Why SQLite rather than Postgres and Redis?                  | A modest persistent environment makes the MVP easy to run and inspect. More infrastructure should follow workload needs and evidence.                                                                        |
| What do the latency numbers measure?                        | Recorded controlled receiver attempt duration, including failed attempts with status codes; they are not external network benchmarks.                                                                        |
| Why does the history list use a separate API?               | The overview snapshot is bounded to the latest 100 events. Pagination and server-side filters can inspect all accepted events within the workspace limit without treating that snapshot as complete history. |
| How would you test a production worker?                     | Real database races, process termination, expired leases, ambiguous acknowledgements, retry caps, and ownership violations.                                                                                  |
| What would you build next?                                  | [Autonomous processing](ROADMAP.md), with verifiable crash and concurrency acceptance criteria.                                                                                                              |

## Read the code in this order

1. `lib/contracts.ts`: name the states and allowed actions.
2. `db/schema.ts` and `drizzle/`: find ownership, unique constraints, attempts, and leases.
3. `lib/server/auth.ts`, `context.ts`, and API handlers: follow password hashing, session verification, identity, and validation.
4. `lib/server/service.ts`: trace `send()`, `pump()`, `receive()`, and replay.
5. `lib/server/domain.ts`: inspect canonicalization, retry policy, and HMAC.
6. `tests/`: distinguish policy tests from database or runtime integration coverage.
7. The dashboard: trace persisted observations into controls and error states.

Practice changing one behavior, such as receiver mode or retry delay, and predict which tests and UI observations should change. Understanding a small coherent system is more persuasive than listing libraries.

## Study notes in Turkish

- **İdempotency:** Aynı mantıksal isteğin tekrarı ek bir iş etkisi oluşturmamalı. Gönderende kuyruk kaydı, alıcıda iş etkisi için ayrı koruma gerekir.
- **Lease:** Bir işi belirli süreyle işleme hakkı. Süre dolunca başka işlemci işi alabilir; bu, tekrar denemeyi imkânsız yapmaz.
- **Belirsiz sonuç:** Gerçek bir HTTP çağrısında alıcı işlemi kaydetmiş olabilir ama cevap gönderene ulaşmayabilir. RelayForge bu sürümde alıcıyı aynı süreçte çağırıyor; bu ağ senaryosu henüz bir entegrasyon testi değil.
- **Transaction:** Birlikte başarılı veya başarısız olması gereken veritabanı değişiklikleri için kullanılır. Uzak HTTP çağrısı ve farklı veritabanları kendiliğinden tek transaction olmaz.
- **Backoff ve jitter:** Başarısız denemeler arasında artan bekleme ve küçük rastgele sapma. Aynı anda başarısız olan işlerin aynı anda tekrar yük oluşturmasını azaltabilir.
- **Tenant izolasyonu:** Her okuma ve yazma sunucunun doğruladığı kullanıcıya bağlı olmalı. Event ID'yi bilmek yetki vermemeli.
- **Replay:** Yeni bir event oluşturmaz. Kimlik ve payload korunur; deneme bütçesi sıfırlanır, eski denemeler saklanır.
- **MVP sınırı:** Veriler kalıcıdır; sekme kapalıyken çalışan bağımsız işlemci ve harici URL'lere gönderim henüz yoktur. Bunu açık söylemek mimariyi anlamanın parçasıdır.

## Evidence before claims

Show test output when discussing tested behavior. Use a reproducible experiment for concurrency or crash recovery, and measured workloads for performance claims. Do not invent traffic scale, latency, paying customers, or production incidents for a portfolio story.

The design references are [Stripe's webhook documentation](https://docs.stripe.com/webhooks) and [AWS's idempotent retry discussion](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/). Explain how RelayForge applies an idea; those references do not prove this implementation is production-ready.
