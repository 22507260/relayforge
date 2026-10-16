# Integration setup and protocol

RelayForge supports allowed HTTPS destinations and a fixed independent local reference receiver. Both use the real queue and worker. Controlled Lab receivers remain available as a separate transport with separate overview metrics.

## Local configuration

Use Node.js 24 and install dependencies with `npm ci`. Prepare live signing from the project directory:

```sh
npm run setup:live -- --enable-reference
```

Without `--enable-reference`, the command prepares live signing only. It creates a protected 32-byte raw master key outside the checkout and writes its absolute path to ignored `.env.local`. With the flag, it also prepares a protected reference configuration file and an independent database path. Default security storage is under the user's local application data on Windows and `~/.local/share/relayforge/security` on other systems. Existing configured master keys are preserved; missing keys for existing signing history require restoring the original backup.

The relevant settings are:

| Setting                          | Purpose                                                                    |
| -------------------------------- | -------------------------------------------------------------------------- |
| `DATABASE_PATH`                  | Application SQLite file shared by web and worker                           |
| `RELAYFORGE_MASTER_KEY_FILE`     | Absolute protected file outside the project, exactly 32 raw bytes          |
| `RELAYFORGE_ALLOWED_HOSTS`       | Comma-separated exact HTTPS hostnames; empty disables HTTPS destinations   |
| `RELAYFORGE_REFERENCE_ENABLED`   | `true` enables the fixed reference transport                               |
| `RELAYFORGE_REFERENCE_KEYS_FILE` | Absolute protected receiver verification configuration outside the project |
| `RELAYFORGE_REFERENCE_DATABASE`  | Independent receiver SQLite file outside the project                       |

For an HTTPS service you control, add its exact hostname to `.env.local`, for example `RELAYFORGE_ALLOWED_HOSTS="hooks.your-domain.example"`. This example is a placeholder, not a working receiver. Wildcards, addresses, alternate ports, credentials, queries, and fragments are unsupported. The receiver must resolve only to allowed public addresses and serve a valid certificate for that hostname.

Restart web and worker after environment changes. They must share the same application database and master key. Run them in separate terminals:

```sh
npm run dev
```

```sh
npm run worker
```

For production use `npm run build` followed by `npm start`, with the worker separately supervised and the web application behind HTTPS.

## Connect the reference receiver

1. Open **Connections → New connection → Reference receiver**.
2. Give it a name. Its address is fixed at `http://127.0.0.1:4100/webhooks`.
3. Save the one-time signing secret, key ID, and connection ID from the signing setup screen. The screen offers a copyable receiver configuration.
4. Edit the protected file named by `RELAYFORGE_REFERENCE_KEYS_FILE`. Add the connection entry while preserving other connections and your selected mode.
5. Start `npm run reference:receiver` in another terminal, then send through Integration Studio.

The configuration shape is:

```json
{
  "mode": "healthy",
  "connections": [
    {
      "endpointId": "YOUR_CONNECTION_ID",
      "keys": [
        {
          "keyId": "YOUR_SIGNING_KEY_ID",
          "secret": "YOUR_ONE_TIME_SIGNING_SECRET"
        }
      ]
    }
  ]
}
```

Replace every placeholder with the exact one-time setup values before starting the receiver. Signing secrets are 43-character canonical base64url strings encoding 32 bytes. Configuration is read for each request, so valid key/mode changes take effect without importing the application master key. Each connection supports up to two verification keys; optional `expiresAt` is a Unix timestamp in milliseconds.

The receiver accepts only loopback HTTP, verifies the signed envelope, and uses its own database for effects and receipts. It never reads the main application database or master key. The dashboard observes its HTTP acknowledgement; receiver effect counts come from the receiver's own storage or the integration checks.

## Modes and an ambiguous acknowledgement

| Mode             | Receiver behavior                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `healthy`        | Verify, commit one effect for the connection/event ID, and acknowledge with HTTP 200                                                   |
| `failing`        | Record the failed receipt and return HTTP 503 without applying an effect                                                               |
| `lose-first-ack` | Commit a new effect and receipt, then drop that first response; subsequent delivery of the same event acknowledges the existing effect |

To exercise the network ambiguity, set `mode` to `lose-first-ack` and send a new event. Expect a null HTTP result with a network failure, then a later HTTP 200. The event identity remains unchanged. The receiver's unique `(endpoint_id, event_id)` record supplies evidence of one effect across those attempts and later replay.

For a recovery scenario, use `failing` until four attempts produce a dead event, change the receiver file to `healthy`, and replay the original event. This is separate from Recovery Lab, whose managed in-process receiver is controlled by its guide.

## Producer API keys

Open **Security → Producer API keys**, create a named key for one enabled live connection, and save its one-time token in your producer application's secret configuration. It is never returned by the later key list. The list exposes a prefix, scope destination, expiry, last use, and revocation state.

Default expiry is 90 days; 1–90 days are supported by the management API. A workspace may have ten active keys. Each key permits 60 admitted requests per minute, with 240 per minute across the workspace. Fixed-minute quota enforcement, current key authority, and enqueue share one immediate transaction. Revocation rejects new submissions, without deleting previously accepted events.

Send:

