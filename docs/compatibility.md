# Compatibility

## Verified in CI / e2e

| Component                       | Support                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CrowdSec Security Engine (LAPI) | v1.5+ — alerts, decisions, allowlists, metrics, `cs_info` version. Verified end-to-end on native **1.7.6** (watcher login, 30-day import, incremental sync, bouncer lookup, ban/unban, allowlist check)                 |
| Caddy                           | Log scanning, bouncer/config snippets via agent. Verified on the deployment host with `caddy-crowdsec-bouncer` **v0.14.1** — global `crowdsec {}` + per-site `crowdsec`/`appsec` handlers, streaming + live enforcement |
| Nginx                           | Log scanning, bouncer/config snippets via agent                                                                                                                                                                         |
| Traefik                         | Log scanning (access logs), bouncer/config snippets via agent                                                                                                                                                           |
| CrowdSec AppSec (WAF)           | Scenario/status surfaced; config via agent. Verified on 1.7.6: inband block → alert → ban escalation, `cs_appsec_reqs_total` + `cs_appsec_rule_hits` metrics                                                            |
| Native (systemd) hosts          | Agent `service.reload`, file ops under `AGENT_FILE_ROOTS`                                                                                                                                                               |
| Dockerized CrowdSec             | Agent `AGENT_CSCLI=docker:<container>`                                                                                                                                                                                  |
| Dockerized apps                 | Read-only discovery (`AGENT_DOCKER=1`)                                                                                                                                                                                  |
| Cloudflare Free/Pro zones       | IP list + managed custom WAF rule; token scopes documented on `/edge`                                                                                                                                                   |
| Auth                            | Better Auth email/password, roles (viewer/operator/admin), optional TOTP 2FA                                                                                                                                            |
| Notification channels           | Webhook (HTTPS, SSRF-checked), SMTP                                                                                                                                                                                     |

## Container images

`linux/amd64` and `linux/arm64` are built by the release workflow. amd64 is
run-tested natively; arm64 was run-smoked under QEMU emulation
(boot, migrations, `/healthz`, `/setup` all pass) — report issues if you hit
an arm64-specific runtime bug on real hardware.

## Requirements

- Node.js >= 22.17 for source deploys; the image bundles its own runtime.
- SQLite with WAL — any filesystem that supports POSIX locks. **NFS/SMB/CIFS
  mounts are unsupported** (locking is unreliable there).
- A Cloudflare edge account needs the three token scopes listed on `/edge`;
  other Cloudflare plans with the same scopes work identically.

## Known unsupported / out of scope

- **Apache, IIS, Envoy, HAProxy** log formats — parser coverage is
  Caddy/Nginx/Traefik only; other formats fail attribution honestly.
- **Cloudflare Business/Enterprise-only features** (e.g. account-level WAF
  rulesets on Free) — the app uses custom rules + lists which work on Free.
- **Horizontal scaling / multiple app replicas** — one process owns the
  SQLite file and the job queue; run a single instance.
- **External databases** — `DATABASE_URL` accepts libSQL URLs but only local
  files are tested; Turso/remote libSQL is untested.
- **Automatic upgrades** — by design, updates are a manual, verified step.

## Measured limits

See `docs/benchmarks.md` for the full methodology. Headline numbers from the
reference run (single process, local NVMe): ~11k alert inserts/s, ~2.6k
paginated alert-list queries/s, edge-candidate scan ~82 ms over 10k
decisions, ~260 warm `GET /` requests/s. The app is designed for a single
admin team — it is not a multi-tenant high-traffic service.
