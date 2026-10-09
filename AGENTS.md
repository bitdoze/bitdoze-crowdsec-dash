# AGENTS.md

## Commands

- `npm ci` — install (clean install must pass; no `--legacy-peer-deps`)
- `npm run dev` — dev server
- `npm run check` — `svelte-kit sync` + `svelte-check`
- `npm run lint` — `prettier --check . && eslint .` (run `npm run format` to fix)
- `npm test` — `vitest run` (tests in `tests/`, no network)
- `npm run build` — adapter-node build into `build/`
- `ORIGIN=http://localhost:3000 npm start` — production server (`server/index.js`)
- `npm run db:generate` — emit a migration into `drizzle/` from `src/lib/server/db/schema.ts`
- `npm run db:migrate` / `npm run db:studio` — drizzle-kit utilities
- `npm run auth:schema` — regenerate `src/lib/server/db/auth.schema.ts` from `auth.ts` (run after changing Better Auth options/plugins, then `db:generate`)

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
  by SvelteKit CSRF protection.
- Auth: Better Auth email/password only; public sign-up is disabled
  (`disableSignUp` + `disabledPaths`). First admin is created on `/setup` with
  a one-time token logged once at startup (or `SETUP_TOKEN`); roles via the
  `admin` plugin (`admin` / `viewer`; `viewer` is the default role).
- Secrets: `resolveSecret(name)` in `src/lib/server/secrets.ts` — env var,
  `<NAME>_FILE`, or a generated value persisted under `DATA_DIR/secrets/` with
  mode 0600. Never log secret values (the setup token is the single allowed
  exception, logged once at startup).
- Plain Tailwind markup only for now — no shadcn-svelte/design system yet.
- Track progress by ticking the phase checklists in section 13 of the spec and
  adding a line to its progress log.
