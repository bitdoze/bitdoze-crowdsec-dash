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

## Actions only the owner can take

1. GitHub → Settings → Actions → General → enable **"Allow GitHub Actions to create and approve pull requests"**. Release-please fails without it (latest Release run: "GitHub Actions is not permitted to create or approve pull requests").
2. Close Dependabot PR #1 (node 25-slim) and PR #3 (@types/node 26). Node majors are now ignored in `.github/dependabot.yml`. Review PR #2 (@libsql/client 0.18.0) once its CI is green.
3. Make the GHCR package `bitdoze-crowdsec-dash` public (GitHub → Packages → package settings) so `docker pull` works without login.
4. Before phase 3 testing against the reference host: approve (or refuse) registering a dashboard watcher machine with `cscli machines add`.

## Next steps, in order

### 1. Release v0.1.0

- All phase-3 code is on `main`. To tag: merge the release-please PR (after owner action 1). Optional but valuable before tagging: reference-host connect (owner action 4 — LAPI/metrics are on 127.0.0.1, so the dashboard needs host networking there).

### 2. Phase 7 (v0.5.0): first managed integration — Traefik + Docker — spec checklist.

Discover/adopt a Traefik+Docker topology, run phase-5 artifacts through the job lifecycle, attach protection to routers, detect port bypasses, per-router log/parser/client-IP/bouncer/WAF checks on two sites. Needs the agent deployed on a real Docker host.

Later phases (8–13) are fully described in the spec.

## Gotchas already learned

- **adapter-node 6:** origin handling lives in `server/origin.js`; plain-HTTP form posts fail CSRF without it.
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
- **Playwright `newContext` in the test runner** inherits `use` options, including `storageState` — pass `storageState: { cookies: [], origins: [] }` for a truly signed-out context (`freshContext` in `e2e/security.spec.ts`). `browser.newPage()` inherits too.
- **Better Auth API calls from tests** need an explicit `Origin` header (`page.request.post` doesn't send one): `MISSING_OR_NULL_ORIGIN` otherwise.
- **Playwright `reuseExistingServer`:** a killed run can leave its web server alive; the next run then reuses a stale build. Check the port before rerunning.
- **Vite dynamic-import split:** if a module is imported both statically and lazily, Vite bundles it eagerly and warns `INEFFECTIVE_DYNAMIC_IMPORT`. Split constants/light helpers (`map-projection.ts`) from heavy data (`map-geo.ts` holds the world-atlas TopoJSON) so the lazy chunk actually splits.
- **Worker outage/recovery:** read `sync_state.lastError` _before_ running the operation — a successful sync clears it, so reading after always misses the recovery.
- **SSR state across param navigation:** SvelteKit keeps `form` populated when only the route param changes — scope lookup results (`form.x.ip === data.ip`) or IP B shows IP A's answer.
- **E2E `.e2e-data` persists between runs:** tests must be rerunnable — disconnect first when connected, randomize pushed IPs, and clear worker-produced notification keys before asserting outages or old rows create false positives. `SYNC_INTERVAL_MS` shortens the worker tick; mock kills/restarts happen via `/_down`.
- **`svelte/no-navigation-without-resolve`:** `resolve()` is per-route overloaded, so a union `RouteId` won't type-check. For server-generated arbitrary internal hrefs (notification links), a scoped `eslint-disable-next-line` on a plain `href` is the honest option.
- **Server-only modules in components:** don't import anything from `#lib/server/*` into `.svelte` files — even `import type` can drag server code into the client graph. Shared shapes go in `src/lib/` (e.g. `notify-channels.ts`) and get re-exported server-side.
- **Dependency age rule:** pin versions ≥7 days old — `nodemailer@^10.0.13`, not the 2-day-old 10.0.16.

## How to track progress

When a step lands:

- tick its boxes in spec section 13 (annotate partial items);
- add a dated line to the spec's progress log;
- update the "Done so far" table and "Next steps" in this file;
- commit with a Conventional Commit message.
