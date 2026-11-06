# Reliable Bambu printer synchronization

## Quick start

1. Assign a spool as usual. Spoolman's assignment is saved immediately; the slot
   displays a separate printer synchronization state.
2. During a short connection failure, leave the request pending. The server
   retries automatically even after the page is closed.
3. To choose a spool before loading it, select **Prepare now** in the dashboard
   spool picker or QR/NFC assignment page, then select the target regular Bambu AMS
   slot. Remove any previous filament and insert the chosen spool. No second
   confirmation is required. Current inventory remains unchanged until insertion.
4. A failed/expired request offers **Retry**. **Cancel sync** cancels only pending
   printer work; it does not undo a completed Spoolman assignment.

Use an updated bridge exposing authenticated GET on the existing filament-slot
URL. Normal SET/CLEAR remain compatible with older bridges. Preparation currently
supports regular AMS IDs 0..3 only; external holders and AMS HT have no qualified
presence signal in this implementation. The insertion workflow needs a real-X2D
acceptance test before relying on it in production.

## Behavior and recovery

Each slot has one persistent SQLite `PrinterSyncJob`. New intents replace its job
ID. They are persisted before the external inventory mutation and activated only
after it succeeds. After a crash in between, the worker checks actual Spoolman
assignments before touching the printer. It never blindly replays the assignment.
The local SQLite and external Spoolman are not one atomic transaction.

An instrumentation worker starts with the Next.js Node server and polls due work.
It requires no open browser or HA automation for retry/restart recovery. All local
manual assignments, unassignments, tray-change/usage webhooks and printer attempts
share a process-wide lock. Run **one Node server/container per SQLite volume**;
multiple replicas or cluster workers sharing it are unsupported. External direct
Spoolman edits cannot be locked: the worker rechecks inventory immediately before
a command, but cannot retract a command already in flight.

Transient not-ready/busy, transport, send and reply/verification timeout failures
retry at approximately 2, 5, 10 and then 20 seconds (5% jitter), within one minute.
Explicit printer rejection, invalid input/authentication and invalid responses
stop. Discovery outages retain the intent until expiry. Successful inventory
updates are never rolled back because printer communication fails.

Every retry sends a new bridge command and requires the original reply-plus-fresh-
matching-status verification. An uncertain timeout is never treated as verified
success. Synchronization stops after verified success; it does not continually
overwrite later Bambu Studio edits.

Preparation expires after 15 minutes. It requires a fresh observed empty slot,
then filament present, RFID reading finished, fresh slot identity and idle/finished/
failed print state. These conditions must settle across two observations at least
two seconds apart. Unknown/stale signals block activation. Conflicting RFID or a
changed inventory assignment cancels/stops the preparation. Once activated it is
a normal SET with a one-minute retry budget. Pending preparation suppresses the
tray-change webhook's auto-clear and RFID auto-assignment; existing print usage
still belongs to the old assigned spool until the prepared one activates.

Explicit unassign retains the original slot before removing the inventory
assignment. Its CLEAR is activated afterward and cancelled if that slot becomes
occupied by a newer assignment. Replacement assignment never issues redundant
CLEAR. Retry/cancel actions require the current job ID, rejecting superseded IDs.

## API and diagnostics

`POST /api/spools` retains `{ spoolId, trayId }`, with optional `prepare: true`.
Its `printerSync` is now a queued state, not a claim of printer success.
`DELETE /api/spools` preserves successful inventory removal independently of CLEAR.
`GET /api/printer-sync` returns current jobs and browser-safe states. POST to that
URL accepts `{ id, action: "retry" | "cancel" }`; stale IDs return 409.

Timestamped `[printer-sync]` JSON events include job ID, slot, spool, attempt,
outcome, HTTP status, bridge error, sequence ID and bounded allowlisted diagnostics
such as backend return code, connection reason, printer rejection details and
verification mismatch fields. Bodies, headers, URLs with credentials and arbitrary
error objects are never persisted. Low-level network error codes are retained.
Bridge logs additionally contain its own command/HTTP correlation and the bundled
open backend's original MQTT publish failure code/text.

The migration is deployed by the existing container entrypoint. Keep `/data`
persistent. Offline tests use mock bridges, synthetic telemetry and temporary
SQLite databases; they never connect to a real printer.

Run `npm test` from `app/`. After building `spoolmansync:retry-state`, the production
worker/restart/preparation smoke can be run without network access:

```sh
docker run --rm --network none --entrypoint node \
  -v "$PWD/app/scripts/printer-sync-smoke.mjs:/app/printer-sync-smoke.mjs:ro" \
  spoolmansync:retry-state /app/printer-sync-smoke.mjs
```
