# Handoff: where the project stands and what to do next

Last updated: 2026-10-09. Read this first, then `AGENTS.md` (commands and conventions), then the spec sections each task points to. Keep this file current when you finish a step.

## What this project is

Bitdoze CrowdSec Dash: a self-hosted, MIT-licensed dashboard that sets up, verifies, and operates CrowdSec protection (log detection, shared bans, AppSec WAF, optional Cloudflare edge) for the websites on one server. Stack: SvelteKit 3, Svelte 5, Tailwind 4, Drizzle + local libSQL, Better Auth, adapter-node.

| Document                                             | Purpose                                                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `crowdsec-dashboard-specification.md`                | The plan. Section 13 has the phases, the release map (v0.1.0 = end of phase 3), checklists, and the progress log. Appendices B and C hold the reference-host findings and the stack probe. |
| `AGENTS.md`                                          | Exact dev, test, Docker, and release commands; code conventions.                                                                                                                           |
| `PRODUCT.md`                                         | Product truth: users, purpose, principles, accessibility target.                                                                                                                           |
| `.impeccable/surfaces/src-routes-app-page-svelte.md` | Binding visual direction ("Inspection Record") for the overview and app shell.                                                                                                             |

## Owner decisions (do not reopen without asking)

- License MIT. Product name "Bitdoze CrowdSec Dash". Image `ghcr.io/bitdoze/bitdoze-crowdsec-dash`.
- Primary user: a solo self-hoster. Accessibility target: WCAG 2.2 AA. No existing brand.
- Cloudflare must work on the Free plan. The default edge mode is a dashboard-owned IP list plus one WAF custom rule per zone (spec 6.3); the Worker bouncer is optional.
- Visual direction: "Inspection Record" (sites x protection tests, stamped evidence, coded observations C1/C2/FI/C3).
- The development server is the unmodified "before" fixture. Its native CrowdSec 1.7.6, its config, and its Docker containers (including the production `caddy` container serving real sites) must not be changed. Passwordless sudo exists; use it only for read-only inspection. Registering the dashboard's own watcher machine on it needs the owner's approval first.
- npm only. A clean `npm ci` must pass without `--legacy-peer-deps`. Do not edit `.npmrc`.
- New dependencies: only versions published at least 7 days ago.
- Commits use Conventional Commits (release-please depends on them).

## Done so far (on `main`)

| Commit    | What                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `83f2038` | Reviewed spec + MIT `LICENSE`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `08fe838` | Foundation: scaffold cleanup; adapter-node behind `server/index.js`, which pins the public origin (adapter-node 6 has no runtime `ORIGIN`); startup migrations + SQLite pragmas from the `init` hook; generated secrets (`resolveSecret`); `/healthz`, `/readyz`; first-admin bootstrap with a one-time token logged at startup (`/setup`); login/logout; public sign-up disabled; unit tests; `PRODUCT.md` and the visual direction |
| `35753e4` | Docker image (non-root, healthcheck, graceful stop), `compose.yaml`, CI workflow, release-please + multi-arch GHCR publishing with provenance, SBOM, and cosign; Dependabot                                                                                                                                                                                                                                                          |
| `ba13498` | CI fixes (smoke-test redirect check, metadata-action `enable` values, no Node/@types/node majors from Dependabot)                                                                                                                                                                                                                                                                                                                    |
| `5394842` | Image security: Debian updates applied and npm removed from the runtime image (local Trivy scan: 0 fixable HIGH/CRITICAL)                                                                                                                                                                                                                                                                                                            |
| `bc2ade5` | "Inspection Record" design system, app shell, and overview (`DESIGN.md`): OKLCH light/dark themes, Public Sans, six status stamps, component set, sites × tests schedule with evidence + observations, fixtures via `DEMO_FIXTURES` + `?fixture=`, restyled `/login` and `/setup`, Playwright e2e in CI, `scripts/contrast-report.mjs` (all pairs AA)                                                                                |

Verified locally: `npm ci`, lint, `svelte-check`, 15 unit tests, build, production smoke test, and a Docker smoke test (setup, restart persistence, uid 1000, 0600 secret file, graceful stop).

On GitHub: CI is green on `5394842` (verify, image smoke test, Trivy). The `Release` workflow pushed an `edge` image on `ba13498`; on `5394842` it stopped at release-please until owner action 1 below is done.

## Phase 2 (auth hardening) — done, on `main` as `249ee1c`

- **Roles:** `admin`/`operator`/`viewer` via Better Auth access control (`src/lib/server/auth.ts`); pure role→permission logic in `src/lib/roles.ts` (client-safe), request guards `requireUser`/`requirePermission` in `src/lib/server/roles.ts`. Permissions: `read` (all) → `operate` (operator+) → `configure` (admin).
- **Login throttling:** `src/lib/server/throttle.ts` — confirmed gap: `auth.api.signInEmail` from a form action bypasses BA's HTTP rate limiter (`onRequestRateLimit` runs in the router only). Own limiter stores `login:<email>:<ip>` keys in BA's `rate_limit` table: 5 failures per 10-min window per email+IP, cleared on success.
- **Two-factor:** `twoFactor` plugin; `/login` is a two-step flow (`signIn` → `verify`/`verifyBackup` named actions — Kit forbids `default` + named actions together). Settings page handles enable/disable + backup codes.
- **`/settings`** (any signed-in user): 2FA status + setup (URI shown once + recovery codes), session list with revoke + "sign out all others", password change (revokes other sessions).
- **`/settings/users`** (`configure` only): create account, role select, ban/unban, remove; self-demotion/self-ban/self-delete blocked; every action audited.
- **Audit:** `audit` table (migration `0001`), best-effort `recordAudit` (`src/lib/server/audit.ts`) wired into login, setup, 2FA, user ops, session revocation.
- **Trusted proxies:** `server/origin.js` gained `trustedProxyMatcher`/`resolveClientIp`; `server/index.js` rewrites `x-forwarded-for` to the honest client IP (socket peer unless the peer is in `TRUSTED_PROXIES`, `*` trusts all). Spoofed origin forwarding headers stay pinned.
- **Recovery CLI:** `npm run recover -- <email>` (`scripts/recover.mjs`) — new random password via BA's own `hashPassword`, clears 2FA rows + sessions + ban + throttle keys, writes an audit row.
- **Tests:** 41 unit (roles matrix, throttle windows/scope/clear, XFF trust) + `e2e/security.spec.ts` (unauthenticated redirect, 403 for viewer on admin UI, full TOTP enable→sign-in→disable, throttle trip + identity scoping, sign-out).

