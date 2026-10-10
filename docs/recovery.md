# Recovery

Failure modes and what actually happens — each row is exercised by
`npm run drills` (see `docs/acceptance-matrix.md`).

## What survives a restart

Protection never depends on the dashboard process. CrowdSec bouncers, AppSec
rules, and Cloudflare WAF rules all live outside the app — killing or
restarting the dashboard changes nothing about whether requests are blocked.

What the restart _does_ affect: alert/decision sync pauses, queued
notifications wait, and durable jobs freeze mid-flight — all resume on boot.

| Failure                           | Behavior                                                                                                                                                      | Recovery                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| App killed (`SIGKILL`) mid-work   | Jobs stay `running` until their 60 s lease expires, then are reclaimed and resume at their last completed step. Outbox drains on the next tick.               | Automatic — no action needed.                                 |
| LAPI unreachable                  | Worker keeps ticking: outbox + job queue still drain, disk/retention still run. Sync state shows the outage; a notification fires once and again on recovery. | Automatic when LAPI returns.                                  |
| Agent unreachable                 | Jobs calling the agent fail with a bounded error; the rest of the tick is unaffected.                                                                         | Retry the job after the agent is back.                        |
| Database locked by another writer | Writes time out after the 5 s `busy_timeout` with `SQLITE_BUSY` — bounded failure, never a hang. Reads under WAL keep working.                                | Remove the competing writer; the app retries on its own tick. |
| Disk nearly full                  | Alert at <15 % free, critical at <5 %; dedupe while the condition persists, recovery notification when cleared.                                               | Free space in `DATA_DIR`.                                     |
| Bad config pushed via agent       | Every `file.write` job first runs `file.backup`; the job's rollback steps restore prior contents in reverse order.                                            | Automatic on failure, or `file.restore` manually.             |

## Backup

```sh
npm run backup                 # → data/backups/app-<ts>.db
```

or **System → Download backup** in the UI. Backups are `VACUUM INTO`
snapshots — consistent even while the app is running. Keep them off-host for
real disaster recovery; `backups/` lives inside `DATA_DIR`.

## Restore

```sh
npm run restore -- --file data/backups/app-2024-01-01.db
```

The script checkpoints the source WAL, copies to a temp file, and atomically
renames over `app.db`. The previous DB is kept at `app.db.restore-bak`.
Restored databases are normalized to WAL mode so the next boot cannot race a
journal-mode switch.

## Reset / start over

There is no factory-reset UI. Stop the app, delete `DATA_DIR/app.db*` (and
`DATA_DIR/secrets/` if you want fresh signing keys), start again — the setup
token flow repeats. External state (Cloudflare list/rules, CrowdSec config,
allowlists) is **not** torn down by deleting the DB; use the Edge uninstall
action or clean those resources manually first.

## Support bundle

**System → Support bundle** produces a redacted JSON diagnostic: counts,
versions, sync state, recent job/audit metadata — never secrets, tokens,
job params, or channel credentials. Attach it to bug reports.
