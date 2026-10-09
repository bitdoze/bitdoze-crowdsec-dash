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

## Unfinished work

Branch `wip/design-system` (commit `9eca810`) holds the interrupted UI step. It does **not** type-check yet: two errors, because `src/lib/overview/types.ts` was never written. It contains:

- tokens in `src/routes/layout.css`;
- components in `src/lib/components/`: Button, CodeBlock, Kbd, Menu, MenuItem, Module, ObservationCode, Stamp, Tooltip;
- `src/lib/utils.ts`;
- new devDependencies: bits-ui, @lucide/svelte, layerchart, clsx, tailwind-merge, @fontsource-variable/public-sans, @internationalized/date, @playwright/test.

Recheck that every package version on the branch is at least 7 days old, then continue from it (or redo it) using the step 1 brief below.

## Actions only the owner can take

1. GitHub → Settings → Actions → General → enable **"Allow GitHub Actions to create and approve pull requests"**. Release-please fails without it (latest Release run: "GitHub Actions is not permitted to create or approve pull requests").
2. Close Dependabot PR #1 (node 25-slim) and PR #3 (@types/node 26). Node majors are now ignored in `.github/dependabot.yml`. Review PR #2 (@libsql/client 0.18.0) once its CI is green.
3. Make the GHCR package `bitdoze-crowdsec-dash` public (GitHub → Packages → package settings) so `docker pull` works without login.
4. Before phase 3 testing against the reference host: approve (or refuse) registering a dashboard watcher machine with `cscli machines add`.

## Next steps, in order

### 1. Design system, app shell, and overview (finishes the phase 1 UI items)

The binding direction is in the surface brief above. Requirements:

**World.** Inspection certificates and lab test reports, rendered as crisp UI.

- Never use: paper textures, rotated stamps, gradients, glass, eyebrow labels above headings, big-number KPI cards, colored side borders wider than 1px, hard offset shadows, emoji icons.
- Only overlays float, with a soft shadow. Everything else is flat, separated by hairline rules.
- Radii: controls 3px, ruled modules 0, overlays 6px.

**Tokens (OKLCH).** Keep hue and chroma; adjust lightness only, as needed to pass AA.

| Token            | Light ("form")                        | Dark ("carbon copy")              |
| ---------------- | ------------------------------------- | --------------------------------- |
| paper            | 0.972 0.006 165                       | 0.20 0.008 255                    |
| sheet            | 0.995 0.002 165                       | 0.235 0.009 255                   |
| panel            | 0.945 0.008 165                       | 0.18 0.008 255                    |
| ink              | 0.235 0.02 255                        | 0.93 0.008 165                    |
| ink-2            | 0.43 0.018 255                        | 0.75 0.01 255                     |
| ink-3            | 0.50 0.015 255                        | 0.66 0.01 255                     |
| rule             | 0.87 0.01 165                         | 0.32 0.01 255                     |
| rule-strong      | 0.78 0.012 165                        | 0.40 0.01 255                     |
| accent           | 0.48 0.20 290 (hover 0.42; ink white) | 0.72 0.15 290 (ink 0.20 0.03 290) |
| verified on tint | 0.50 0.13 155 on 0.95 0.04 155        | 0.78 0.14 155 on 0.30 0.05 155    |
| degraded on tint | 0.50 0.12 65 on 0.96 0.05 85          | 0.82 0.13 80 on 0.32 0.05 80      |
| failed on tint   | 0.50 0.19 27 on 0.95 0.035 27         | 0.74 0.16 25 on 0.30 0.06 25      |
| stale on tint    | 0.50 0.01 255 on 0.94 0.005 255       | 0.72 0.01 255 on 0.28 0.005 255   |

Theme switching: follow `prefers-color-scheme`, with a `[data-theme]` override on `<html>`.

**Type.**

- Public Sans Variable (self-hosted), weights 400–700; system monospace only for IPs, configuration, and commands.
- Scale: xs 12/16, sm 13/18, base 14/20, md 16/24, lg 19/26, xl 23/30.
- Tabular numerals everywhere numbers appear.
- Form labels: xs 600 uppercase, tracking 0.05em.
- Theme the selection, caret, scrollbar, and focus ring (2px accent with offset).
- Icons: Lucide only.

**Components** (owned, built on bits-ui; no shadcn CLI):