## Phase 3 (read-only monitoring) — done, on `main`

Everything below is implemented and verified; spec phase-3 checklist updated. Core monitoring committed as `88da675`; attack map / capability tiers / observer lookup as the follow-up commit.

- **LAPI client** `src/lib/server/crowdsec/client.ts`: `POST /v1/watchers/login` → JWT cached until expiry, one refresh on 401; typed `/v1/alerts` (since/until/limit/scenario/ip/origin); `LapiError.kind` ∈ `auth|unreachable|http|bad_response` drives the diagnostics on the settings page; `undici` Agent only when `insecureTls` is opted in.
- **Projection schema** (migration `0002`): `server` (encrypted `lapi_password_enc`/`bouncer_key_enc` via `secrets.ts`), `site`, `alert` (+`context`/`events_meta` JSON), `alert_site` (`signal` ∈ context/event_meta/datasource), `decision` (`expired` reconciled from `until`), `sync_state` (cursor/lastError/partial per source), `metric_sample`, `activity_rollup` (deterministic `hour|site|scenario|cn` pk).
- **Worker** `worker.ts`: started once in the `init` hook after migrations; module-guard (single process); 30 s tick, no overlap; idle until a connection exists; errors land in `sync_state`.
- **Sync** `sync.ts`: `since`-cursor paging (500/page, ≤40 pages, 30-day bounded first import), upserts by upstream id, per-alert decision/alert_site replacement, CAPI-only alerts skipped, expiry reconcile + `pruneExpired`.
- **Metrics** `metrics.ts`/`scrape.ts`: Prometheus text parser + whitelist; version from `cs_info` updates `server.crowdsec_version`; CAPI volume from `cs_active_decisions`.
- **Attribution** `attribution.ts`: `target_fqdn` context → event meta → datasource prefix map → unattributed; learned sites auto-insert.
- **UI:** `/settings/crowdsec` (connect/test/syncNow/disconnect, `configure`-only); `/alerts` + `/decisions` + `/ip/[ip]` (`read`); `SyncBanner` stale/partial/not-connected states; `Pager`; nav + palette entries.
- **Live overview** `live-overview.ts`: replaces fixtures when connected — LAPI/metrics/projection server stamps, per-site N/C cells (phase-5 tests named as next steps), C2 unattributed + FI read-only observations, activity/scenarios from rollups, CAPI volume measurement.
- **Tests:** 28 unit (`crowdsec-{client,metrics,attribution,sync}`; sync runs real migrations on in-memory libsql) + `e2e/crowdsec.spec.ts` (bad-credentials diagnostic, connect→sync, CAPI exclusion, filters, expired decisions, IP drill-down, live overview, 503 outage → `SyncBanner` + recovery). Mock LAPI: `e2e/mock-lapi.mjs` on :8090 (started by `webServer[]` in playwright.config; `/_down?set=1` toggles the outage).

- **Attack map** `src/lib/components/AttackMap.svelte` + `src/lib/map-projection.ts`/`map-geo.ts`: world-atlas 110m TopoJSON converted once to SVG path data (equirectangular), lazy-loaded after mount so SSR and the main chunk stay light. `live-overview` aggregates stored alert lat/lon into ~2° cells; sync coerces the LAPI's string geo fields with `num()`. Empty state explains GeoIP is required.
- **Capability tiers** on `/settings/crowdsec`: T1 watcher sync · T2 metrics · T3 observer bouncer · T4 AppSec visibility — each with its own Stamp state (verified/failed/stale/N-C) and "unlocks" line. N/C for absent inputs, never zero.
- **Observer-bouncer lookup**: `?/lookup` action on `/ip/[ip]` (`operate`+), uses `getBouncerKey` (decrypts `bouncer_key_enc`) + `LapiClient.decisionsByIp`. Results scoped to the current IP (`form.lookup.ip === data.ip` — SvelteKit keeps `form` across param navigation). Missing key → N/C stamp; 401 → re-issue hint; outage → clean error.
- **Mock LAPI** gained `/v1/decisions` (`Bearer e2e-bouncer-key`) and relative `ago()` timestamps so 24h windows stay live.

Verified: `npm run check` 0/0, `npm run lint` clean, `npm test` 72, `npm run build`, full `npx playwright test` 26 pass (+7 skipped screenshots), all new screens visually reviewed, contrast report all-pass.

**Not yet:** reference-host connect (owner action 4), v0.1.0 tag (release-please PR after owner action 1).

## Phase 4 (decisions, allowlists, notifications) — done, on `main`

