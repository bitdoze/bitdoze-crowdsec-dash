# AGENTS.md

Start with `HANDOFF.md`: current state, owner decisions, and the next steps in order.

## Commands

- `npm ci` — install (clean install must pass; no `--legacy-peer-deps`)
- `npm run dev` — dev server
- `npm run check` — `svelte-kit sync` + `svelte-check`
- `npm run lint` — `prettier --check . && eslint .` (run `npm run format` to fix)
- `npm test` — `vitest run` (tests in `tests/`, no network)
- `npm run test:e2e` — Playwright against a built production server (auto-builds; uses `.e2e-data`, resets it per run). A mock CrowdSec LAPI (`e2e/mock-lapi.mjs`, port 8090, `/_down?set=1` toggles a 503 outage) starts alongside.
- `SCREENSHOTS=1 npm run test:e2e` — also captures light/dark × desktop/mobile PNGs to `.impeccable/review/` (gitignored)
- `node scripts/contrast-report.mjs` — WCAG contrast audit of the `layout.css` tokens (exits 1 on failure)
- `npm run build` — adapter-node build into `build/`
- `ORIGIN=http://localhost:3000 npm start` — production server (`server/index.js`)
- `npm run db:generate` — emit a migration into `drizzle/` from `src/lib/server/db/schema.ts`
- `npm run db:migrate` / `npm run db:studio` — drizzle-kit utilities
- `npm run auth:schema` — regenerate `src/lib/server/db/auth.schema.ts` from `auth.ts` (run after changing Better Auth options/plugins, then `db:generate`)
- `npm run recover -- <email>` — emergency account recovery against `DATA_DIR`: resets the password (prints it once), clears 2FA, sessions, ban, and login throttle
- `node server/agent.js` — host agent (tier D). Env: `AGENT_SOCKET` (default `/run/bitdoze-agent.sock`), `AGENT_TOKEN` (required to do anything), `AGENT_CSCLI` (`local` or `docker:<container>`), `AGENT_FILE_ROOTS` (colon-separated writable roots), `AGENT_BACKUP_DIR`, `AGENT_SERVICES` (comma-separated `systemd:<unit>`/`docker:<container>` reload targets). Point the dashboard at it with `AGENT_SOCKET` + `AGENT_TOKEN` in its env. See the commented `agent` service in `compose.yaml`.

## Conventions

- SvelteKit 3, Svelte 5 runes. There is **no `svelte.config.js`** — the
  `sveltekit()` Vite plugin options in `vite.config.ts` carry the adapter and
  compiler options.
- Env vars are declared in `src/env.ts` via `defineEnvVars` and read through
  `$app/env/private` (server-only). A `schema` function returning a value
  provides a default; returning `undefined` marks the variable optional.
  Outside the Vite plugin (e.g. the `auth` CLI via jiti) defaults are **not**
  applied — `src/lib/server/config.ts` repeats them.
- Imports use `#lib/...` (package.json `imports` map) with explicit `.ts`
  extensions.
- `npm ci` must keep working. The `better-auth` → `@sveltejs/kit ^2` optional
  peer conflict is solved by the `overrides` block in `package.json`; do not
  reach for `--legacy-peer-deps`.
- Database: local libSQL/SQLite. Migrations live in `drizzle/` (committed) and
  are applied at startup from the server `init` hook in `src/hooks.server.ts`.
  `drizzle-kit push` needs a TTY — use `db:generate` instead.
- Origin handling: adapter-node 6 ignores `ORIGIN` and defaults request
  protocol to `https`. `server/index.js` + `server/origin.js` pin the origin
  from `ORIGIN` by rewriting `x-forwarded-proto`/`x-forwarded-host` before the
  handler sees them. Form POSTs with a mismatched `Origin` header are rejected
  by SvelteKit CSRF protection. `TRUSTED_PROXIES` (comma-separated IPs, or
  `*` when the process can only be reached through the proxy) controls which
  peers may supply `x-forwarded-for`; otherwise the socket peer is the client.
- Auth: Better Auth email/password only; public sign-up is disabled
  (`disableSignUp` + `disabledPaths`). First admin is created on `/setup` with
  a one-time token logged once at startup (or `SETUP_TOKEN`). Roles
  `admin`/`operator`/`viewer` via the `admin` plugin's access control
  (`viewer` default); `requireUser`/`requirePermission` in
  `src/lib/server/roles.ts` guard every server load/action — direct
  `auth.api.*` calls bypass BA's rate limiter, so login throttling is
  application-level (`src/lib/server/throttle.ts`). Two-factor (TOTP +
  recovery codes) makes `/login` a two-step flow — remember Kit forbids a
  `default` action alongside named actions.
- Secrets: `resolveSecret(name)` in `src/lib/server/secrets.ts` — env var,
  `<NAME>_FILE`, or a generated value persisted under `DATA_DIR/secrets/` with
  mode 0600. Never log secret values (the setup token is the single allowed
  exception, logged once at startup).
- UI: "Inspection Record" design system — tokens in `src/routes/layout.css`,
  components in `src/lib/components/` (Bits UI + Lucide + LayerChart; no shadcn
  CLI). `DESIGN.md` is the system record; `.impeccable/surfaces/` holds the
  binding surface briefs. Use `resolve()` from `$app/paths` for navigation —
  route IDs include the group (`/(app)`). `browser`/`dev` come from `$app/env`.
- Demo data: overview fixtures live in `src/lib/overview/`; served only in dev
  or with `DEMO_FIXTURES=true` + `?fixture=before|mixed`. Never fabricate live
  data elsewhere.
- Track progress by ticking the phase checklists in section 13 of the spec and
  adding a line to its progress log.
- Commits follow **Conventional Commits** (`feat:`, `fix:`, `perf:`, `chore:`,
  `docs:` …) — release-please builds the changelog and version bumps from them.

## Docker & releases

- `docker build -t csdash:test .` — multi-stage `node:24-slim` image; runtime
  runs as `node` (uid 1000) with `VOLUME /data`, `EXPOSE 3000`, HEALTHCHECK on
  `/healthz`.
- `docker run -p 127.0.0.1:3000:3000 -v csdash-data:/data csdash:test` — the
  setup token appears in the container logs.
- `docker compose up -d` — same service from `compose.yaml`.
- CI: `.github/workflows/ci.yml` runs verify + image smoke + Trivy on PRs and
  main. Releases: `.github/workflows/release.yml` — release-please keeps a
  release PR open on main; merge it only when a phase's release is due
  (v0.1.0 = end of phase 3). Merging creates the tag, then the images job
  pushes multi-arch `edge`/`sha-*`/`X.Y.Z`/`X.Y`/`latest` to GHCR with
  provenance, SBOM, and a keyless cosign signature. All third-party actions
  are pinned to commit SHAs.