```sh
curl -X POST 'http://localhost:3000/api/v1/events' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: invoice-1042-paid' \
  --data '{"eventType":"invoice.paid","payload":{"invoiceId":"inv_1042","amount":14900,"currency":"USD"}}'
```

`POST /api/v1/events` requires a bearer key and printable 1–128 character `Idempotency-Key`, accepts only `{eventType,payload}`, and returns **202**:

```json
{ "eventId": "PERSISTED_EVENT_ID", "duplicate": false }
```

The event type begins with a letter and uses up to 64 letters, numbers, dots, underscores, or hyphens. Payload must be a JSON object within 12 KiB; the whole request is limited to 16 KiB, depth 24, and 2,000 nodes. The key determines the connection and owner. Browser sessions do not authorize this route.

A matching repeat returns the same event ID and `duplicate:true`, even if it has already been delivered. Changed event type or payload under the same connection/idempotency key returns `409`. A replaced producer token for the same connection does not change the event's idempotency boundary.

Integration Studio uses a session-owned connection route to queue the same type of event without putting producer credentials in the browser composer. Its generated cURL example uses the `YOUR_API_KEY` placeholder. The next HTTP request is asynchronous worker delivery; acceptance is not acknowledgement.

## Signed outbound envelope

The worker POSTs a JSON body containing:

```json
{
  "eventId": "PERSISTED_EVENT_ID",
  "eventType": "invoice.paid",
  "payload": { "invoiceId": "inv_1042" },
  "attempt": 1,
  "cycle": 1,
  "createdAt": 1791936000000
}
```

Event ID, type, payload, and creation time are stable. `attempt` and `cycle` describe this delivery invocation. Replay increments the cycle and retains the original identity and content.

| Header                       | Value                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| `Content-Type`               | `application/json`                                                  |
| `X-RelayForge-Connection-ID` | Connection identifier                                               |
| `X-RelayForge-Event-ID`      | Same event ID as the body                                           |
| `X-RelayForge-Cycle`         | Same cycle as the body                                              |
| `X-RelayForge-Timestamp`     | Millisecond Unix timestamp used for signing                         |
| `X-RelayForge-Signatures`    | Comma-separated `keyId=hexHmac` entries; one or two during rotation |

Decode the displayed secret as base64url to obtain its 32 raw bytes. Calculate HMAC-SHA256 over the UTF-8 bytes of `timestamp + "." + exactRawBody`, then compare the 64-character lowercase hexadecimal signature in constant time. Verify a bounded timestamp window before accepting an effect; the reference receiver uses five minutes. Do not reserialize parsed JSON before signature verification.

Once verified, deduplicate stable event identity and commit the receiver's business effect atomically in its own storage. Timestamp validation and HMAC do not themselves provide effect deduplication. No remote receiver can treat its database transaction and the sender's database write as one atomic operation.

## Rotation and connection state

**Rotate key** requires the current connection revision. Save the new secret when it is shown, add its key ID to the receiver, and retain the old verification key until its recorded `previousExpiresAt` (milliseconds). During the 24-hour overlap the worker sends both signatures, and the receiver can accept either valid key. The reference file supports two keys and an optional expiry on the old entry. Remove the old key after expiry; another rotation is blocked until the grace period finishes.

When copying the new reference configuration, merge the connection's new key into your existing file; do not remove unrelated connections or silently reset its mode. If the old secret is unavailable, the new key alone can verify new dual-signed attempts, but it cannot verify an already emitted request that used only the old key.

Disabling a connection preserves its URL, event data, and attempts and blocks new acceptance/claims. Re-enabling uses a revision guard. An already claimed request can still complete; pause and disable are not cancellation of an in-flight network call.

## Network and retry policy

Only the worker sends live HTTP. HTTPS requires exact allowed hostnames on port 443, fresh public A/AAAA validation and address pinning, normal certificate/hostname verification, and no redirects or inherited proxy configuration. Its five-second total deadline covers DNS through response headers, caps headers at 8 KiB, and discards the response body.

2xx is acknowledged. Network/DNS/TLS/deadline failures and HTTP 408, 429, or 5xx retry within four attempts per cycle. Other unsuccessful HTTP responses are terminal. A valid `Retry-After` on 429/503 may extend retry scheduling up to 24 hours. Network failures keep `statusCode:null` instead of inventing an HTTP timeout status. Missing/unusable signing configuration leaves affected live work queued without consuming attempts.

Four live calls is a limit per worker. A two-second independent heartbeat reports recent liveness, and ten seconds without observation is stale. The dashboard continues polling persisted state; without a worker it can process Lab events, while live events wait.

## Verification and persistence

After the production build, use `npm run verify:http` for the isolated compiled checks. Stop an existing local receiver on port 4100 first. The runner supplies temporary web/worker/receiver processes, databases, master key, and receiver configuration; the guarded integration smoke checks real reference delivery and lost acknowledgement without using local application secrets.

Back up the main database before migrations. Protect the master key separately and retain it for database restores; a new master key cannot decrypt earlier live signing history. The independent receiver needs its own database and verification-key backups. Never commit any real token, secret configuration, master file, or local database. See [Security](SECURITY.md) and [Validation](VALIDATION.md) for trust boundaries and recorded check results.
