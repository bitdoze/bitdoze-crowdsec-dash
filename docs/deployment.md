# Deployment

Bitdoze CrowdSec Dash is a single process: a SvelteKit app plus an embedded
worker that polls CrowdSec and drains the durable job queue. SQLite (WAL mode)
is the only datastore — no external services are required.

## Topologies

| #   | Topology                                                                   | Status                                                    |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| A   | Dashboard on the CrowdSec host, LAPI on `localhost`                        | Supported                                                 |
| B   | Dashboard in Docker, LAPI on host or another container                     | Supported                                                 |
| C   | Dashboard managing a remote CrowdSec over HTTPS LAPI                       | Supported                                                 |
| D   | Host agent (`server/agent.js`) for config writes, allowlists, bouncer keys | Supported, optional                                       |
| E   | Cloudflare edge enforcement (account IP list + zone WAF rules)             | Supported, optional                                       |
| F   | Worker-bouncer edge mode (Cloudflare Worker + KV)                          | Advanced; config artifact provided, bring-your-own deploy |

The dashboard is never in the website request path. Every enforcement path
(bouncer config, AppSec, Cloudflare rules) lives in CrowdSec or Cloudflare —
the dashboard only writes configuration there.

## Process requirements

- Node.js >= 22.17 (`.nvmrc` pins 24), or the container image.
- ~256 MB RAM in steady state; more during large first syncs.
- Persistent `DATA_DIR` — holds `app.db`, generated secrets, and backups.
- Network access to the CrowdSec LAPI (default `http://127.0.0.1:8080`).

## Environment variables

| Variable                       | Default                   | Purpose                                                                                                                       |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ORIGIN`                       | `http://localhost:5173`   | Public origin. **Required in production** — pins request origin (adapter-node cannot derive it) and is Better Auth's baseURL. |
| `DATA_DIR`                     | `./data`                  | SQLite DB, `secrets/`, `backups/`.                                                                                            |
| `DATABASE_URL`                 | `file:${DATA_DIR}/app.db` | libSQL connection string.                                                                                                     |
| `BETTER_AUTH_SECRET`           | generated                 | Session signing key; generated to `DATA_DIR/secrets/better-auth-secret` (mode 0600) when unset. `_FILE` variant supported.    |
| `SETUP_TOKEN`                  | generated                 | Fixed first-run admin token; otherwise a one-time token is logged at startup.                                                 |
| `TRUSTED_PROXIES`              | unset                     | Proxy IPs allowed to set `x-forwarded-for`, or `*` only when never reachable directly.                                        |
| `MIGRATIONS_DIR`               | `./drizzle`               | Migration files applied at startup.                                                                                           |
| `SYNC_INTERVAL_MS`             | `30000`                   | Worker tick interval (alert/decision sync, outbox, jobs).                                                                     |
| `AGENT_SOCKET` / `AGENT_TOKEN` | unset                     | Host agent socket + shared token (`_FILE` supported).                                                                         |
| `DEMO_FIXTURES`                | unset                     | `true` serves labeled fixture data — **never in production**.                                                                 |
| `CF_API_BASE`                  | Cloudflare v4             | Test-only override for the Cloudflare API base.                                                                               |

## Reverse proxy

The app binds the address you choose; put TLS termination in front of it.

- Set `ORIGIN` to the public URL (`https://dash.example.com`) — this is what
  makes CSRF/origin checks work, not forwarded headers. The server rewrites
  `x-forwarded-proto`/`x-forwarded-host` from `ORIGIN`, so client-supplied
  values never reach the app.
- Set `TRUSTED_PROXIES` to your proxy's IP so client IPs resolve honestly.
- Proxy `Upgrade`/WebSocket headers are not needed — the app is plain HTTP.

## Docker

```sh
docker run -d --name csdash \
  -p 127.0.0.1:3000:3000 \
  -e ORIGIN=https://dash.example.com \
  -v csdash-data:/data \
  ghcr.io/bitdoze/bitdoze-crowdsec-dash:latest
```

Published tags: `edge` (main), `X.Y.Z` / `X.Y` / `latest` (releases),
`sha-<commit>`. Multi-arch: `linux/amd64`, `linux/arm64`.

`compose.yaml` runs the same image with a named volume.

## Host agent (topology D)

`server/agent.js` is a dependency-free Node daemon speaking newline-JSON over a
Unix socket. It is the only component that mutates host state, and it is
opt-in: without `AGENT_SOCKET`/`AGENT_TOKEN` the dashboard is read-only plus
LAPI calls.

```sh
AGENT_TOKEN=<shared-secret> \
AGENT_CSCLI=local \
AGENT_FILE_ROOTS=/etc/crowdsec:/etc/caddy \
AGENT_SERVICES=crowdsec,caddy \
node server/agent.js
```

Agent variables:

| Variable           | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `AGENT_SOCKET`     | Socket path (default `/run/bitdoze-agent.sock`).                 |
| `AGENT_TOKEN`      | **Required** — refuses to listen without it.                     |
| `AGENT_CSCLI`      | `local` or `docker:<container>` — the only two cscli paths.      |
| `AGENT_FILE_ROOTS` | Colon-separated writable roots; **unset = all file ops denied**. |
| `AGENT_SERVICES`   | Services `service.reload`/`proxy.validate` may touch.            |
| `AGENT_DOCKER`     | `1` enables read-only container discovery.                       |

Everything destructive runs through durable jobs with per-step rollback —
see `docs/recovery.md`.

## Cloudflare edge (topology E)

Connect a token on `/edge` with scopes `Zone → Zone → Read`,
`Account → Account Filter Lists → Edit`, `Zone → Zone WAF → Edit`. The app
adopts or creates a `crowdsec_dash_*` IP list and one managed custom rule per
selected zone (ref `crowdsec-dash-edge`), scoped to local-origin decisions —
the community blocklist is never pushed (free-plan capacity).

Worker-bouncer mode (topology F) is a downloadable YAML artifact from `/edge`
with `<cf-token>`/`<bouncer-key>` placeholders — secrets are never embedded.
It is fail-closed by design and marked advanced in the UI.
