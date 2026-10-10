# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Email
**security@bitdoze.com** with:

- affected version / commit,
- reproduction steps or proof of concept,
- impact assessment if known.

We aim to acknowledge within 72 hours and will coordinate disclosure with
you. If the channel above ever becomes unavailable, a GitHub private
security advisory on this repository is an acceptable fallback.

## Scope

This is a self-hosted admin dashboard; its threat model assumes the operator
controls the host but attackers may control data flowing through CrowdSec
(alert messages, scenarios, hostnames) and may reach the dashboard's HTTP
surface unauthenticated.

## Security model

Enforced boundaries (each verified by tests or review — see
`docs/acceptance-matrix.md`):

- **Authentication & roles.** Every protected route and form action checks a
  server-side permission (`read` / `operate` / `configure`); UI hiding is
  never the control. Sign-up is disabled; first admin comes from a one-time
  setup token. Login is rate-limited (DB-backed) and supports TOTP 2FA.
- **Secrets.** Cloudflare tokens, notification credentials, and bouncer keys
  are stored encrypted (`*Enc` columns) or generated under
  `DATA_DIR/secrets/` mode 0600. Support bundles, delivery previews, job
  results, and the worker-bouncer YAML never contain them.
- **SSRF.** Notification endpoints and any outbound URL are validated
  (`http(s)` only; loopback, link-local, metadata, and unspecified addresses
  blocked) at save _and_ send time. Private LAN destinations are allowed —
  legitimate self-hosted webhooks — so treat channel configuration as a
  trusted operation (`configure` role).
- **Trusted headers.** `x-forwarded-proto`/`x-forwarded-host` are pinned from
  `ORIGIN`, never taken from clients. `x-forwarded-for` is honored only from
  `TRUSTED_PROXIES`; otherwise the socket address wins.
- **Host agent.** The agent refuses to run without `AGENT_TOKEN`, executes
  nothing through a shell, restricts file ops to resolved paths under
  `AGENT_FILE_ROOTS` (unset = denied), allowlists reloadable services, and
  redacts credential-looking strings from error output.
- **Exports.** CSV cells are formula-injection-neutralized and fully quoted;
  the support bundle contains counts/versions/state only.
- **Input validation.** All job params and form inputs are validated
  server-side before reaching the agent or external APIs; Cloudflare rule
  expressions are generated, never user-templated.

## Hardening checklist for operators

- Serve over HTTPS with a correct `ORIGIN`; set `TRUSTED_PROXIES` to your
  proxy only.
- Never set `DEMO_FIXTURES=true` in production.
- Bind the app to localhost or a private interface where possible.
- Grant the Cloudflare token only the three documented scopes, ideally
  scoped to the zones you will manage.
- Keep `DATA_DIR` backed up and on a POSIX filesystem (no NFS/SMB).
