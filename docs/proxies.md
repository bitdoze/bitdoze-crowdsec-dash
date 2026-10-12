# Proxy support matrix

What the dashboard can manage per proxy and runtime, and where the gaps are.
"Managed" means the artifact is a complete file applied through the host agent
(backup → write → validate → reload); "guided" means the artifact is a fragment
the administrator merges by hand and confirms via verification checks.

| Capability                      | Traefik (Docker)                                    | Caddy (Docker)                                       | Caddy (native)                    | Nginx (Docker)                                  | Nginx (native)                                  |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| Access-log acquisition          | guided static config                                | managed snippet + 1 `import` line                    | managed snippet + 1 `import` line | managed conf.d + per-site `access_log` line     | managed conf.d + per-site `access_log` line     |
| Decision enforcement (bouncer)  | managed middleware file (`crowdsec-bouncer` plugin) | managed global-options file + pinned module build    | managed global file + `xcaddy`    | `crowdsec-nginx-bouncer` package + bouncer conf | `crowdsec-nginx-bouncer` package + bouncer conf |
| Inline WAF (AppSec)             | `crowdsecAppsecEnabled` flag in middleware          | `appsec_url` (global) + `appsec` directive per site  | same                              | `APPSEC_URL` in bouncer conf                    | `APPSEC_URL` in bouncer conf                    |
| Real-IP chain                   | `trustedIPs` on entrypoints (guided fragment)       | `servers` global option (guided)                     | `servers` global option (guided)  | `set_real_ip_from` chains (guided)              | `set_real_ip_from` chains (guided)              |
| Native validation before reload | n/a (file provider live-reloads)                    | `caddy validate` via `proxy.validate`                | same                              | `nginx -t` via `proxy.validate`                 | same                                            |
| Reload                          | not needed (`watch: true`)                          | `docker kill -s HUP` / `systemctl reload-or-restart` | same                              | same                                            | same                                            |
| Direct-port bypass detection    | yes — published ports on routed apps flag `failed`  | n/a (no router model discovered)                     | n/a                               | n/a                                             | n/a                                             |
| Demo stack                      | generated compose (Traefik+ CrowdSec + labeled app) | compose labels + pinned build                        | —                                 | compose mounts + recipe                         | —                                               |

## Version pins

| Component              | Pin                                                                                    | Notes                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Traefik                | `traefik:v3.4`                                                                         | file provider `watch: true` required for managed middleware                                 |
| Traefik bouncer plugin | `crowdsec-bouncer-traefik-plugin` `v1.7.1`                                             | declared via `experimental.plugins`                                                         |
| Caddy                  | `caddy:2` base + `caddy-crowdsec-bouncer/{http,appsec}@v0.14.1`                        | stock image lacks the module — pinned `xcaddy` build in the Compose artifact                |
| Nginx                  | `crowdsec-nginx-bouncer` package (or OpenResty manual install)                         | enforcement lives in the package's `crowdsec_nginx.conf`; we only write `log_format`        |
| CrowdSec               | `crowdsecurity/crowdsec:latest` in compose; ≥1.7 required for the LAPI allowlist check | AppSec service needs `appsec.yaml` + matching `appsec_configs` and rule collections (below) |

## Caddy AppSec details

`appsec` is a **separate site directive**, not implied by `appsec_url`: the
global `crowdsec {}` block only configures the endpoint, and without `appsec`
inside the site block Caddy never forwards requests to the engine — a WAF
that looks configured but inspects nothing. `appsec` is unordered, so the
global options file must also carry `order appsec after crowdsec` (the
generated global artifact emits it). `appsec_url` and the site `appsec`
directive are commented as a pair in the artifacts — enable them together or
`caddy validate` fails for every site.

On the engine side, every entry in `appsec_configs` merges into one ruleset:
listing two configs whose rule patterns overlap (e.g. `virtual-patching`,
which is a subset of `appsec-default`) duplicates rule ids and the engine
refuses to load. A config whose patterns match no installed rule fails too —
the generated per-level `cscli collections install` lines pair each config
with the rule collections it needs.

## Adoption rules

Managed applies only ever write **new files** under the agent's declared file
roots — existing Caddyfiles, nginx.conf, site blocks, and profiles are never
edited. Writes into proxy-config space (`/etc/caddy`, `/etc/nginx`, the Traefik
dynamic dir, or a site's adopted config dir) additionally require explicit
adoption on the site page. CrowdSec-side files (`acquis.d`, `appsec.yaml`,
bouncer confs) do not need adoption — they are additive and backup-rolled-back
like everything else.

## Unsupported today

- **Captcha/turnstile remediation** — the bouncer integrations support it but
  there is no managed challenge-page flow yet; bans only.
- **Observe-only bouncer mode per site** — simulation mode is global (`cscli
simulation`), not per-site WAF policy. Per-site levels land in phase 9.
- **Caddy JSON config** — artifacts are Caddyfile snippets only.
- **Traefik native installs** — discovery assumes a Docker inventory; a native
  Traefik can still apply the same artifacts guided-style.
- **Nginx `stream` blocks / TCP services** — HTTP only.
