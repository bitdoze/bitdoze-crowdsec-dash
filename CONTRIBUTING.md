# Contributing

Thanks for helping build this. The project is pre-alpha — the specification
and roadmap live in `crowdsec-dashboard-specification.md`, and `HANDOFF.md`
records what has shipped and what is verified.

## Setup

```sh
npm ci            # Node >= 22.17 (.nvmrc pins 24)
npm run dev       # migrations run on boot; a one-time setup token is logged
```

Open `/setup`, enter the token, create the first admin. Dev mode serves
labeled fixture data on the overview so you can iterate without a CrowdSec.

## Commands

| Command                      | What it does                                                               |
| ---------------------------- | -------------------------------------------------------------------------- |
| `npm run check`              | `svelte-check` — must be 0 errors / 0 warnings                             |
| `npm run lint`               | prettier + eslint                                                          |
| `npm test`                   | vitest unit/integration suite (`tests/`)                                   |
| `npm run build`              | production build                                                           |
| `npm run test:e2e`           | playwright suite against a built app + mock LAPI + mock Cloudflare         |
| `npm run drills`             | resilience drills: crash/restart, WAL contention, rollback, backup/restore |
| `npm run bench`              | benchmark suite → numbers for `docs/benchmarks.md`                         |
| `npm run backup` / `restore` | DB snapshot / restore                                                      |
| `npm run db:generate`        | regenerate drizzle migrations after schema edits                           |

## Conventions

- **Server-side authorization on everything.** Loads and actions call
  `requireUser`/`requirePermission(event, 'operate' | 'configure')` from
  `src/lib/server/roles.ts`. Never rely on hiding a button.
- **Mutations that take effect elsewhere go through durable jobs**
  (`src/lib/server/jobs/`) with recorded steps and rollback runs — never
  fire-and-forget from an action.
- **Secrets** go through `resolveSecret`/`*Enc` columns; nothing secret may
  appear in job results, audit rows, exports, previews, or logs.
- **Outbound URLs** pass `assertSafeHttpUrl` at save and send time.
- Schema changes: edit `src/lib/server/db/app.schema.ts`, then
  `npm run db:generate`, commit the migration, and keep migrations
  forward-only.
- Match existing style: tabs, prettier defaults, no comments unless the
  "why" is non-obvious. `npm run lint` before pushing.

## Testing expectations

- Unit tests for pure logic (`tests/*.test.ts`); the db-bound tests use the
  real schema against a per-worker `DATA_DIR`.
- e2e specs (`e2e/`) run against mocks — `e2e/mock-lapi.mjs` and
  `e2e/mock-cf.mjs` — no real services needed.
- If you touch the worker, jobs, or db lifecycle, run `npm run drills`.
- Screenshot specs skip when fixture images are absent — that's expected.

## Pull requests

Small, focused PRs; describe the _why_. CI runs check/lint/test/build/e2e.
Releases are cut by the release workflow — don't hand-edit version numbers.
