# Changelog

## [0.1.0](https://github.com/bitdoze/bitdoze-crowdsec-dash/compare/bitdoze-crowdsec-dash-v0.0.1...bitdoze-crowdsec-dash-v0.1.0) (2026-10-10)


### Features

* **agent:** tier-D host agent, durable job queue, /system page (phase 6) ([4b78918](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/4b78918450122fd8d8a2d5309f32d35f50cea6e8))
* **api:** REST /api/v1 + /mcp MCP endpoint with per-user API keys ([a729ad9](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/a729ad95212b755a1f23d0b6e742deac13f29cfa))
* **auth:** roles, TOTP two-factor, login throttling, sessions, audit ([249ee1c](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/249ee1c490f9193770c81aa2ddefe32d74318ac1))
* **crowdsec:** attack map, capability tiers, observer bouncer lookup ([d939c3e](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/d939c3e9b004f6657da5c199c736848087065bcd))
* **crowdsec:** read-only LAPI monitoring — sync, metrics, attribution, UI ([88da675](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/88da67568ec609ce1757a79f4d3ab31b8684db6d))
* **decisions:** manual ban/unban, allowlists, notification inbox + channels ([c04c679](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/c04c6792539162b71ca886f379c642986c7d228d))
* phase 7 — Traefik + Docker managed integration ([22feb0e](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/22feb0e62153a47235067d1beaf153378f19ef55))
* **phase-10:** Cloudflare edge enforcement — IP list + managed zone rules ([92d0406](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/92d0406baca18c379dc988c6d040c9f9890f5b7f))
* **phase-11:** notification rules + operational tooling ([f0173c8](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/f0173c8910f79e0f922cc64566132b322e69267a))
* **phase-12:** verification matrix, drills, benchmarks, security fixes, release docs ([186c94b](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/186c94b313bd88330ebf73ab66d2f40778ac3c64))
* **phase-9:** activity charts, theme toggle, recovery hint — polish pass ([8c2edff](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/8c2edffa18d91d491a015e1f62f7855badd1488d))
* **protection:** resumable setup wizard + multi-site feed check ([135d643](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/135d643756616a7cdd5abdd58f935d99ef78bcdd))
* **protect:** site inventory, guided artifacts, verification checks ([11309e3](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/11309e39c56a27f1e94fc51e705e9a74e1df38d0))
* **proxy:** phase 8 — managed Caddy and Nginx via the config lifecycle ([7460462](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/74604624dac975d81a49e18a1e02ca2e00cc2c2c))
* **sites:** phase 9 — site policy, WAF levels, drift, saved views, simulation ([bee9951](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/bee995149698784945d8c25036d7f63aee550670))
* **ui:** Inspection Record design system, app shell, and overview ([bc2ade5](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/bc2ade508a9db4af5b8d32d531573144efc6ceb1))


### Bug Fixes

* align CrowdSec/Cloudflare/proxy integrations with real upstream contracts ([de43027](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/de43027c1a01db33e9b1de725907f4d13e18768b))
* **api:** review hardening — pagination honesty, audit, MCP negotiation ([ac8e20d](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/ac8e20d770524868dd7bb03e6bc599a2b9d4f89b))
* **docker:** apply Debian security updates and drop npm from the runtime image ([5394842](https://github.com/bitdoze/bitdoze-crowdsec-dash/commit/5394842a504ef3e3831de8a435e60ac19a3c8133))
