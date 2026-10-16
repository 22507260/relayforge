# Security boundaries

RelayForge 2.0 implements account isolation, scoped producer credentials, encrypted live signing keys, and restricted outbound delivery. These are application safeguards with explicit operational limits; the project does not claim production certification.

## Accounts and dashboard authority

- Accounts use normalized email addresses and randomly salted scrypt password hashes. Passwords require 12–128 characters.
- Session tokens are random, expire after seven days, and are stored only as SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, and Secure in production. Logout revokes the current session.
- Dashboard queries derive ownership from the server-verified session. A submitted owner ID, identity header, known event ID, or shared URL cannot select another workspace.
- Registration, sign-in, sign-out, and dashboard mutations require the same origin. Management JSON uses strict runtime schemas and bounded request bodies.
- Authentication attempts use persistent ten-minute counters: ten per normalized email and 100 across the application. Security mutations have a separate five-per-account/ten-minute quota.
- Security lists at most 50 active sessions, with the current one first, the total count, and the latest 20 events. Public session IDs cannot authenticate. Last-seen writes happen at most once per minute and do not identify a device or prove user presence.
- Session revocation requires account ownership and a valid authorizing session. Foreign and missing session IDs have the same generic result. The current session uses Sign out.
- Password rotation verifies the old password and atomically replaces the password hash and all old sessions with one fresh session and an audit event. The write rechecks the authorizing session and unchanged verified hash; sign-in applies a matching guard so an old verification cannot create a session after password rotation.

## Producer keys and acceptance

`POST /api/v1/events` authenticates only a bearer producer key. Browser sessions do not replace that credential. A key has `events:write` scope for exactly one enabled HTTPS/reference connection; owner and destination are derived from stored authority. The request schema does not accept a caller-selected owner or connection.

Tokens contain 32 random bytes, are revealed once, and are stored as SHA-256 hashes with a display prefix. Creation requires a usable live connection, limits expiry to 1–90 days (90 by default), and enforces ten active keys per workspace. Revocation and key creation commit with audit state. Accepted events remain in the queue after a token is revoked.

Enqueue rechecks scope, revocation, expiry, connection state, and quota inside the same `BEGIN IMMEDIATE` batch as the event insert. A revoked or expired key cannot use an earlier authorization read to enqueue. Fixed-minute persistent limits allow 60 admitted requests per key and 240 per owner; duplicate submissions also consume quota. Excess requests return `429` with bounded retry metadata. These are single-database limits, not a distributed abuse-control service.

Requests are capped at 16 KiB, payloads at 12 KiB, JSON depth at 24, and traversal at 2,000 nodes. A required printable `Idempotency-Key` of 1–128 characters identifies acceptance within owner and connection. Canonical event content determines whether a repeat returns the existing event or a `409` conflict.

## HTTPS destination policy

Live network calls run only in the worker. Dashboard fallback, demo generation, and the controlled receiver route cannot turn live connections into in-process receivers or initiate outbound requests.

HTTPS destinations must satisfy all of these restrictions:

- Exact operator-configured DNS hostname in `RELAYFORGE_ALLOWED_HOSTS`; no wildcard or user-added allowlist entry.
- HTTPS on port 443, at most 2,048 characters, with no credentials, query string, fragment, or IP literal.
- An immutable destination address. A changed address requires a new connection.
- Fresh A and AAAA resolution on every attempt. Every returned address must be public; a mixed answer is blocked.
- Conservative special-address checks, including private, loopback, link-local, metadata, mapped IPv4, and special IPv6 ranges. IPv6 zone IDs are invalid.
- A pinned validated address for the actual connection, retaining original Host/SNI and TLS certificate validation. No redirects, inherited proxy configuration, or shared-agent DNS reuse.

The five-second total deadline includes DNS, connection, TLS, and response headers. Timeout cancels resolution and destroys the request; a socket timeout alone is not treated as cancellation. Response headers have an 8 KiB limit and bodies are discarded. Error messages expose fixed categories, without raw DNS/socket exceptions or response bodies.

The **reference** transport is separately enabled by the server and always targets `http://127.0.0.1:4100/webhooks`. It is not a private-URL option for arbitrary users. The independent receiver binds only to loopback and verifies signed payloads before recording effects.

An allowlist and address classifier are not substitutes for deployment egress controls. Operators should permit only receivers they intend to contact and review network/storage access before exposing accounts publicly.

## Signing-key storage and rotation

