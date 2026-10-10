# Acceptance matrix (Phase 12)

How each shipped capability is verified. Evidence types:

- **unit** — `npm test` (Vitest), `tests/`
- **e2e** — `npx playwright test` against the real built app + mock LAPI/CF/agent
- **drill** — `npm run drills` (real process kill/restart, real sqlite contention)
- **bench** — `npm run bench` (query/ingest microbenchmarks)
- **manual** — exercised against a live host/service during development
- **needs-env** — requires hardware/services we don't have here (real Traefik/Nginx host, scoped CF token, arm64 runner); honest gap, not a failure

Legend: ✅ verified · ⚠️ partially · ⛔ not yet (needs-env)

## Authentication and permissions

| Capability                                       | Method                                         | Expected                                           | Status |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------- | ------ |
| First-run setup via one-time token               | e2e `auth.setup`, manual                       | Admin created once; token stops working            | ✅     |
| Login/logout/session                             | e2e, unit (`throttle`)                         | Session issued; throttling after failures          | ✅     |
| Role enforcement on every protected route/action | unit + audit of `requirePermission` call sites | `viewer`/`operator`/`admin` gates; viewer gets 403 | ✅     |
| Recovery path for locked-out admin               | `npm run recover`, manual                      | Password reset via CLI only                        | ✅     |
| Unauthenticated access                           | e2e `security.spec`                            | Redirect to /login; no data in responses           | ✅     |

## CrowdSec connection and sync

| Capability                                   | Method                           | Expected                                            | Status |
| -------------------------------------------- | -------------------------------- | --------------------------------------------------- | ------ |
| Connect to LAPI (credentials + machine auth) | e2e `crowdsec.spec` vs mock-lapi | Connected state; encrypted creds                    | ✅     |
| Honest disconnected/degraded state           | e2e + unit                       | Banner + sync_state error; nothing faked            | ✅     |
| Alert sync with cursor + dedupe              | unit `sync`, e2e                 | Incremental; bounded backfill                       | ✅     |
| Metrics scrape                               | e2e, unit                        | Whitelisted counters only; errors recorded          | ✅     |
| LAPI outage → recovery                       | drill + e2e outage test          | Outage event → recovery event; worker keeps ticking | ✅     |
| Decision sync (incl. expiry reconciliation)  | unit, e2e `decisions.spec`       | Projection matches upstream; expiries clear         | ✅     |
| Manual decision request lifecycle            | e2e                              | requested → pushed → confirmed → removed            | ✅     |

## Site discovery and attribution

| Capability                                                 | Method                                 | Expected                                                   | Status                              |
| ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- | ----------------------------------- |
| Discovery from Caddy/Nginx/Traefik + Docker/native         | e2e with mock binaries; partial manual | Sites appear with detected proxy/runtime                   | ⚠️ real proxy hosts not tested here |
| Alert→site attribution (context → event meta → datasource) | unit `siteIndex`, e2e                  | Real hostname wins; ambiguous aliases attribute to neither | ✅                                  |
| Manual site + alias management                             | e2e `sites.spec`                       | Collision refused server-side                              | ✅                                  |
| Learned-site minting                                       | unit                                   | Only from unambiguous signals                              | ✅                                  |

## WAF/AppSec and protection checks

| Capability                                                  | Method                 | Expected                                | Status                                   |
| ----------------------------------------------------------- | ---------------------- | --------------------------------------- | ---------------------------------------- |
| WAF levels 1–4 + off                                        | unit `waf.ts`, e2e     | Correct hub items + artifacts per level | ✅                                       |
| L4 inband requires observed AppSec alerts                   | unit, e2e              | Gate enforced server-side; honest error | ✅                                       |
| Remediation presets (flat/escalating/captcha)               | unit, artifact content | profiles.yaml content correct           | ✅                                       |
| Protection checks (acquisition/decision/waf/real-ip/bypass) | e2e + unit `checks`    | Evidence recorded; honest failures      | ⚠️ on-host probes need a real agent host |
| Drift detection + observed hash                             | e2e                    | `in sync` → `drifted` on tamper         | ✅                                       |
| Docker direct-port bypass detection                         | e2e                    | Check flags bypass                      | ⚠️ mock docker only                      |

## Notifications

| Capability                                         | Method                                      | Expected                                          | Status |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ------ |
| Class/severity/site filters                        | unit `notify.test`, e2e `ops.spec`          | Non-matching events don't enqueue                 | ✅     |
| Quiet hours (incl. wrap-midnight, critical bypass) | unit                                        | Deferred to window end; critical goes now         | ✅     |
| Digest batching + flood cap                        | unit                                        | Batched per interval or at 25                     | ✅     |
| At-least-once delivery + bounded retries           | unit, drill                                 | 5 attempts, backoff, `failed` honest              | ✅     |
| Redacted preview + secrets never leaked            | unit, e2e                                   | Preview shows shape, `•••` secrets                | ✅     |
| Webhook delivery survives crash                    | drill                                       | Pending outbox delivers after restart             | ✅     |
| SSRF boundaries on delivery                        | unit (`assertSafeHttpUrl`), send-time check | Loopback/link-local/metadata refused; LAN allowed | ✅     |
| Failed-delivery UI + manual retry                  | e2e                                         | `failed` visible; retry re-queues                 | ✅     |

## Cloudflare edge