- **Decision request ledger** (`decision_request`, migration `0003`): `src/lib/server/crowdsec/decisions.ts` — `pushDecision` wraps `POST /v1/alerts` (manual alert carrying the decision), `requestRemoval` wraps `DELETE /v1/decisions`. States `pushed → confirmed / removing → removed / failed`, reconciled each sync against the local projection; `upstream_id` + `error` retained.
- **Validation** `src/lib/ipaddr.ts` (client-safe): IPv4/IPv6/CIDR normalize + `4h`/`4h30m`/`2d` duration parse (≤30 d cap).
- **LAPI client** gained `pushDecision`, `deleteDecision`, `allowlists`, `allowlistCheck` (watcher credential — not the bouncer key).
- **`/decisions`**: add-decision form (scope + value + type ban/captcha + duration + reason), request ledger table with state stamps, per-row Remove (`operate`+), client-IP display with private/proxy warning, "server-wide" scope note, captcha-bouncer caveat, "Allowlist my current IP" → guided `cscli` commands (no LAPI write path exists — nothing is pretended).
- **`/ip/[ip]`**: `?/allowlistCheck` action (`operate`+) calls `/v1/allowlists/check/{ip}` — lists matching centralized allowlists, requires CrowdSec ≥1.7 (honest unsupported state below), and names the other two mechanisms (parser whitelists, bouncer trusted IPs) that can also cover an IP.
- **Notifications**: `notification` (unique `event_key` dedupe → count + unread bump on repeat, no re-enqueue), `notification_channel` (encrypted `secret_enc`, `min_severity`), `notification_outbox` (pending/delivered/failed, `attempts`, `next_retry_at` backoff, manual retry).
- **Delivery** `src/lib/server/notify/deliver.ts`: smtp (nodemailer 10.0.13 — newest was <7 days old at add time), webhook, ntfy, gotify, discord, slack, telegram; SSRF rules block loopback/link-local/metadata hostnames + IPs, allow LAN receivers, never follow redirects; errors redacted. Pure field specs live in `src/lib/notify-channels.ts` (client-safe) — server-only modules must never be imported by components, even type-only.
- **UI**: `/notifications` inbox (class/severity/unread filters, pagination, per-row delivery rollup, mark read / mark all, retry failed), `/settings/notifications` channel CRUD + send-test; both added to nav + palette.
- **Worker**: drains the outbox every tick (bounded batch, respects `nextRetryAt`) even while disconnected; emits `alerts.down`/`metrics.down` outages once per stable event and `*.recovered` on the next success (capture `lastError` _before_ the call clears it), plus hourly-deduped new-alert digests. `SYNC_INTERVAL_MS` overrides the 30 s tick for e2e.
- **Audit fan-out**: `NOTIFY_ACTIONS` in `audit.ts` maps real action names (`admin.user_created`, `admin.user_banned|unbanned|removed`, `admin.role_changed`, `decision.create|remove`, `crowdsec.connected|disconnected`, `settings.notifications.channel`, `login.throttled`) to severity/title/href; `describe()` whitelists which detail fields reach the body — internal ids and secrets never do. `scripts/recover.mjs` writes a matching `admin.recovery` notification row directly (best-effort if the table predates it).
- **E2E** `e2e/decisions.spec.ts` (8 tests): mock gained `POST /v1/alerts`, `DELETE /v1/decisions/{id}`, `/v1/allowlists*`, and a `/_hook` receiver bound on a LAN address; covers validation rejection, push→confirm→unban→removed, allowlist check + guided flow, webhook SSRF rejection + real `/_hook` delivery + inbox rollup + mark-all-read, and outage→recovery notifications (deterministic: keys cleared in `.e2e-data` first, then polled with reload).

Verified: `npm run check` 0/0, `npm run lint` clean, `npm test` 102, `npm run build`, full `npx playwright test` 33 pass (+7 skipped), all four screens visually reviewed.

**Not yet:** CVE-detect and failed-job notifications (no source yet), the "ban enforced on both fixture sites" check (needs the phase-5 multi-site fixture), release tag v0.2.0 (same release-please gate).

## Phase 5 (guided setup, agent-free core) — done, on `main`

- **Site inventory** (`/sites`): `site` gained `proxy`/`runtime`/`cloudflare`/`detection` columns (migration `0004`). Manual + learned rows; last-alert and check-progress rollups; add/remove/detect actions (`operate`+).
- **Topology detect** `src/lib/server/protect/detect.ts`: GET probe of the site's public headers (`Server`, `cf-ray`, …) → proxy + Cloudflare guess with the evidence stored on the row. No redirects followed, 8 s timeout, https→http fallback, optional explicit probe URL for intranet front ends. Manual answers always win — detection only fills unknowns.
- **Artifact generator** `protect/templates.ts`: pure per-proxy (caddy/traefik/nginx) × runtime (native/docker) generation — access-log config, acquis snippet with `target_fqdn`, collection installs, real-IP chains (full Cloudflare ranges + `CF-Connecting-IP`/`forwardedHeaders`/`real_ip_header` per proxy), bouncer config, AppSec config, escalating `duration_expr` remediation preset, Compose snippets (docker only) incl. the pinned `caddy-crowdsec-bouncer@v0.14.1` `dockerfile_inline` build. Unknown proxies get a guidance artifact, not a guess.
- **Artifact ledger** `config_artifact`: `not_applied → applied (manual) → verified (by a passing check)`. Regeneration preserves state on unchanged content hashes; changed content resets to `not_applied`; removed kinds are dropped.
- **Verification checks** `protect/checks.ts`: acquisition (attributed alerts = proof), test-alert (marked window → `crowdsecurity/http-generic-test` since-mark lookup; whitelist-aware failure message; unattributed result → `target_fqdn` guidance), decision-feed (sync health + active-decision count), waf (`cs_appsec_*` counters — processed vs blocked), real-ip (private-source heuristic + manual confirm). `markedAt` test windows; worker re-runs the automated set hourly; a verified check promotes its applied artifacts.
- **UI**: `/sites/[id]` guided plan page (topology form + detect + checks with evidence + artifacts with copy blocks and mark-applied), `/protection` sites×checks stamp matrix. Nav/palette updated; `site.added|removed|configured|detected` fan out to notifications.
- **E2E** `e2e/sites.spec.ts` + mock `/_site` (header fixture) and `/_inject` (synthetic alert incl. `http-generic-test` w/ `target_fqdn`).

Verified: `check` 0/0, lint clean, `npm test` 115 (incl. 13 new protect tests: artifact sets per proxy/runtime/CF, hash-stable regeneration, check states + promotion), full `npx playwright test` 34 pass (+7 skipped), screens visually reviewed.

**Wizard** (spec 5.8): `/protection` leads with a resumable 7-step stepper — admin → connect → topology → sites → plan → verify → notifications. Every step's done/current state derives from live rows (`crowdsec_connection` + first sync success, `site.detection`/non-unknown proxy, site count, `config_artifact` presence, per-site all-checks verified/not_applicable, enabled channels), and each step deep-links to its surface (settings/users, settings/crowdsec, sites, site detail, settings/notifications). The connect step shows the `cscli machines add` hint until linked.

**Multi-site e2e** (`e2e/sites.spec.ts` second test): nginx-on-Docker via manual answers + Caddy via probe, one injected alert per fqdn, a pushed manual ban asserted visible on the shared decision feed from both site checklists — the agent-free proxy for phase 4's "ban enforced on both sites" item.

**Bug found by that test:** the mock's `nextDecisionId` restarted at 9100 while `.e2e-data` persists — a pushed decision claimed a stored upstream id, and `replaceDecisions`' `onConflict` only refreshed `until`/`expired`/`alertUpstreamId`, so `reconcile` never matched (request stuck `pushed`). Fixed both sides: mock ids are seeded per-process (`Date.now() % 900000`), and the decision upsert now refreshes `type`/`scope`/`value`/`scenario` too.

