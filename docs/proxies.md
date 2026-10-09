# Proxy support matrix

What the dashboard can manage per proxy and runtime, and where the gaps are.
"Managed" means the artifact is a complete file applied through the host agent
(backup → write → validate → reload); "guided" means the artifact is a fragment
the administrator merges by hand and confirms via verification checks.

| Capability                      | Traefik (Docker)                                    | Caddy (Docker)                                       | Caddy (native)                    | Nginx (Docker)                              | Nginx (native)                              |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Access-log acquisition          | guided static config                                | managed snippet + 1 `import` line                    | managed snippet + 1 `import` line | managed conf.d + per-site `access_log` line | managed conf.d + per-site `access_log` line |
| Decision enforcement (bouncer)  | managed middleware file (`crowdsec-bouncer` plugin) | managed snippet + pinned module build                | managed snippet + `xcaddy` build  | managed conf.d Lua hook + bouncer conf      | managed conf.d Lua hook + bouncer conf      |
| Inline WAF (AppSec)             | `crowdsecAppsecEnabled` flag in middleware          | `appsec_url` in snippet                              | `appsec_url` in snippet           | `APPSEC_URL` in bouncer conf                | `APPSEC_URL` in bouncer conf                |
| Real-IP chain                   | `trustedIPs` on entrypoints (guided fragment)       | `trusted_proxies` in site block (guided)             | `trusted_proxies` (guided)        | `set_real_ip_from` chains (guided)          | `set_real_ip_from` chains (guided)          |
| Native validation before reload | n/a (file provider live-reloads)                    | `caddy validate` via `proxy.validate`                | same                              | `nginx -t` via `proxy.validate`             | same                                        |
| Reload                          | not needed (`watch: true`)                          | `docker kill -s HUP` / `systemctl reload-or-restart` | same                              | same                                        | same                                        |
| Direct-port bypass detection    | yes — published ports on routed apps flag `failed`  | n/a (no router model discovered)                     | n/a                               | n/a                                         | n/a                                         |
| Demo stack                      | generated compose (Traefik+ CrowdSec + labeled app) | compose labels + pinned build                        | —                                 | compose mounts + recipe                     | —                                           |

## Version pins

| Component              | Pin                                                                                           | Notes                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Traefik                | `traefik:v3.4`                                                                                | file provider `watch: true` required for managed middleware                          |
| Traefik bouncer plugin | `crowdsec-bouncer-traefik-plugin` `v1.7.1`                                                    | declared via `experimental.plugins`                                                  |
| Caddy                  | `caddy:2` base + `caddy-crowdsec-bouncer@v0.14.1`                                             | stock image lacks the module — pinned `xcaddy` build in the Compose artifact         |
| Nginx                  | stock `nginx` + `libnginx-mod-http-lua` (Debian/Ubuntu) or OpenResty + `cs-openresty-bouncer` | conf.d approach assumes the stock `include /etc/nginx/conf.d/*.conf` inside `http{}` |
| CrowdSec               | `crowdsecurity/crowdsec:latest` in compose; ≥1.7 required for the LAPI allowlist check        | AppSec service needs `appsec.yaml` + the `appsec-default`/`virtual-patching` configs |

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