- **Stamp:** a double-ruled rectangle in six states (VERIFIED, DEGRADED, FAILED, STALE, N/C, CHECKING), always icon plus text.
- **Module:** a ruled section with its title in a header tab.
- **ObservationCode:** `<abbr>` for C1, C2, FI, C3.
- Button, Tooltip, DropdownMenu, a Command palette in a Dialog, Sheet, Kbd, and CodeBlock with Copy.

**App shell** (`src/routes/(app)/+layout.svelte`):

- **Sidebar** (232px, `panel` background): wordmark plus the Lucide Stamp icon.
  - Overview is the only active link.
  - Sites, Alerts, Decisions, Protection, Notifications, System, and Settings show as disabled "Planned" items, not dead links.
- **Header:**
  - site filter (`?site=`) and time range (`?range=`);
  - a "Fixture data · not live" chip;
  - a Ctrl/Cmd+K palette (the IP search entry stays disabled until v0.1);
  - a user menu with Sign out (POST to `/logout`).
- **Below 1024px:** the sidebar becomes a Sheet.

**Overview data.**

- Types in `src/lib/overview/types.ts`: CheckState, TestId (logs_read, logs_parsed, client_ip, bouncer, waf, edge), CheckResult, SiteRow, ServerCheck, Observation, Measurement (`value: number | null` plus `unavailableReason`), ActivityPoint, OverviewData (`source: 'fixture' | 'none'`).
- Fixtures in `src/lib/server/fixtures/overview.ts`, served in dev or when `DEMO_FIXTURES=true`, chosen by `?fixture=before|mixed`. Otherwise show an empty state, "Not connected to CrowdSec yet".
- Fixture `before` mirrors spec Appendix B, with example.com hostnames only:
  - Server: "reference-host".
  - Sites: blog, shop, and status.example.com, all Caddy in Docker.
  - Server checks: firewall bouncer degraded (no DOCKER-USER chain); community blocklist 21,286.
  - Site checks: logs, bouncer, WAF, and edge all N/C; client IP stale. Verdict: "Websites not protected".
  - Observations:
    - C1 banned IPs still reach the sites;
    - C1 no detection for the websites;
    - C2 no inline WAF;
    - FI LAPI is unreachable from Docker;
    - C3 the http_extended context is missing.
  - WAF blocks: "Not measured — AppSec not configured", never 0.
- Fixture `mixed` shows every state.
- Add a vitest invariant test for both fixtures.

**Overview layout.**

1. **Header band:** server name, meta line, large verdict stamp, last-inspected time (relative and absolute), primary "Re-inspect" button.
2. **Inspection schedule** (left, 2fr):
   - a server-wide strip with the note that bans apply to every site;
   - a real `<table>`: `#`, Site, T1 Logs read, T2 Parsed, T3 Client IP, T4 Bouncer, T5 WAF, T6 Edge.
   - Each cell is a button that opens one evidence row under the site: result, measured values, method, time, next step, and "Show fix". Esc closes it and restores focus.
3. **Observations** (right, 1fr): ordered C1, C2, FI, C3, each with an inline "Show fix" (steps plus CodeBlock).
4. **Below the fold:**
   - Measurements as a ruled table;
   - Activity (24 h): a lazy-loaded LayerChart with a text summary and a hidden data table;
   - Top scenarios with a fixed five-step magnitude dot ramp.
5. **Re-inspect (fixture mode only):** cells turn CHECKING row by row, about 90 ms apart, then re-stamp with a short press animation; results are announced through aria-live. With reduced motion: no stagger and no animation.

Also restyle `/login` and `/setup` in the same visual direction.

**Done when:**

- lint, check, unit tests, and build pass;
- a Playwright e2e suite (`npm run test:e2e`, also added to CI) covers setup, both fixtures, evidence open/close with Esc, Show fix, the palette, and the empty state;
- `SCREENSHOTS=1` saves light/dark × desktop/mobile captures to `.impeccable/review/` (gitignored);
- a contrast report shows text ≥4.5:1 and borders/focus ≥3:1;
- `~/.agents/skills/impeccable/scripts/impeccable detect --json src/routes src/lib/components` is clean or every finding is justified.

Then write `DESIGN.md` from the built result, and tick the phase 1 checklist items.

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

## How to track progress

When a step lands:

- tick its boxes in spec section 13 (annotate partial items);
- add a dated line to the spec's progress log;
- update the "Done so far" table and "Next steps" in this file;
- commit with a Conventional Commit message.