| Capability                                           | Method                             | Expected                                                            | Status                                                                        |
| ---------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Token verify + permission display                    | e2e mock-cf, **real account**      | Active/error badge; perms listed                                    | ✅ (real: verified, perms read)                                               |
| Zone discovery (23 zones on real account)            | real account                       | All zones listed w/ plans                                           | ✅ real                                                                       |
| IP list adopt-or-create + capacity trim              | e2e, unit `sync.test`              | `crowdsec_dash_*` adopted or created                                | ⚠️ real token lacked list scope (error surfaced honestly — verified behavior) |
| Zone rule: block / challenge / observe (`log`)       | e2e, unit                          | CF rule action persisted; observe records without blocking          | ✅                                                                            |
| Hostname + path narrowing                            | e2e, unit                          | `http.host in {}` + `starts_with(...)`; quotes/backslashes rejected | ✅                                                                            |
| Serialized durable `cloudflare.sync`                 | e2e, drill (reclaim)               | One per account; diffs live state                                   | ✅                                                                            |
| Uninstall: rules before owned list; adopted retained | e2e                                | Order enforced; adopted lists kept                                  | ✅                                                                            |
| Partial failure rollback                             | unit + e2e (404-tolerant teardown) | No unowned resource deleted; state honest                           | ✅                                                                            |
| Worker-bouncer artifact                              | e2e (download test)                | YAML with placeholders, no secrets, caveats                         | ✅                                                                            |
| **Real-account full lifecycle**                      | manual                             | list+rule+sync+uninstall on a real zone                             | ⛔ needs CF token with Filter Lists + Zone WAF scopes                         |

## Operations

| Capability                                    | Method               | Expected                                                              | Status |
| --------------------------------------------- | -------------------- | --------------------------------------------------------------------- | ------ |
| Component versions + update check             | unit, e2e `ops.spec` | Versions listed; release check cached; error honest                   | ✅     |
| Retention policies + cleanup                  | unit, e2e            | Per-class TTL; manual run; last-run stamp                             | ✅     |
| Disk pressure (warn <15%, crit <5%)           | unit `evaluateDisk`  | Dedupe while active; escalation replaces marker                       | ✅     |
| Backup download + script                      | e2e, drill, manual   | `VACUUM INTO` consistent file                                         | ✅     |
| Restore script                                | drill + manual       | WAL folded, stale wal/shm removed, atomic swap, app boots restored db | ✅     |
| Support bundle (redacted)                     | e2e + code audit     | Counts/versions/state only; no secrets                                | ✅     |
| Durable jobs (claim, lease, cancel, rollback) | unit + drill         | Resume skips done steps; expired lease reclaimed                      | ✅     |
| Worker restart survival                       | drill                | SIGKILL → reboot → outbox delivers, jobs finish, rows intact          | ✅     |
| DB contention                                 | drill                | WAL reads unaffected; bounded SQLITE_BUSY; recovery clean             | ✅     |

## Agent API & MCP

| Capability                                        | Method            | Expected                                           | Status |
| ------------------------------------------------- | ----------------- | -------------------------------------------------- | ------ |
| Key mint/list/revoke (Settings)                   | e2e `api.spec`    | Raw key shown once; sha256 only stored             | ✅     |
| Bearer auth on `/api/v1` + `/mcp`                 | e2e + unit        | 401 missing/invalid/revoked; banned owner rejected | ✅     |
| Scope enforcement (read key cannot ban)           | e2e + unit        | 403 REST / `isError` MCP                           | ✅     |
| Role cap (viewer key never operates)              | unit              | Effective scope downgraded live                    | ✅     |
| REST reads (status/alerts/decisions/sites/lookup) | e2e               | JSON data, filters honored                         | ✅     |
| Ban via API → synced projection readable via MCP  | e2e               | `requested` → visible in list_decisions            | ✅     |
| MCP handshake/tools/list/tools/call               | e2e               | JSON-RPC 2.0, protocol echo, batch support         | ✅     |
| Rate limiting                                     | in-memory limiter | 120/min per key, 30/min anon IP                    | ✅     |
| `GET /api/v1` + `GET /mcp` discovery              | e2e               | Public docs; no secrets                            | ✅     |

## Security surfaces

| Capability                                | Method                  | Expected                                          | Status |
| ----------------------------------------- | ----------------------- | ------------------------------------------------- | ------ |
| Secrets encrypted at rest                 | unit + audit            | secretEnc columns only; placeholders in artifacts | ✅     |
| Support bundle/export redaction           | e2e + audit             | No tokens/keys/secretEnc anywhere                 | ✅     |
| Proxy-header trust (XFF/CF-Connecting-IP) | unit `origin.js` + docs | Only from `TRUSTED_PROXIES`; else ignored         | ✅     |
| Exported CSV/JSON permissions             | audit                   | Same permission as viewing page                   | ✅     |

## Environment-limited (do not claim)

| Capability                                    | Status                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------- |
| Real Traefik/Nginx/Caddy host lifecycle       | ⛔ e2e uses mock binaries; real-host pass pending                                     |
| arm64 image **runtime**                       | ✅ boot/healthz/setup verified under QEMU binfmt; not tested on native arm64 hardware |
| Full real CF lifecycle                        | ⛔ token scope gap (see above)                                                        |
| Production-scale (>10k decisions, >100 sites) | ⛔ bench fixture scale only — see benchmarks.md                                       |
