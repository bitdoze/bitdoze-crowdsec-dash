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

Verified locally: `npm ci`, lint, `svelte-check`, 15 unit tests, build, production smoke test, and a Docker smoke test (setup, restart persistence, uid 1000, 0600 secret file, graceful stop).

On GitHub: CI is green on `5394842` (verify, image smoke test, Trivy). The `Release` workflow pushed an `edge` image on `ba13498`; on `5394842` it stopped at release-please until owner action 1 below is done.

## Done so far (on `wip/design-system`, not yet merged)

The "Inspection Record" design system and overview are built, verified, and documented:

- `DESIGN.md` records the tokens, type, components, layout grammar, and accessibility rules. `scripts/contrast-report.mjs` checks every used token pair against AA (all pass: text ≥4.69:1, control borders ≥3.44:1; decorative hairlines are marked informational).
- Theme tokens in `src/routes/layout.css` (light "form paper" / dark "carbon copy", `prefers-color-scheme` + `[data-theme]` override). A new `--line` token covers WCAG-1.4.11 component boundaries; `--rule`/`--rule-strong` stay decorative.
- Components in `src/lib/components/`: Wordmark, Module, Stamp, ObservationCode, Evidence, Button, Field, FilterSelect, Kbd, CodeBlock, Menu/MenuItem, Tooltip, Sheet, Palette, ScenarioRamp, ActivityChart, AuthShell — Bits UI + Lucide, no shadcn CLI.
- App shell (`src/routes/(app)/+layout.svelte`): 232px sidebar, Sheet below `lg`, header with site/range filters, "Fixture data" chip, Ctrl K palette, user menu.
- Overview (`src/routes/(app)/+page.svelte`): header band + verdict stamp, server-wide checks, sites × tests schedule with per-cell evidence (Escape + focus restore), ordered observations with "Show fix" code blocks, measurements/activity/scenarios, empty state, fixture-only re-inspect animation (~100ms stagger, `aria-live`, reduced-motion safe).
- Overview types + `before`/`mixed` fixtures: `src/lib/overview/types.ts`, `fixtures.ts`, `format.ts`; server resolution in `src/lib/server/overview.ts` (dev or `DEMO_FIXTURES=true`, `?fixture=before|mixed`, otherwise `source: 'none'`).
- `/login` and `/setup` restyled via `AuthShell`.
- E2E: `npm run test:e2e` (Playwright, 16 tests incl. setup, fixtures, evidence Esc, Show fix, palette, empty state, re-inspect); `SCREENSHOTS=1` captures light/dark × desktop/mobile into `.impeccable/review/`; CI `e2e` job added.
- Verified on the branch: `npm ci`, lint, `svelte-check` (0/0), 21 unit tests, build, 16 e2e tests, contrast report, `impeccable detect` clean.

To finish this step: review the branch, merge `wip/design-system` into `main` (or open a PR), and push. CI will run the new e2e job; Playwright browsers are cached by version.

## Actions only the owner can take

1. GitHub → Settings → Actions → General → enable **"Allow GitHub Actions to create and approve pull requests"**. Release-please fails without it (latest Release run: "GitHub Actions is not permitted to create or approve pull requests").
2. Close Dependabot PR #1 (node 25-slim) and PR #3 (@types/node 26). Node majors are now ignored in `.github/dependabot.yml`. Review PR #2 (@libsql/client 0.18.0) once its CI is green.
3. Make the GHCR package `bitdoze-crowdsec-dash` public (GitHub → Packages → package settings) so `docker pull` works without login.
4. Before phase 3 testing against the reference host: approve (or refuse) registering a dashboard watcher machine with `cscli machines add`.

## Next steps, in order

### 1. Merge `wip/design-system` into `main`

All the "Done when" items passed; see "Done so far (on `wip/design-system`)" above and `DESIGN.md`. Review the `.impeccable/review/` screenshots locally (`SCREENSHOTS=1 npm run test:e2e` regenerates them), then merge or open a PR. The binding surface brief remains `.impeccable/surfaces/src-routes-app-page-svelte.md`.

### 2. Phase 2: authentication and permissions (spec section 9 and phase 2)

- Roles admin, operator, and viewer through the Better Auth admin plugin's access control, enforced server-side on every load, action, and endpoint.
- TOTP and recovery codes (`twoFactor` plugin). Session list and revocation.
- **Suspected gap to verify first:** `/login` calls `auth.api.signInEmail` from a form action, which probably bypasses Better Auth's HTTP rate limiter. Add real login throttling and test it.
- Client-IP handling: what Better Auth and the app trust behind a reverse proxy, given that `server/index.js` pins the origin headers.
- A lockout-recovery CLI or documented procedure.
- Tests: direct requests by viewers and unauthenticated users must fail.

### 3. Phase 3: read-only CrowdSec monitoring, then release v0.1.0

- Follow spec section 4 (capability tiers, exact LAPI routes) and the phase 3 checklist.
- Build in this order: the typed LAPI client (watcher credentials or mTLS), worker-owned incremental alert sync, CAPI excluded by default, metrics scraping, site attribution, hourly rollups, then replace the overview fixtures with live data.
- Use the reference host read-only. Its LAPI and metrics listen on 127.0.0.1, so the dashboard needs host networking there.
- To release, merge the release-please PR (after owner action 1).

Later phases (4–13) are fully described in the spec.

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

## How to track progress

When a step lands:

- tick its boxes in spec section 13 (annotate partial items);
- add a dated line to the spec's progress log;
- update the "Done so far" table and "Next steps" in this file;
- commit with a Conventional Commit message.
