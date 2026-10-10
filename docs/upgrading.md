# Upgrading

## Standard upgrade

1. **Back up.** `npm run backup` (or `/system → Download backup`). The backup
   is a consistent `VACUUM INTO` snapshot of `app.db`.
2. **Check release notes** for the target tag — breaking changes and manual
   steps are called out there.
3. **Pull the new image** (`docker pull ghcr.io/bitdoze/bitdoze-crowdsec-dash:X.Y.Z`)
   or check out the tag and `npm ci && npm run build`.
4. **Restart.** Migrations run automatically at startup before the server
   accepts traffic; the health endpoint answers only after they finish.
5. **Verify** `/system` — component versions, sync state, and the update-check
   card confirm what is running.

Upgrades are in-place and forward-only. Skipping versions is safe: migrations
are cumulative and applied in order.

## Rollback

Database migrations are not reversible in place. To return to an older
version:

1. Stop the app.
2. Restore the pre-upgrade backup:
   `npm run restore -- --file data/backups/<file>.db`
   (the script checkpoints, atomically replaces `app.db`, and leaves the old
   file at `app.db.restore-bak`).
3. Start the older image/tag.

Configuration the app pushed elsewhere (CrowdSec config, allowlists,
Cloudflare rules) is not rolled back — those changes are individually
reversible through their own rollback steps or the Edge uninstall action.

## Migration notes

- Migrations live in `drizzle/` and run inside a transaction at boot via
  `MIGRATIONS_DIR`.
- Schema changes that e2e/ops depend on: `0010` adds `cloudflare_zone.paths`,
  `0011` adds `decision_edge_idx` (selective edge scans).
- The app refuses to boot on a failed migration — restore the backup and
  report the failure rather than forcing startup.

## Image pinning

For reproducible deploys pin the digest or the `X.Y.Z` tag — `latest` and
`X.Y` move. Release artifacts ship with checksums; verify before promoting:

```sh
sha256sum -c checksums.txt
```
