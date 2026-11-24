# Database backup and restore

RelayForge 2.4 provides local SQLite backup/check commands and an isolated compiled-process recovery rehearsal. They help preserve and inspect the application database and exercise recovery with disposable fixtures, without adding a database-download endpoint or an automatic in-place restore action. Deployment-specific restore drills, backup storage, and recovery objectives still need observed evidence in the environment where the application runs.

[Operations](OPERATIONS.md) · [Security](SECURITY.md) · [Validation](VALIDATION.md)

## Create a backup

Run from the project directory with Node.js 24. Prepare a private backup directory outside the checkout and choose a filename that does not already exist:

```sh
npm run db:backup -- --output "../private-backups/relayforge-before-migration.sqlite"
```

The source defaults to `DATABASE_PATH`, or `.data/relayforge.sqlite` when that setting is absent. Supply an explicit source when working with another deployment or a saved snapshot:

```sh
npm run db:backup -- --database ".data/relayforge.sqlite" --output "../private-backups/relayforge-before-migration.sqlite"
```

Use absolute paths in a supervisor or scheduled backup job so its working directory cannot change the intended database. The source must already exist and have no hard-link aliases: SQLite can select different WAL files when the same database is opened under different hard-linked names. Symbolic links are resolved to the real source path. The output must be a new file, and the source and destination must be different.

The command uses SQLite's online backup operation, which includes committed data visible through WAL. It creates a protected `.relayforge-backup-*` staging directory beside the output, checks the staged copy, and publishes the completed file using an atomic hard link that refuses an existing destination. The output's parent directory must already exist, and its filesystem must support hard links. Staging is cleaned up on ordinary caught failures. Forced termination or power loss can leave protected staging behind; after confirming no backup process is using it, remove only that identified staging directory. A successful exit means a validated snapshot was written; it does not establish that remote storage, a separate key backup, or an application restore works.

The web process and worker may remain running during an online backup. The result is a consistent database snapshot, rather than a coordinated snapshot of the producer, application, and receiver. Workspace pause prevents new claims but does not cancel claims already in flight. A successful backup does not imply that no event was accepted or delivered after its recovery point.

