# Design system — "Inspection Record"

The product is a verifier, not a dashboard of reassurance. The visual language is
borrowed from electrical-installation certificates and lab test reports: every
website is an entry on an inspection schedule, and every protection layer is a
numbered test with a stamped result and written evidence.

The binding surface brief lives in `.impeccable/surfaces/src-routes-app-page-svelte.md`.
This document records what was actually built.

## Themes

Two OKLCH palettes selected by `prefers-color-scheme`, forceable with
`html[data-theme="light"|"dark"]`:

- **Light — form paper.** Cool form-gray paper (`--paper`), near-white module
  sheets (`--sheet`), darker sidebar panel (`--panel`).
- **Dark — carbon copy.** Graphite surfaces with the same ink/stamp roles
  inverted to luminous values.

Tokens are CSS custom properties in `src/routes/layout.css`, exposed to Tailwind
through `@theme inline`. The three blocks (`:root`, media query, `data-theme`)
must be edited together.

### Ink

`--ink` (blue-black body text), `--ink-2` (secondary), `--ink-3` (hints,
captions, disabled). All three pass WCAG AA ≥4.5:1 on every surface they appear
on — `scripts/contrast-report.mjs` parses the file and checks every used pair.

### Rules and lines

- `--rule` — decorative hairlines (table rows, inner dividers).
- `--rule-strong` — structural hairlines (sidebar edge, header underline,
  module top-rule). Deliberately below 3:1; they are decorative.
- `--line` — component boundaries that must be _identified_ to be usable:
  inputs, selects, secondary buttons, kbd, overlays, the N/C stamp. ≥3:1 on
  every surface (WCAG 1.4.11).

### Accent

One stamp-violet accent (`--accent`) for primary actions, focus, selection, and
the chart series. `--accent-hover`, `--accent-ink` (text on accent),
`--accent-outline` (focus ring). Everything else stays in ink or status colors —
the accent is the only decorative color on the page.

### Status stamps

Double-ruled rectangles, icon + uppercase text on a matching tint. Status is
never color alone — every stamp carries an icon and a word.

| State    | Meaning                                  | Class family      |
| -------- | ---------------------------------------- | ----------------- |
| VERIFIED | test passed at inspection time           | `verified(-tint)` |
| DEGRADED | works but impaired                       | `degraded(-tint)` |
| FAILED   | test failed                              | `failed(-tint)`   |
| STALE    | was working, evidence is old             | `stale(-tint)`    |
| N/C      | not configured — line border, ink-3 text | `line` + `ink-3`  |
| CHECKING | re-inspection in progress                | dotted `ink-3`    |

Each stamp also carries a `title`/tooltip with the measured detail.

## Typography

- **Public Sans Variable** (self-hosted via `@fontsource-variable`) for all UI
  text — descended from official-form typography. Tabular numerals
  (`tabular-nums`) on every count, time, and ID.
- **System monospace** (`--font-mono`) for IPs, scenario names, configuration,
  commands, and code blocks.
- Scale is defined in `@theme`: `text-xs/sm/base/md/lg/xl`, body defaults to
  `text-base` (0.875rem). Headings are semibold with −0.01em tracking; there is
  no decorative display type — the wordmark is the same face at small size.

## Layout

- 232px (`lg`) sidebar: wordmark (Stamp icon + two-line name), then nav.
  Overview is the only active item; Sites, Alerts, Decisions, Protection,
  Notifications, System, Settings render as disabled "Planned" rows. Below
  `lg` the sidebar becomes a bits-ui Sheet.
- Sticky header: site filter, time-range select, honesty chip ("Fixture data")
  when serving fixtures, command-palette trigger (Ctrl K), user menu.
- Content is a two-column reading measure: inspection schedule + evidence on
  the left, observations rail on the right (`xl`), collapsing to single column
  on small screens. The schedule table scrolls horizontally rather than
  wrapping.
- Only overlays float: Sheet, palette dialog, menus, tooltips use
  `--shadow-overlay` and `--radius-overlay` (6px). Everything else sits on the
  sheet with `--radius-control` (3px) or square edges.

## Components (`src/lib/components/`)

- `Wordmark` — Stamp icon in a double-ruled box + "Bitdoze / CrowdSec Dash".
- `Module` — hairline-ruled section with a small bordered header tab, the
  recurring "form section" unit.
- `Stamp` — the status stamp above; `checking` variant is a dotted outline.
- `ObservationCode` — C1/C2/FI/C3 severity codes as bordered `<abbr>` chips.
- `Evidence` — expandable detail row under a schedule cell (mono key/value
  pairs); closes on Escape and returns focus.
- `Button`, `Field`, `FilterSelect`, `Kbd`, `CodeBlock` (with copy control),
  `Menu`/`MenuItem`, `Tooltip`, `Sheet`, `Palette` (Ctrl K jump box), `ScenarioRamp`
  (log-magnitude dot ramp), `ActivityChart` (LayerChart lazy-loaded bar chart
  with a native `<details>` data-table fallback).
- `AuthShell` — the centered bordered sheet used by `/login` and `/setup`.

## The overview grammar

1. **Header band** — server name, metadata line, overall verdict stamp,
   relative + absolute inspection time, Re-inspect action.
2. **Inspection schedule** — server-wide checks (engine, LAPI, firewall
   bouncer, community blocklist) with the note that bans apply to every site;
   then a sites × tests grid (T1 logs read, T2 parsed, T3 client IP,
   T4 bouncer, T5 WAF, T6 edge). Each cell is a stamp that opens its evidence.
3. **Observations** — numbered findings coded C1/C2/FI/C3, each with a
   "Show fix" disclosure containing steps and a copyable code block.
4. **Measurements / Activity / Top scenarios** — the record's measured values.
   Unavailable measurements render as "Not measured — reason", never as 0.
5. **Empty state** — "Not connected to CrowdSec yet"; no fabricated data ever
   reaches the page. Fixture data (dev or `DEMO_FIXTURES=true`,
   `?fixture=before|mixed`) is labeled by the header chip.
6. **Re-inspect** — cells fall to CHECKING row-by-row (~100ms stagger), then
   restamp with a short press animation; `prefers-reduced-motion` disables
   both, and an `aria-live` region announces progress and completion.

## Accessibility commitments

- WCAG AA everywhere; enforced pair list in `scripts/contrast-report.mjs`
  (run `node scripts/contrast-report.mjs`).
- Status never color alone; every stamp has icon + word.
- Keyboard: cells are buttons, evidence closes on Escape and restores focus,
  palette/menu/sheet are bits-ui primitives with focus management.
- `aria-live` announcements for re-inspection; `prefers-reduced-motion` kills
  all animation (see `.overlay-fade` and the stamp transition rules in
  `layout.css`).

## Anti-patterns to keep out

- No gradients, no glass/blur cards, no rounded-pill badges, no emoji in UI.
- No "0" for unknown values — nulls carry a reason.
- No color-only meaning; no unlabeled icons on interactive elements.
- No fabricated data: live state comes only from a real connection.
