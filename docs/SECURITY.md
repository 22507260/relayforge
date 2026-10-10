# Security boundaries

RelayForge is a controlled reliability lab. Its safeguards are scoped to this application; it does not claim production certification.

## Enforced by the application

- Workspace API routes require an authenticated application session. Every workspace query and mutation is scoped to that account's stable ID.
- Accounts use email/password credentials. Passwords use randomly salted scrypt hashing. Authentication is established by the application's session cookie rather than browser-supplied identity headers.
- Session tokens are random, expire after seven days, and are stored only as SHA-256 hashes. Cookies are HttpOnly, SameSite=Lax, and Secure in production; sign-out revokes the session.
- Authentication attempts use persistent ten-minute counters: ten per normalized email and 100 across the application. This bounds password-hashing work in the current single-database deployment; larger deployments need reviewed abuse controls.
- Registration, sign-in, sign-out, and dashboard mutations require the same origin. JSON actions have strict runtime validation and bounded request size and nesting.
- Receiver envelopes require a timestamped HMAC signature. Signing keys stay in server-side storage and are excluded from API responses.
- Immutable events, database uniqueness constraints, lease tokens, and receiver effect deduplication protect distinct parts of the delivery lifecycle.
- Only built-in destinations are accepted. The delivery processor does not fetch arbitrary URLs.

Deploy behind HTTPS and keep `DATABASE_PATH` on persistent storage. Treat the SQLite file and backups as sensitive: they contain account information, password hashes, sessions, signing keys, and delivery payloads. Never publish the local database or real credentials in the repository.

## Dependency verification

```sh
npm audit --omit=dev --audit-level=high
npm audit
```

Audit results depend on the resolved dependency versions and the advisory database at the time of the check. See [Validation](VALIDATION.md) for the current recorded results. Development packages can contribute code to generated bundles, so review the full audit as well as the production dependency audit.

On **2026-10-10**, the production dependency audit reported zero findings. The full audit reported five high findings through `braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next`. These belong to the lint dependency chain; the application APIs do not accept user-supplied glob patterns. Track the upstream [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and rerun the full audit when updating lint dependencies.

Review suggested dependency changes before applying them. A forced fix can introduce a breaking downgrade or change unrelated parts of the runtime. Track upstream fixes, review changed dependencies, and rerun tests and build after an upgrade.

## Current limits

Email verification, password recovery, signing-key encryption and rotation, distributed abuse controls, external destination validation, and autonomous scheduling remain future work. Review these boundaries before offering accounts to the public. See [the architecture](ARCHITECTURE.md) for the implemented trust model and [the roadmap](ROADMAP.md) for bounded next steps.