Do not copy only the main `.sqlite` file while a deployment is writing to it: committed state can still be in its WAL sidecar. Use the online backup command for the application database. The implementation uses the [Node.js SQLite backup API](https://nodejs.org/api/sqlite.html); SQLite documents the risks of [multiple links to one database](https://www.sqlite.org/howtocorrupt.html).

## Check a database without changing it

```sh
npm run db:check -- --database "../private-backups/relayforge-before-migration.sqlite"
```

The check opens an existing database read-only. It checks SQLite integrity, foreign-key consistency, and the recorded migration checksums against the checkout's migration files. Applied migrations must be an unchanged, contiguous prefix of that history; newer unapplied migrations are allowed and reported as pending. Unknown migrations, checksum differences, or gaps fail the check. It does not apply migrations, create a missing database, enqueue events, or send deliveries. Like `db:backup`, it accepts an optional `--database` and otherwise uses `DATABASE_PATH` or `.data/relayforge.sqlite`. A failed check requires investigation before using that file as a recovery source.

Successful commands emit compact JSON with status, integrity and foreign-key results, applied/pending migration counts, and main database file bytes. A live source's byte count excludes its WAL and shared-memory sidecars; the completed backup contains the committed recovery point in its main file. The backup result also includes its SHA-256 checksum. They do not dump database rows, event payloads, or credentials. A checksum identifies the completed backup bytes; it does not establish who created the file. A passing database check does not decrypt signing keys, validate receiver secrets, test storage permissions for future writes, or contact a destination. It is separate from the web and worker readiness probes.

## Preserve the other recovery material

The database contains account and session state, password and producer-token hashes, event payloads, attempt history, and historical Lab signing secrets. Treat the backup as sensitive. The file protections applied during creation do not encrypt its contents; preserve access controls when moving it and use storage protection appropriate to the deployment. Keep databases, sidecars, keys, and receiver configuration out of Git.

Live signing keys remain encrypted in the database. Preserve the **original** protected 32-byte file referenced by `RELAYFORGE_MASTER_KEY_FILE` separately from the database backup, with its required operating-system permissions. The backup command does not bundle or print that key. Generating a replacement master key cannot decrypt the existing connection secrets.

Record the application version and migration history associated with the snapshot. Preserve the deployment's configuration and exact allowed hostnames securely. If using the independent reference receiver, preserve its verification configuration and its separate receiver database through an appropriate receiver backup procedure; the application backup does not include either of them. External receiver business state also lies outside this snapshot.

## Restore to a new database path

There is no automatic in-place restore command. Keep the current database and the recovery source intact while preparing a new working file.

1. Stop incoming producer traffic and stop **all** web and worker processes using the deployment. Disable automatic restarts until the path and configuration have been changed. Workspace pause alone does not stop API acceptance or processes that already hold claims.
2. Select the recovery point and a compatible checkout. Run `db:check` against the saved snapshot. Resolve unknown, changed, or noncontiguous applied migrations before continuing; a valid older migration prefix can report newer migrations as pending.
3. Create a new working database from the saved snapshot. Use a new filename in the deployment's private persistent storage:

   ```sh
   npm run db:backup -- --database "../private-backups/relayforge-before-migration.sqlite" --output "../private-runtime/relayforge-restored.sqlite"
   npm run db:check -- --database "../private-runtime/relayforge-restored.sqlite"
   ```

4. Set `DATABASE_PATH` to that new working file for **both** web and workers. Restore access to the original protected master-key file and review the reference-receiver and HTTPS policy configuration. Ensure the runtime account can write the working database and its directory so SQLite can create its journal sidecars.
5. With processes still stopped, apply any intended additive migration using the documented upgrade procedure and compatible code. Preserve the original snapshot before doing so. Check the resulting database again.
6. Restart the web process and workers together. Check the public probes, sign in to the intended account, and inspect Operations, Connections, and the retained event/attempt history. Use a controlled event and independent receiver evidence to verify delivery. Open producer traffic only after reconciling recovery-point differences and reviewing restored account authority.

These are operator steps, not a promise that each deployment can be restored. Record the actual recovery point, application version, elapsed recovery time, and observed checks when performing a drill. Keep secrets and payloads out of any shared evidence.

## Reconcile recovery-point differences

Restoring a snapshot rewinds application state. Events accepted after that snapshot are absent. A delivery acknowledged after it was taken can appear pending again, and an in-flight lease can need expiry and recovery. Retrying the preserved event identity can repeat a network request. Receivers still need their own transactional deduplication; HTTP acknowledgement does not prove an effect was applied exactly once.

Receiver state and signing-key rotations can also have advanced after the snapshot. The original master key allows decryption, but does not ensure that a receiver still accepts an older connection key. Review connection revisions and receiver verification keys before resuming live work. Do not roll back receiver deduplication state casually: forgetting an effect can allow a repeated request to apply it again.

Account passwords, sessions, producer-key expiry/revocation, and quota counters also return to the saved state. Review and revoke restored authority as appropriate before exposing the restored deployment. Reconcile missing accepted events with producers and business records rather than assuming the backup includes later activity.

## Rehearse with disposable processes

Run the rehearsal from a compiled checkout with Node.js 24:

```sh
npm run build
npm run verify:recovery
```

The command accepts no custom origin or database configuration and does not attach to an existing application. It prepares a protected unique temporary directory outside the checkout, generated keys, synthetic accounts, separate source/restored application databases, and an independent reference receiver database. **Port 4100 must be free.** Stop your local reference receiver first; run this separately from `verify:http`. An occupied port is a failure rather than permission to stop another process.

The scenario checks the recovery boundary in stages:

1. The compiled web application and real standalone worker record an acknowledged event and its attempt history. A second event is accepted while paused, and the backup CLI captures it before delivery.
2. The original application delivers the second event, committing one effect in the independent receiver. The original web and worker processes stop before the backup CLI creates a distinct restored working database. An event accepted after the snapshot is absent after restore.
3. With no restored worker, web liveness remains available while readiness becomes unavailable as any saved worker heartbeat expires. The check uses actual elapsed heartbeat freshness rather than editing timestamps.
4. Workers started with an explicitly missing key file and with an incorrect protected key still publish heartbeats, but the pending live event must gain no attempts or receiver receipts. This distinguishes worker readiness from usable signing configuration.
5. Restarting with the original generated key permits acknowledgement of the same saved event identity. Matching producer input returns the original event and conflicting content returns `409`. The receiver database remains unchanged by the application restore, so a repeated delivery must retain one effect for that event. Saved acknowledged history, the stopped source database, and the backup snapshot are checked for preservation.

These are assertions performed by the command, not a substitute for its actual result. The dated [Validation record](VALIDATION.md) records runs and outcomes. The runner stops only its owned child processes and removes its verified temporary directory on ordinary completion or caught failure. If an owned process cannot fully close within the shutdown deadline, the command fails and preserves its protected fixture rather than deleting files that might still be in use. Shutdown remains bounded even when a parent's descendant keeps a captured output pipe open. Forcibly terminating the runner can also leave fixtures requiring operator review. Successful runs do not retain an application/key backup for later use.

The rehearsal's receiver evidence comes from its own retained SQLite database, not from arbitrary HTTPS services. It deliberately demonstrates that the application can rewind while an external effect remains committed. Generated key recovery in a temporary directory does not test the availability of your separately stored original key, encrypted off-site backups, power-loss/storage-failure durability, or deployment recovery-time and recovery-point objectives.

## Evidence and remaining work

Consult the dated [Validation record](VALIDATION.md) for the checks actually run for this release. Local backup/check tests and the compiled-process rehearsal assess bounded behavior; they do not establish production durability, off-site backup availability, a recovery-time objective, or a recovery-point objective. Production scheduling, encrypted backup transport/storage, retention, alerting, original-key recovery, and restore drills remain deployment responsibilities.