**Not yet:** real-proxy end-to-end runs (fixture + reference host), the DOCKER-USER firewall-bouncer check (needs tier D agent on a real host).

## Phase 6 (agent + configuration lifecycle) — done, on `main`

- **Host agent** `server/agent.js` (self-contained Node, also shipped in the Docker image): NDJSON-over-unix-socket, token auth with a 5 s handshake timeout, protocol-1 `hello` (version, capabilities = cscli files services). Write ops are serialized behind a mutex; output is capped (512 KiB) and credential-redacted; execs are argv-only `spawn()` (no shell), 30 s timeout. Scopes: `AGENT_CSCLI` (`local` or `docker:<container>`), `AGENT_FILE_ROOTS` (the only writable paths — resolved+realpath-checked), `AGENT_BACKUP_DIR` (restores confined to it), `AGENT_SERVICES` (only declared `systemd:`/`docker:` reload targets). Ops: `hello`, `machines.list`, `bouncers.list`, `hub.list/install/update`, `allowlists.list`, `allowlist.add/remove`, `simulation.set/status`, `setup.detect`, `explain`, `file.backup/write/restore`, `service.reload`.
- **Dashboard client** `src/lib/server/agent/client.ts`: never throws (all failures → `{ok:false,error}`), 5 s request timeout, `hello` cached 15 s so one `/system` load doesn't round-trip six times. `AGENT_SOCKET`/`AGENT_TOKEN` in `config.ts` (socket defaults `/run/bitdoze-agent.sock`).
- **Durable jobs** `jobs/queue.ts` + `job`/`job_step` (migration `0005`): idempotency keys dedupe _active_ jobs; finished jobs resubmit under a derived `key~suffix` (keeps the index, keeps "Run again" working); `lockKey` serializes same-resource jobs (queued behind the active one); 60 s heartbeat lease + reclaim (3 attempts → failed); step rows resume-skipped on retry; cancel sets `cancel_requested` → honoured at the next step boundary (crashed workers in `cancel_requested` finalize `cancelled` on reclaim); failures notify a `job`-class inbox event (`critical` if rollback failed); worker drains the queue every tick.
- **Runners** `jobs/runners.ts`: `hub.install/update`, `allowlist.add/remove`, `simulation.set`, `config.apply` (backup → write → declared reload → mark artifact `applied` only after success) — runners return rollback step lists (restore backup + reload) and can override job lock/idempotency validation per op.
- **`/system`** (`read`; actions `operate`+): agent stamp (not-configured/unreachable/connected), protocol/version/cscli-mode/file-roots/services, machines + bouncers + hub items, jobs table with step output, Cancel and Run-again controls, audit tail. Nav link is live; `NavItem` typing keeps the `planned` convention.
- **One-click actions:** "Install via agent" on the collections artifact card, "Allowlist via agent" on `/decisions` (validates the current client IP with `normalizeTarget` first), "Apply via agent" on complete-file artifacts with declared `# /path` targets (acquisition only — fragments stay guided). Tier-D row added to the capability table on `/settings/crowdsec`.
- **Tests:** `tests/agent.test.ts` spawns the real agent + stub `cscli`/`docker` on PATH (auth, unknown ops, hub validation, allowlist flows, file scoping incl. traversal + undeclared-service rejection); `tests/jobs.test.ts` (23 cases: queue, leases, reclaim, cancel, rollback, idempotency incl. finished-job resubmit, config.apply happy + denied paths); `e2e/system.spec.ts` (unreachable honesty, live-agent caps/inventory via e2e stub binaries, agent allowlist job lifecycle, managed-apply deny → honest `not_applied`). Mock binaries: `e2e/mock-bin/`.

Verified: `check` 0/0, lint clean, `npm test` 138, `npm run build`, full `npx playwright test` 39 pass (+7 skipped), `/system` + site buttons visually reviewed.

**Not yet (phase 7+):** pre-apply diff preview, `crowdsec -t` native validation step, conflict detection for hand-edited files, `explain`/`setup.detect` UI surfaces, formal agent enrollment (token is shared out-of-band today).

## Phase 7 (Traefik + Docker managed integration) — done, on `main`

- **Agent v0.5.0:** `docker.ps` (read-only `docker ps -a --no-trunc --format '{{json .}}'`), `docker.inspect` (validated container names, `--type container`), `bouncers.add` (`cscli bouncers add <name> -o raw`; deletes + re-issues if the name exists; the raw key is returned only in the immediate op result — never logged or persisted). Docker capability is opt-in via `AGENT_DOCKER=1` or implicit when `AGENT_CSCLI=docker:<container>`; `hello` reports `caps.docker`.
- **Discovery** `src/lib/server/protect/traefik.ts`: parses the `docker.ps` JSONL into a `DockerTopology` — Traefik container (+ whether the `crowdsec-bouncer` plugin appears in its command/labels), CrowdSec container, per-app router labels (`traefik.http.routers.*.rule` Host match + `middlewares` labels), published ports, and site-hostname matching. Containers that are neither Traefik nor CrowdSec count as opted-in apps only when they carry Traefik router labels.
- **Site flow:** "Discover via agent" runs `docker.ps`, stores the topology + `dynamicDir` (default `/etc/traefik/dynamic`) in `site.detection`, audits it. "Adopt Traefik topology" sets `proxy=traefik`/`runtime=docker` and regenerates artifacts.
- **Template split:** the old monolithic Traefik bouncer artifact is now a static-fragment artifact (guided — editing `traefik.yaml` needs a restart) plus a `middleware` artifact: a complete file-provider document at `<dynamicDir>/crowdsec-<host>.yaml` containing the CrowdSec `http.middlewares` block (`<bouncer-key>` placeholder, LAPI host, trusted-proxy CIDRs) and guidance for attaching it via labels or a file-provider router block — Traefik `watch: true` picks it up with no restart. A `demo` artifact emits a standalone compose stack (Traefik + CrowdSec + whoami, guided-only comments).
- **Secret plumbing:** `JobContext.secrets` is in-memory only. `config.apply` with `bouncerName` runs an ephemeral `bouncers.add` step (key → `ctx.secrets.bouncerKey`), substitutes `<bouncer-key>` during the write step, and step detail keeps the placeholder. Ephemeral steps always re-run on resume — a crashed worker re-issues the key rather than reviving it. Rollback locates the backup step by name (`backup …`), not index.
- **Bypass check:** `protect/checks.ts` `bypass` — N/C for non-Docker sites or no docker capability, `stale` when `docker.ps` fails or the site's router isn't found, `failed` with container+port evidence when the routed app publishes host ports, `verified` when it doesn't. `runSiteChecks` runs it alongside acquisition/test_alert/decision_feed/waf; decision-feed verification promotes `middleware` artifacts.
- **Tests:** `tests/traefik.test.ts` (8 cases — parse, plugin detect, router/middleware map, host match, bypass); agent suite gained docker + `bouncers.add` ops; jobs suite gained key-non-leak (step detail keeps `<bouncer-key>`) and crashed-resume key re-issue; `e2e/system.spec.ts` gained 6 cases driving stub `docker`/`cscli` fixtures (`e2e/mock-bin/`): discover → adopt → managed middleware apply with substituted key → bypass check failing on the whoami app publishing `:8080`.

