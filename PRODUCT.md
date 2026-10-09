# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a solo self-hoster running their own websites and apps on a VPS or homelab, usually behind Caddy, Nginx, or Traefik, often in Docker, sometimes behind Cloudflare. They are technical but not security specialists. They open the dashboard occasionally, not all day: after setup, when a notification arrives, or to check that everything still works. The job is "tell me whether my sites are protected, what is wrong, and how to fix it."

## Product Purpose

Bitdoze CrowdSec Dash is a self-hosted, open-source dashboard that helps one administrator set up, verify, and operate CrowdSec protection for the websites on a server: log-based detection, shared IP bans, the AppSec WAF, and optional Cloudflare edge enforcement. Success means a site goes from unprotected to verified protection through guided steps, and that real problems are surfaced with evidence and a fix.

## Positioning

Existing CrowdSec dashboards show alerts and decisions. This product also sets protection up and proves it works: it generates the exact proxy, CrowdSec, and Cloudflare configuration for the detected topology, verifies each layer with evidence (logs read, logs parsed, client IP correct, bouncer enforcing, WAF blocking), and separates activity per website.

## Operating Context

- Runs locally or as a Docker container on the same server as CrowdSec; one server per installation in v1.
- Supported topologies: everything in Docker, native CrowdSec with Dockerized proxy/apps, everything native on Debian/Ubuntu.
- Typical sessions: first-run setup wizard; checking the overview after a notification; investigating an IP; banning or allowlisting an address; re-running checks after changing a proxy.
- Notifications (email, ntfy, Gotify, webhooks with Discord/Slack/Telegram presets) bring the user back to the dashboard.
- The specification is `crowdsec-dashboard-specification.md` at the repository root.

## Capabilities and Constraints

- Stack: SvelteKit 3, Svelte 5, Tailwind CSS, Drizzle with local libSQL, Better Auth; shadcn-svelte/Bits UI, Lucide icons, LayerChart, TanStack Table.
- Health states use one vocabulary: verified, degraded, failed, unknown/stale, not configured. Configured, reachable, and verified are never conflated; a ban is never presented as a blocked request.
- Bans are server-wide; website separation applies to inventory, filtering, attribution, and statistics only.
- Must work on the Cloudflare Free plan.
- No telemetry by default; no visitor IPs sent to external services by default.
- Roles: administrator, operator, viewer.

## Brand Commitments

- Name: Bitdoze CrowdSec Dash (repository and GHCR image `bitdoze/bitdoze-crowdsec-dash`).
- No existing logo or brand palette; none is binding.
- License: MIT.

## Evidence on Hand

- A real reference host (native CrowdSec 1.7.6, Caddy in Docker) documented in the specification's Appendix B, kept unmodified as the "before" case.
- No users, testimonials, screenshots, or benchmarks exist yet; do not fabricate them.

## Product Principles

1. Show evidence, not reassurance: every status has a timestamp and the data behind it.
2. Every problem comes with the next step: a generated fix, a command, or a link to the setup step.
3. Calm by default: an occasional visitor should understand the server's state in seconds without reading alert tables.
4. Honest scope: say what is server-wide, what is per site, and what is not covered.
5. Self-hosted first: works without accounts, external services, or paid plans.

## Accessibility & Inclusion

Target WCAG 2.2 AA: contrast, full keyboard operation, visible focus, screen-reader labels, and status never conveyed by color alone. Respect reduced-motion preferences.
