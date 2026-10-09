---
version: 1
slug: 'src-routes-app-page-svelte'
primary_target: 'src/routes/(app)/+page.svelte'
related_targets: ['src/routes/(app)/+layout.svelte']
---

# Overview (app home) — surface brief

Scope: the authenticated overview route and the app shell it establishes. Mode: Operate.

Audience and job: a solo self-hoster opening the dashboard occasionally (after setup, after a notification) who needs to know within seconds whether each site is protected, what is wrong, and what to do next.

Content: per-site protection tests (logs read, logs parsed, client IP, bouncer, WAF, edge) with timestamped evidence; open problems with fixes; alert/decision activity; community blocklist size; sync freshness.

Constraints: WCAG 2.2 AA; status never by color alone; light and dark themes from the system setting; bans are server-wide while sites only filter; no fabricated data outside clearly labeled fixtures.

## Direction contract

THESIS: The overview is an inspection record, not a metrics wall. It refuses the category default of KPI cards over charts; the primary object is a schedule of sites against protection tests, each cell a stamped, timestamped result that opens its evidence.

OWN-WORLD: Electrical-installation certificates and lab test reports. Cool form-gray ground (graphite carbon-copy in dark), blue-black ink, hairline rules, ruled modules with small header tabs, one stamp-violet accent for actions and selection. Status stamps: double-ruled rectangles reading VERIFIED, DEGRADED, FAILED, STALE, N/C, each with icon and text. Public Sans with tabular figures; system monospace for IPs and configuration. Only overlays float.

STORY: The visitor sees the verdict and when it was last inspected, scans which site and which test failed, reads the coded observation (C1 danger, C2 potentially dangerous, C3 improvement, FI investigate), and presses its fix or Re-inspect.

FIRST VIEWPORT: Top: certificate header band with server name, last inspected time, sync state, overall verdict stamp, and Re-inspect as the primary action at right. Main left (about two thirds): the inspection schedule grid, sites as numbered rows, tests as columns. Right column: observations list with codes and Fix actions. Below the fold: activity measurements and top scenarios.

FORM: Inspection Record, candidate 6 of 7 on the grounded list; seed key 20a2bc1b.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature interaction

Re-inspect: each schedule cell drops to a dotted "checking" outline and is re-stamped as results stream in (short press, about 120 ms; instant under reduced motion).

## Raises carried from declined challengers

- Japanese high-density web: hairline-ruled modules with small header tabs.
- Crouwel grid specimen: the schedule grid is the page's visible armature.
- Star atlas: a fixed magnitude ramp for counts and the attack map.
- Ikeda datamatics: strict tabular numerals, no decorative fills.
- Acetate manual: one elevation rule; only overlays float.

## Unresolved

- Exact token values are set at build time and documented in DESIGN.md at finish.
- Real data arrives with phase 3; until then the overview uses clearly labeled fixture data only in development.