Verified: `check` 0/0, lint clean, `npm test` 154, `npm run build`, full `npx playwright test` 40 pass (+7 skipped), Docker topology module visually reviewed (light theme).

**Not yet:** real-Docker-host validation (container recreation, missing networks, log rotation, router attach on a live stack, reload failure against a real service); `explain`-driven parser checks; the phase-7 acceptance gate (verified detection + shared bans + inline WAF on a real Traefik topology).

## Phase 8 (managed Caddy + Nginx via the same lifecycle) — done, on `main`

- **Agent v0.6.0:** `proxy.validate {proxy: caddy|nginx, target, config?}` — the target must be a declared `AGENT_SERVICES` entry (`systemd:<unit>` runs the binary on the host PATH, `docker:<ctr>` runs `docker exec <ctr> <proxy> -t|validate`). Validators check the _live_ config, which resolves `import`/conf.d includes, so a freshly written managed file is covered. Stub `nginx`/`caddy`/`systemctl` binaries + `docker exec`/`kill` cases live in `e2e/mock-bin/`.
- **`config.apply` gains `validateProxy`/`validateTarget`:** step order is now [key] → backup → write → **validate** → reload; a validate failure fails the job and rolls back (restore + reload) _before_ the reload — the broken config never goes live.
- **Templates:** `PlanInput.confDir` — the site's managed proxy-config dir (default `/etc/nginx/conf.d`, `/etc/caddy/crowdsec`; stored in `detection.confDir` at adoption). Caddy `access_log`/`bouncer` artifacts became complete importable snippet files (`<confDir>/<host>-log.caddy`, `<confDir>/<host>.caddy` — admin adds one `import` line in the site block). Nginx `access_log` became a complete conf.d file (`lua_package_path` + `init_by_lua_block` + global `access_by_lua_block` + `log_format crowdsec`, shared `crowdsec-bouncer.conf` — applying from any site writes equivalent content) and `bouncer` became a complete `/etc/crowdsec/bouncers/crowdsec-nginx-bouncer.conf` with a `<bouncer-key>` placeholder. `appsec` artifacts (`/etc/crowdsec/appsec.yaml`) are managed-eligible too.
- **Adoption gate (spec: explicit adoption of unmanaged resources):** managed writes into proxy-config space — fixed `/etc/{caddy,nginx,traefik}/` roots plus the site's stored `confDir`/`dynamicDir` — require `detection.adopted.proxy === site.proxy` first (new `adoptProxy` action for caddy/nginx; `adoptTraefik` sets it for traefik). CrowdSec-side files need no adoption.
- **Managed apply UI:** the artifact card gains a reload-target `<select>` populated from `agent.caps.services`; proxy-space artifacts show an "adopt to apply" hint until adopted. Docker discovery now also lists caddy/nginx containers.
- **Docs:** `docs/proxies.md` — proxy × capability matrix, version pins, adoption rules, unsupported items (per-site observe mode, captcha flow, Caddy JSON config, native Traefik).
- **Tests:** agent `proxy.validate` cases (docker exec, systemd, custom Caddyfile path, deny + failure); `config.apply` validate-order and validate-fail→rollback (no pre-reload) unit tests; e2e `nginx: adopt → managed conf.d apply validates + reloads` plus the flagged validation-failure path — job row polled via `job.site_id` join on hostname.

Verified: `check` 0/0, lint clean, `npm test` 162, `npm run build`, `e2e/system.spec.ts` 7/7 incl. adopt + apply + validate + reload ordering.

**Not yet:** the two-sites/real-traffic/IPv6/WAF acceptance gate needs real hosts; distro package installs (`apt install libnginx-mod-http-lua`) stay guided deliberately — the agent never installs packages.

## Phase 9 (website operations + policy UX) — done, on `main`