Every live connection has random 32-byte HMAC material. It is stored as authenticated AES-256-GCM ciphertext, using a protected 32-byte raw master file at an absolute path outside the checkout. Associated data binds owner, connection, and key ID, so ciphertext cannot silently be moved between identities.

`npm run setup:live` prepares protected local files and environment paths without printing secrets. POSIX keys require owner-only file access; Windows setup removes inherited access, assigns the current account and SYSTEM, and rejects remaining explicit grants for other principals. Remove such grants before repeating setup; it never reports an unexpectedly shared file as protected. A manually supplied file still needs appropriate operating-system protection. The worker and web process need the same original master key.

Missing, malformed, tampered, or incorrectly decrypted signing configuration does not fall back to plaintext. Affected live events remain queued without consuming their attempt budget. Creating or rotating a connection reveals its secret once; ordinary metadata/snapshot/detail responses contain only public key IDs and timestamps. UI dismissal removes the one-time secret from component state.

Rotation checks `expectedRevision` and commits the current key, previous-key expiry, connection revision, and audit together. Both signatures are sent during the previous key's 24-hour grace period. Another rotation is blocked while that grace period remains active. Update receiver verification configuration during the overlap and retain the old key only through its recorded expiry.

Existing **demo workspace secrets remain in the application database in their historical form**. They only protect controlled lab receivers; the live migration does not claim to encrypt every pre-existing database secret. Treat the database and backups as sensitive even when live connection keys are encrypted.

## Receiver trust and reliability

HMAC covers the exact `timestamp + "." + raw body` bytes; live signing uses decoded 32-byte secret material and includes key IDs. The reference receiver verifies a five-minute timestamp window and a matching signature with constant-time comparison. HMAC protects integrity/authenticity under a shared secret; it does not replace TLS, authorization, or transactional effect deduplication.

The independent reference receiver uses per-connection secrets from a protected external file and its own SQLite database. It does not need the application database or master key. A unique connection/event identity protects its effect; `lose-first-ack` commits that effect before dropping the response so a retry can demonstrate a single effect despite multiple attempts.

Remote HTTPS business effects remain outside the dashboard's observation. A 2xx response means **Acknowledged**. An expired lease or lost reply can produce another network attempt, and external receivers need their own deduplication and atomic business update.

Pause prevents new claims, without cancelling work already claimed. Completion requires the current lease token. Four live calls is a per-worker concurrency bound; separately launched workers can collectively make more calls. Worker database access is trusted local authority and should run under an account with only required storage/configuration access.

## Recovery, audit, and error privacy

Bulk replay requires a session and same origin, accepts at most 20 unique IDs with expected cycles, and checks eligibility under the write transaction. Changed, leased, completed, inaccessible, and guide-managed selections are skipped without exposing another account's state. Replay state and audit commit together or roll back. Recovery Lab exclusively controls its persisted demo receiver and event replay.

History and audit queries apply account ownership, strict bounds, and complete-history pagination. Shared URLs contain view/filter/identifier state, without payloads or credentials. Safe sign-in return paths accept only canonical local dashboard destinations. The command palette uses the same ownership-scoped history route and cancels obsolete searches.

API request IDs are generated by the server, ignore arbitrary incoming IDs, and cannot authenticate or select data. Stable codes distinguish credential failures from expired sessions. Unexpected failure responses are generic; logs exclude submitted credentials, payloads, raw exception messages, names from untrusted data, and stack traces. Login and Security waiting feedback uses bounded retry metadata while server counters enforce the actual limit.

## Operations and remaining limits

Deploy behind HTTPS with a writable persistent `DATABASE_PATH`. Keep database backups and receiver configuration private, protect the master key separately, and restore the original key alongside any application database restore. Losing the key is not repaired by generating a replacement. Restart web and worker together after migration or live policy changes.

Email verification, forgotten-password recovery, distributed abuse controls, operational alerting, retention policies, and high availability remain future work. The trusted local worker and independent receiver do not establish a production operating model.

Check both dependency scopes:

```sh
npm audit --omit=dev --audit-level=high
npm audit
```

Use the dated [Validation record](VALIDATION.md) for the actual release findings. Earlier checks reported a clean production dependency audit and five high findings through `braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`. Those findings concern the lint dependency chain; application APIs do not accept user-provided glob patterns. Review upstream changes and the [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), then rerun tests/build after dependency updates. Do not treat a historical clean audit as a current result.