- **Site policy model (migration 0006–0007):** `site.aliases` (JSON array), `wafLevel` (`off`|`1`–`4`, default `1`), `remediationPreset` (`flat`|`escalating`|`captcha`, default `escalating`), `appsecExclusions` (JSON array of hub collection names), `config_artifact.observedHash`/`observedAt`, `saved_view` table.
- **Alias-aware attribution:** `siteIndex` returns `byName` + `ambiguous` — primary hostnames win over other sites' claimed aliases, a name claimed by two sites maps to neither (alert stays unattributed, no learned site minted), `setPolicy` validates aliases (`validateAliases`) and refuses names already owned/aliased elsewhere.
- **WAF levels (spec §5.5):** `WAF_CONFIGS` composes AppSec configs per level; `off` omits the AppSec artifact but keeps detection/bouncer artifacts; level 3 installs `appsec-crs` (out-of-band — alerts without blocking) and level 4 installs `appsec-crs-inband`, gated in `setPolicy` on observed `crowdsecurity/appsec-%` alerts for the site. Per-site exclusion collections render as extra `cscli collections install` lines (`validateCollections` — `author/name` shape).
- **Remediation presets (spec §5.7):** distinct `profiles.yaml` content per preset — flat fixed 4h, escalating `duration_expr` on `GetDecisionsCount`, captcha for low-confidence scenarios with a ban fallback.
- **Drift:** `driftHash` normalizes `<bouncer-key>`/`API_KEY=` values so key substitution never counts as drift; `checkDrift` reads each managed artifact's target via agent `file.read` and stamps `observedHash`/`observedAt`; artifact cards show `in sync`/`drifted` badges + the timestamp.
- **Investigation UX:** site Activity module — recent attributed alerts + the shared `ActivityChart` (lazy `layerchart`, `aria-hidden` with an adjacent `<details>` data table), `actRange` 24h/7d/30d, server-side `downsample()` bucketing (hourly → daily at 30d, ~40 max points), no-data state; `/alerts` saved views (`saved_view` — save/reapply chips/delete, audited) plus `Export CSV` honoring `site`/`scenario`/`ip`; `/decisions` `Export CSV` honoring `q`/`expired` — still server-wide by design.
- **Recovery + themes:** `AuthShell` footer tells locked-out admins to run `npm run recover -- <email>`; header theme toggle cycles system → light → dark (`data-theme` + `localStorage`, pre-paint bootstrap in `app.html` — no FOUC).
- **`/system`:** typed hub inventory (collections/parsers/scenarios), simulation status normalized across `cscli` payload shapes, and durable `simulation.set` jobs — global toggle + per-scenario `simulate`/`un-sim` (idempotency `sim:<scope>:<enabled>`, lock `simulation`). Mock `cscli` grew scenario items + a `SIMULATION_STATE` file so status reflects toggles.
- **Tests:** alias attribution/ambiguity units, WAF-level content + collections + remediation + `driftHash` units, CSV encoder units, one e2e covering alias-attributed AppSec alert → L3→L4 gate → managed apply → drift in-sync → tamper → drifted → scenario simulation toggle.

Verified: `check` 0/0, lint clean, `npm test` 177, `npm run build`, full e2e 42+7 skipped green. All phase-9 checklist items ticked.

**Not yet:** captcha remediation needs bouncers that answer captcha — flagged capability-gated in the artifact. Multi-series charts (legends) don't exist yet; every chart is single-series with a data-table alternative.

## Phase 10 (Cloudflare edge) — core done, on `main`

- **Account model (migration 0008):** `cloudflare_account` (label, `cfAccountId`, `tokenEnc` symmetricEncrypt'd, token status, verified permission groups, list state: `listId`/`listName`/`listOwned`, `listItemCount`, `listDropped`, `lastSync*` fields) + `cloudflare_zone` (account FK, `zoneId`, plan, `selected`, `hostnames` JSON, `action` block|challenge, `ruleId`, `rulesInUse`).
- **API client (`cloudflare/client.ts`):** typed CF v4 envelope, `CfError` carries status/code/Retry-After, injectable `fetch`/`baseUrl`; `CF_API_BASE` env overrides the base (tests/mocks only). Client covers verify/zones/lists CRUD/list-items cursor/bulk update/bulk-op poll/custom-rulesets.
- **Lifecycle (`accounts.ts`):** `connectAccount` verifies first (inactive tokens rejected), encrypts, discovers + upserts zones (operator selections survive re-discovery); `ensureList` adopts a compatible `crowdsec_dash_*` or creates one; `applyZoneRule`/`removeZoneRule` merge into the zone custom-rules ruleset by `ref: crowdsec-dash-edge` (other rules preserved); `uninstallEdge` removes rules before the list — and only deletes lists we own; `disconnectAccount` refuses while managed resources remain.
- **Sync (`edge-sync.ts` + `cloudflare.sync` job):** local-origin decisions only (`crowdsec`, `cscli`, `crowdsec-appsec` — never the blocklist), deduped, capacity-trimmed keeping latest expiries (`listDropped` reports overflow), diffed against live items, one serialized bulk update with 429 retry-after backoff + operation polling; CF items never expire so removals come from the same diff — the list goes stale, not empty, when the dashboard stops. Worker enqueues on new alerts / 15-min reconcile / 2-min debounce; idempotency `edge-sync:<id>`, lock `cloudflare:<id>`.
- **Deviation from spec:** sync reads the local `decision` projection rather than a registered `cscli` bouncer key + `/v1/decisions/stream` — same data, one less credential; the account does not appear in `cscli bouncers list`.
- **UI:** `/edge` nav page — connect form (permission guidance), token stamp + permission chips, decision-list card (item count, owned/adopted, sync state + error, stale badge), zones table (opt-in checkbox, hostname narrowing, block|challenge, rule-installed stamp), sync-now/uninstall/disconnect actions, honest About module (no AppSec at the edge, cache-hit visibility, list-staleness semantics).

Verified: `check` 0/0, `npm test` 190, build, `e2e/edge.spec.ts` green incl. CF-side rule-expression assertions and the bad-token path.

**Not yet:** Worker-bouncer mode (documented only), observe-only rule action, per-route mapping, full real-account lifecycle (token revocation, quota, propagation, adopt-existing-list).

**Partially real-validated** (owner's `CLOUDFLARE_API_TOKEN` wrangler deploy token against their 23-zone account): token verify, zone discovery + plan detection at scale (23 zones, Free vs Pro correct), and the denied-permission path — `GET /accounts/{id}/rules/lists` and the zone custom-rules entrypoint both return CF code 10000, surfaced honestly as TOKEN ERROR + persisted `lastError`, account stays connected, zero writes reached the real account. Remaining gap is a token scoped `Zone:Read` + `Account:Account Filter Lists:Edit` + `Zone:Zone WAF:Edit` on a test zone to run list create → rule → sync → propagation → uninstall for real.

## Phase 11 (notifications + operations) — done, on `main`

- **Notification rules (migration 0009):** `notification.site`, `notification_channel.classes`/`site_ids`/`quiet_start`/`quiet_end`/`digest_minutes`, `app_setting` KV table. Enqueue filters severity → class allowlist → site allowlist (site-less system events pass site filters). Quiet hours (`HH:MM` UTC, may wrap midnight) defer non-critical rows to window end; digests batch pending rows into one send at the interval or a 25-item flood cap, and never sweep quiet-deferred or backing-off rows.
- **Channel UX:** per-row Preview (renders the real outbound payload — destination, headers, body — with every secret value stripped), Send test through the real outbox pipeline, `?edit=` edit form (type locked, blank secrets keep stored values), per-row + bulk failed-delivery retry.
- **Inbox:** 14-day event + failed-delivery `ActivityChart` trends, site hostname in row metadata.
- **Operations on `/system` (`ops.ts`):** component versions (app/Node/CrowdSec/agent), GitHub latest-release check cached in `app_setting` (daily by the worker + manual button; errors displayed, upgrade stays manual), `statfs` disk panel + hourly pressure events (warn <15 %, critical <5 %, dedupe + escalation + recovery), retention policy per data class (daily + manual run, last-run stamp), `VACUUM INTO` backup download (`configure`-gated, audited, keeps 10), redacted support-bundle JSON download, `npm run backup`/`restore` CLI (restore keeps `app.db.restore-bak`).
- **Verified:** backup→restore round-trip on real files; 10 ops + expanded notify unit tests; `e2e/ops.spec.ts` covers rules/preview/edit, ops module + both downloads, trend charts.

### Phase 10 leftovers + Phase 12 verification & release prep (this session)

- **Observe mode + route mapping:** `cloudflare_zone.paths` (migration `0010`) + `action` gains `log`. `ruleExpression()` emits `http.host in {...}` and `starts_with(http.request.uri.path, "...")` clauses; `parsePaths` rejects quotes/backslashes and caps at 16 prefixes ≤128 chars.
- **Worker-bouncer guided mode:** `/edge/worker-bouncer.yaml` (`configure`-gated, audited) emits a deploy-ready Worker+KV YAML with `<cf-token>`/`<bouncer-key>` placeholders, selected zone IDs, and the LAPI URL — secrets are never decrypted or embedded. Fail-closed and quota caveats are in the file header and UI.
- **Resilience drills** `npm run drills` (16 checks): SIGKILL mid-job → 60 s lease reclaim → step-resume; restart preserves outbox/jobs/decisions; WAL-mode concurrent reads under a held write lock; bounded `busy_timeout` failure (never a hang); agent job rollback restores file contents; real `backup.mjs`→`restore.mjs` round-trip incl. post-restore boot.
- **Benchmarks** `npm run bench` → `docs/benchmarks.md`: ~11k alert inserts/s, ~2.6k list queries/s, edge-candidate scan ~82 ms/10k, ~260 req/s warm HTTP. New `decision_edge_idx` (migration `0011`) helps selective scans; it is a no-op on the 100 %-match fixture — documented.
- **Security review — fixed:** CSV formula injection (`csv.ts` prefixes `'` + regression test); shared saved-view create/delete now require `operate` (were viewer-reachable); `restore.mjs` no longer resurrects post-backup rows via stale WAL (checkpoint + atomic rename); post-restore DB normalized to WAL so boot can't race a journal-mode switch.
- **Security review — verified clean:** every action/endpoint permission-gated; SSRF `assertSafeHttpUrl` at save *and* send; `sanitizeRedirectTo` same-origin only; `x-forwarded-*` pinned from `ORIGIN`, XFF only from `TRUSTED_PROXIES`; `resolveSecret` env→`_FILE`→0600-generated; support bundle carries counts/versions/state only; agent refuses to run without a token, no shell, `resolve()`-then-prefix file roots with trailing sep (no `/etc/crowdsec-evil` bypass), allowlisted services, redacted errors; Better Auth DB rate limiting + sign-up disabled + self-lockout guards.
- **Docs:** `docs/acceptance-matrix.md`, `docs/benchmarks.md`, `docs/deployment.md`, `docs/upgrading.md`, `docs/recovery.md`, `docs/compatibility.md`, `CONTRIBUTING.md`, `SECURITY.md`; README links them.
- **Images:** amd64 + arm64 both built via buildx; amd64 run-smoke native (healthz/setup/healthy), arm64 run-smoke under QEMU binfmt (boot, migrations, `/healthz` 200). No per-proxy images ship — proxy coverage is e2e `mock-bin`.
- **Remaining:** real edge lifecycle (needs the scoped CF token, owner action below), real-host proxy matrix (needs the Docker host), release-please tag (owner action 1).

## Actions only the owner can take

1. GitHub → Settings → Actions → General → enable **"Allow GitHub Actions to create and approve pull requests"**. Release-please fails without it (latest Release run: "GitHub Actions is not permitted to create or approve pull requests").
2. Close Dependabot PR #1 (node 25-slim) and PR #3 (@types/node 26). Node majors are now ignored in `.github/dependabot.yml`. Review PR #2 (@libsql/client 0.18.0) once its CI is green.
3. Make the GHCR package `bitdoze-crowdsec-dash` public (GitHub → Packages → package settings) so `docker pull` works without login.
4. Before phase 3 testing against the reference host: approve (or refuse) registering a dashboard watcher machine with `cscli machines add`.

## Next steps, in order

### 1. Release v0.1.0

- All phase-3 code is on `main`. To tag: merge the release-please PR (after owner action 1). Optional but valuable before tagging: reference-host connect (owner action 4 — LAPI/metrics are on 127.0.0.1, so the dashboard needs host networking there).

### 2. Real-host validation, then tag the release candidate

Phase 12 is done except the release-candidate publish (needs owner action 1). Phases 7–11 are on `main` with stub-driven e2e; real validation needs a Docker host with the agent (`AGENT_DOCKER=1`, `AGENT_SERVICES` including the proxy targets) — deploy the demo compose, run adopt→apply→validate→reload per proxy, exercise bypass/recreation/failure paths, walk a site through WAF levels 3→4 against real CRS alerts — plus a Cloudflare token scoped `Zone:Read` + `Account Filter Lists:Edit` + `Zone WAF:Edit` on a **test** zone for the real edge lifecycle (token revocation, quota, propagation delay, adopt-existing-list).

Phase 13 (v1.0.0) is what remains: resolve RC findings, publish the stable release, test RC→stable upgrade + backup restore.

## Gotchas already learned

- **adapter-node 6:** origin handling lives in `server/origin.js`; plain-HTTP form posts fail CSRF without it. Always launch via `node server/index.js` — `node build/index.js` is the raw adapter entry and skips the pinning (403s on every form POST).
- **`defineEnvVars`:** a variable without `schema` is required. `schema: v => v` makes it optional; returning a value sets a default. The `auth` CLI runs through jiti, so `src/lib/server/config.ts` repeats the defaults.
- **Better Auth vs Kit 3:** the peer conflict is solved by `overrides` in `package.json`. The Docker prod-deps stage alone uses `--legacy-peer-deps`, to skip optional peers.
- **drizzle-kit:** `push` needs a TTY; use `npm run db:generate`. Migrations apply at startup.
- **trivy-action:** pinned to v0.36.0, an immutable release after the March 2026 tag-hijack incident. Never pin older trivy-action tags or Trivy 0.69.4–0.69.6.
- **CI shell:** curl's `%{redirect_url}` is absolute. metadata-action `enable` needs literal true/false. The actionlint image tag has no `v` prefix (`rhysd/actionlint:1.7.12`).
- **Firewall bouncer:** on the reference host it only covers INPUT, so Docker-published ports are not protected. This is intentional for the "before" fixture.
- **Kit 3 env module:** `$app/environment` was removed; `browser`/`dev`/`building` live in `$app/env`.
- **Kit 3 typed routes:** `resolve()` from `$app/paths` takes route IDs — the `(app)` group makes the overview `/(app)`, not `/`. ESLint flags bare `goto('/...')` calls; use `resolve()` and `SvelteURLSearchParams`.
- **Playwright storage state:** a test that signs out invalidates the shared session file for later tests in the same run. Keep sign-out last, then restore the state file (see `e2e/overview.spec.ts`); shared constants live in `e2e/helpers.ts`, never import one spec from another.
- **Ctrl+K tests:** press-and-retry until the palette appears — the keydown listener may not be hydrated yet right after `goto`.
- **Kit 3 named actions:** a `default` action cannot coexist with named actions on the same page (POST throws `action_default_with_named`). `/login` uses `signIn`/`verify`/`verifyBackup`.
- **Better Auth rate limit:** `auth.api.*` calls from form actions bypass the HTTP rate limiter — app-level throttling lives in `src/lib/server/throttle.ts`.
- **Job secrets:** secret-producing steps (e.g. `bouncers.add`) must be marked `ephemeral` — they re-run even on resume, otherwise the placeholder reaches the write step literally. Keys live only in `ctx.secrets`, never in `job_step.detail`.
- **Rollback lookup:** never assume the backup step is index 0 — optional key-issuance steps shift it. Find it by `step.name.startsWith('backup ')`.
- **e2e docker fixture:** the agent's docker capability needs `AGENT_DOCKER=1` in the Playwright env _and_ the stub `docker` binary on PATH; `E2E_DOCKER_PS` points the stub at a JSONL fixture.
- **Playwright `newContext` in the test runner** inherits `use` options, including `storageState` — pass `storageState: { cookies: [], origins: [] }` for a truly signed-out context (`freshContext` in `e2e/security.spec.ts`). `browser.newPage()` inherits too.
- **Better Auth API calls from tests** need an explicit `Origin` header (`page.request.post` doesn't send one): `MISSING_OR_NULL_ORIGIN` otherwise.
- **Playwright `reuseExistingServer`:** a killed run can leave its web server alive; the next run then reuses a stale build. Check the port before rerunning.
- **Vite dynamic-import split:** if a module is imported both statically and lazily, Vite bundles it eagerly and warns `INEFFECTIVE_DYNAMIC_IMPORT`. Split constants/light helpers (`map-projection.ts`) from heavy data (`map-geo.ts` holds the world-atlas TopoJSON) so the lazy chunk actually splits.
- **Worker outage/recovery:** read `sync_state.lastError` _before_ running the operation — a successful sync clears it, so reading after always misses the recovery.
- **SSR state across param navigation:** SvelteKit keeps `form` populated when only the route param changes — scope lookup results (`form.x.ip === data.ip`) or IP B shows IP A's answer.
- **E2E `.e2e-data` persists between runs:** tests must be rerunnable — disconnect first when connected, randomize pushed IPs, and clear worker-produced notification keys before asserting outages or old rows create false positives. `SYNC_INTERVAL_MS` shortens the worker tick; mock kills/restarts happen via `/_down`.
- **`svelte/no-navigation-without-resolve`:** `resolve()` is per-route overloaded, so a union `RouteId` won't type-check. For server-generated internal hrefs (notification links, resolved-route + appended query strings), a scoped eslint-disable on a plain `href` is the honest option — but it's an _ESLint_ rule reported on the `href=` line: `svelte-ignore` can't suppress it ("not a recognised code") and `eslint-disable-next-line` only works for single-line anchors; multi-line tags need an `eslint-disable`/`eslint-enable` range.
- **Server-only modules in components:** don't import anything from `#lib/server/*` into `.svelte` files — even `import type` can drag server code into the client graph. Shared shapes go in `src/lib/` (e.g. `notify-channels.ts`) and get re-exported server-side.
- **Dependency age rule:** pin versions ≥7 days old — `nodemailer@^10.0.13`, not the 2-day-old 10.0.16.
- **Outbox backlog starvation:** `dispatchOutbox` takes the 20 _oldest_ pending rows — a persistent `.e2e-data` outbox backlog starves fresh test deliveries (`pending`, no `lastError` → "delivery not attempted"). Purge `notification_outbox`/`notification_channel` in the test before asserting.
- **libsql `close()` is lazy:** closing a WAL connection releases its OS locks/shm read-marks asynchronously (~500 ms). Any immediate `journal_mode` switch on the same file fails `SQLITE_BUSY` — `busy_timeout` does not apply to mode changes. Copy→checkpoint→**rename** instead of truncating in place (`scripts/restore.mjs`).
- **Restoring a WAL database:** copying `app.db` over itself while leaving `app.db-wal` replays the *old* WAL onto the restored file — post-backup writes resurrect. Always remove/replace the `-wal`/`-shm` siblings atomically with the main file.
- **WAL contention is bounded, not fair:** a writer waiting on `busy_timeout` starves rather than queues when another writer holds the lock past the timeout — expect `SQLITE_BUSY` after ~5 s, not eventual success. The drill asserts the honest semantics.
- **Stale e2e servers hold `.e2e-data`:** leftover mock-lapi/mock-cf processes keep 8090/8091 and the DB locked — `SQLITE_BUSY` on the next run's purge. Kill by port before rerunning; `e2eDb()` sets a 10 s busy timeout as backstop.

## How to track progress

When a step lands:

- tick its boxes in spec section 13 (annotate partial items);
- add a dated line to the spec's progress log;
- update the "Done so far" table and "Next steps" in this file;
- commit with a Conventional Commit message.
