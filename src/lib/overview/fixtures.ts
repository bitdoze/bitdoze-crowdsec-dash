/**
 * Labeled fixture data for the overview, used in development and when
 * DEMO_FIXTURES=true. Pure module: no SvelteKit or environment imports, so
 * unit tests can exercise the same data the UI renders.
 *
 * `before` mirrors the reference host in spec Appendix B (9 Oct 2026): native
 * CrowdSec watching SSH only, Caddy in Docker with no access logs and no
 * bouncer, and a firewall bouncer that does not cover DOCKER-USER.
 * `mixed` exercises every check state.
 */
import type {
	CheckResult,
	CheckState,
	Measurement,
	Observation,
	OverviewData,
	ServerCheck,
	SiteRow,
	TestId
} from './types.ts';

type CheckSeed = Partial<CheckResult> & { state: CheckState };

function check(seed: CheckSeed): CheckResult {
	return {
		measuredAt: null,
		method: null,
		summary: '',
		evidence: [],
		nextStep: null,
		fix: null,
		...seed
	};
}

/** Per-site test set for an unprotected Caddy-in-Docker site (reference host). */
function unprotectedSiteChecks(hostname: string, at: string): Record<TestId, CheckResult> {
	return {
		logs_read: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Caddyfile inspection',
			summary: 'No access log directive for this site.',
			evidence: [
				{ label: 'Site block', value: hostname },
				{ label: 'Access log directive', value: 'absent' },
				{ label: 'CrowdSec acquisition', value: 'auth.log, kern.log, syslog only' }
			],
			nextStep: 'Enable JSON access logs for this site, then add a CrowdSec acquisition entry.',
			fix: {
				title: 'Enable JSON access logs in Caddy',
				steps: [
					'Add a log directive inside this site block in the Caddyfile.',
					'Mount the log directory so CrowdSec can read it.',
					'Add a file acquisition entry under /etc/crowdsec/acquis.d/ and reload CrowdSec.'
				],
				code: `${hostname} {\n\tlog {\n\t\toutput file /var/log/caddy/${hostname}.log\n\t\tformat json\n\t}\n\treverse_proxy app:3000\n}`
			}
		}),
		logs_parsed: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'CrowdSec metrics: parsers',
			summary: 'No web log lines are acquired, so nothing reaches the parsers.',
			evidence: [
				{ label: 'Web lines read (24 h)', value: '0' },
				{ label: 'Caddy collection', value: 'not installed' }
			],
			nextStep: 'Depends on T1: enable access logs first.',
			fix: {
				title: 'Install the Caddy parser collection',
				steps: [
					'Install the collection that parses Caddy JSON access logs.',
					'Reload CrowdSec and check parser metrics for hits.'
				],
				code: 'sudo cscli collections install crowdsecurity/caddy\nsudo systemctl reload crowdsec'
			}
		}),
		client_ip: check({
			state: 'stale',
			measuredAt: at,
			method: 'Proxy config inspection',
			summary:
				'Forwarded headers are passed through unverified; the observed peer is the Docker bridge.',
			evidence: [
				{ label: 'trusted_proxies', value: 'not set' },
				{ label: 'Observed remote address', value: '172.18.0.1 (bridge)' },
				{ label: 'X-Forwarded-For handling', value: 'untrusted' }
			],
			nextStep: 'Set trusted_proxies so only the real proxy chain can supply client addresses.',
			fix: {
				title: 'Restrict trusted proxies in Caddy',
				steps: [
					'Declare trusted_proxies in this site block (or globally).',
					'If the site sits behind Cloudflare, use the published Cloudflare ranges instead of static ranges.'
				],
				code: `${hostname} {\n\ttrusted_proxies 172.16.0.0/12 10.0.0.0/8 192.168.0.0/16\n}`
			}
		}),
		bouncer: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Image inspection',
			summary: 'The stock caddy:2 image has no CrowdSec module; decisions never reach the proxy.',
			evidence: [
				{ label: 'Image', value: 'caddy:2' },
				{ label: 'CrowdSec bouncer module', value: 'absent' },
				{ label: 'Registered bouncers', value: 'crowdsec-firewall-bouncer only' }
			],
			nextStep: 'Use a pinned Caddy build with the CrowdSec bouncer module.',
			fix: {
				title: 'Build Caddy with the CrowdSec bouncer',
				steps: [
					'Build a pinned Caddy image including the bouncer module.',
					'Register a bouncer API key and point the module at LAPI.',
					'Re-run this check to confirm enforcement.'
				],
				code: 'FROM caddy:2-builder AS builder\nRUN xcaddy build v2.11.2 \\\n\t--with github.com/hslatman/caddy-crowdsec-bouncer@v0.14.1\nFROM caddy:2\nCOPY --from=builder /usr/bin/caddy /usr/bin/caddy'
			}
		}),
		waf: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'CrowdSec config inspection',
			summary: 'AppSec is not configured; requests are never inspected inline.',
			evidence: [
				{ label: 'AppSec acquisition', value: 'none' },
				{ label: 'AppSec collections', value: 'none installed' },
				{ label: 'Bouncer AppSec forwarding', value: 'n/a (no bouncer)' }
			],
			nextStep: 'Configure an AppSec acquisition endpoint and enable it in the bouncer.',
			fix: {
				title: 'Enable CrowdSec AppSec',
				steps: [
					'Add an appsec acquisition entry listening on the proxy network.',
					'Install an AppSec virtual-patching collection.',
					'Enable appsec forwarding in the proxy bouncer config.'
				],
				code: 'sudo cscli collections install crowdsecurity/appsec-virtual-patching\n# /etc/crowdsec/acquis.d/appsec.yaml\n# listen_addr: 0.0.0.0:7422\n# appsec_config: crowdsecurity/virtual-patching\nsource: appsec'
			}
		}),
		edge: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Integration inventory',
			summary: 'No edge enforcement is configured for this site.',
			evidence: [
				{ label: 'CDN', value: 'none detected' },
				{ label: 'Edge rule owner', value: 'none' }
			],
			nextStep: 'If this site is behind Cloudflare, sync decisions to a dashboard-owned IP list.',
			fix: {
				title: 'Sync decisions to the Cloudflare edge',
				steps: [
					'Connect a scoped Cloudflare API token.',
					'Create a dashboard-owned IP list and one WAF custom rule per selected zone.',
					'Verify propagation, then re-run this check.'
				]
			}
		})
	};
}

function site(hostname: string, proxy: string, checks: Record<TestId, CheckResult>): SiteRow {
	return { id: hostname, hostname, proxy, checks };
}

/* ------------------------------------------------------------------ */
/* Fixture: before                                                     */
/* ------------------------------------------------------------------ */

export function buildBeforeFixture(now: Date = new Date()): OverviewData {
	const at = new Date(now.getTime() - 32_000).toISOString();
	const sites = ['blog.example.com', 'shop.example.com', 'status.example.com'].map((host) =>
		site(host, 'Caddy (Docker)', unprotectedSiteChecks(host, at))
	);

	const serverChecks: ServerCheck[] = [
		{
			id: 'engine',
			label: 'CrowdSec engine',
			state: 'verified',
			detail: 'v1.7.6, native (systemd)',
			measuredAt: at
		},
		{
			id: 'lapi',
			label: 'LAPI',
			state: 'verified',
			detail: 'Bound to 127.0.0.1:8080 — unreachable from containers',
			measuredAt: at
		},
		{
			id: 'firewall-bouncer',
			label: 'Firewall bouncer',
			state: 'degraded',
			detail: 'Rules only in INPUT; DOCKER-USER not covered',
			measuredAt: at
		},
		{
			id: 'blocklist',
			label: 'Community blocklist',
			state: 'verified',
			detail: '21,286 active decisions',
			measuredAt: at
		}
	];

	const observations: Observation[] = [
		{
			code: 'C1',
			title: 'Banned IPs can still reach the sites',
			detail:
				'The firewall bouncer writes rules to the INPUT chain only. Docker publishes proxy ports 80/443 through DOCKER-USER, so the 21,286 community-blocklist IPs are dropped for host services but not for the websites.',
			fix: {
				title: 'Cover Docker-published ports in the firewall bouncer',
				steps: [
					'Add DOCKER-USER to the chains managed by crowdsec-firewall-bouncer.',
					'Restart the bouncer and confirm the chain holds crowdsec sets.',
					'Re-run this check.'
				],
				code: '# /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml\niptables_chains:\n  - INPUT\n  - DOCKER-USER\n\nsudo systemctl restart crowdsec-firewall-bouncer'
			}
		},
		{
			code: 'C1',
			title: 'No detection for the websites',
			detail:
				'CrowdSec reads auth.log, kern.log, and syslog only. Web attacks against the three Caddy sites produce no events, alerts, or decisions.',
			fix: {
				title: 'Acquire and parse proxy access logs',
				steps: [
					'Enable JSON access logs per site in the Caddyfile (T1).',
					'Install the Caddy parser collection (T2).',
					'Add HTTP scenarios so web attacks raise alerts.'
				],
				code: 'sudo cscli collections install crowdsecurity/caddy crowdsecurity/http-cve crowdsecurity/http-probing'
			}
		},
		{
			code: 'C2',
			title: 'No inline WAF',
			detail:
				'The stock caddy:2 image has no CrowdSec module, so there is no inline enforcement or AppSec inspection even if logs were collected.',
			fix: {
				title: 'Add bouncer enforcement and AppSec',
				steps: [
					'Switch to a pinned Caddy build with the bouncer module (T4).',
					'Configure an AppSec acquisition endpoint (T5).'
				]
			}
		},
		{
			code: 'FI',
			title: 'LAPI is unreachable from Docker',
			detail:
				'LAPI binds 127.0.0.1 on the host. A dashboard container cannot reach it without host networking or a scoped bridge binding — never expose it on all interfaces.',
			fix: {
				title: 'Give the dashboard a scoped LAPI path',
				steps: [
					'Prefer running the dashboard with host networking on this host, or',
					'Bind LAPI additionally on the dashboard container network only.',
					'Confirm reachability with the connection check.'
				]
			}
		},
		{
			code: 'C3',
			title: 'Attribution context is missing',
			detail:
				'The crowdsecurity/http_extended context is not installed, so alerts cannot be attributed to a website even once web logs flow.',
			fix: {
				title: 'Install the http_extended context',
				steps: ['Install the context package, then reload CrowdSec.'],
				code: 'sudo cscli contexts install crowdsecurity/http_extended\nsudo systemctl reload crowdsec'
			}
		}
	];

	const measurements: Measurement[] = [
		{ label: 'Active decisions', value: 21286, note: 'all from the community blocklist' },
		{ label: 'Decisions from this host', value: 0 },
		{ label: 'Alerts (24 h)', value: 3, note: 'SSH sources only' },
		{ label: 'CAPI blocklist alerts', value: 71 },
		{ label: 'Log lines parsed (24 h)', value: 4108 },
		{ label: 'WAF blocks (24 h)', value: null, unavailableReason: 'AppSec not configured' }
	];

	const activity = Array.from({ length: 24 }, (_, i) => {
		const atHour = new Date(now.getTime() - (23 - i) * 3_600_000);
		atHour.setMinutes(0, 0, 0);
		const alerts = i === 6 ? 1 : i === 14 ? 2 : 0;
		return { at: atHour.toISOString(), alerts, decisions: 0 };
	});

	return {
		source: 'fixture',
		server: { name: 'reference-host', crowdsecVersion: '1.7.6', lapi: '127.0.0.1:8080' },
		verdict: { state: 'failed', label: 'Websites not protected' },
		inspectedAt: at,
		serverChecks,
		sites,
		observations,
		measurements,
		activity,
		topScenarios: [
			{ name: 'crowdsecurity/ssh-bf', count: 2 },
			{ name: 'crowdsecurity/ssh-bf_user-enum', count: 1 }
		],
		mapPoints: [
			{ x: 552, y: 122, count: 2 }, // CN, ssh-bf ×2
			{ x: 295, y: 170, count: 1 } // US, ssh-bf_user-enum
		]
	};
}

/* ------------------------------------------------------------------ */
/* Fixture: mixed                                                      */
/* ------------------------------------------------------------------ */

export function buildMixedFixture(now: Date = new Date()): OverviewData {
	const at = new Date(now.getTime() - 94_000).toISOString();
	const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

	const verifiedCheck = (method: string, summary: string, evidence: CheckResult['evidence']) =>
		check({ state: 'verified', measuredAt: at, method, summary, evidence });

	const blogChecks: Record<TestId, CheckResult> = {
		logs_read: verifiedCheck('CrowdSec metrics: acquisition', 'Access log acquired and flowing.', [
			{ label: 'Data source', value: '/var/log/caddy/blog.example.com.log' },
			{ label: 'Lines read (24 h)', value: '18,402' }
		]),
		logs_parsed: verifiedCheck('CrowdSec metrics: parsers', '99.7% of acquired lines parse.', [
			{ label: 'Parsed (24 h)', value: '18,349' },
			{ label: 'Unparsed', value: '53' }
		]),
		client_ip: verifiedCheck(
			'Proxy config inspection',
			'trusted_proxies set; real client IP resolved.',
			[
				{ label: 'trusted_proxies', value: 'private ranges' },
				{ label: 'Sample resolved IP', value: '203.0.113.84' }
			]
		),
		bouncer: verifiedCheck('Bouncer metrics', 'Caddy bouncer enforcing; last pull 12 s ago.', [
			{ label: 'Module', value: 'caddy-crowdsec-bouncer v0.14.1' },
			{ label: 'Dropped decisions applied', value: '21,286' }
		]),
		waf: verifiedCheck('AppSec metrics', 'AppSec inspecting; 41 requests blocked (24 h).', [
			{ label: 'Endpoint', value: 'appsec:7422' },
			{ label: 'Collection', value: 'virtual-patching' }
		]),
		edge: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Integration inventory',
			summary: 'Not behind a CDN; edge enforcement not applicable.',
			evidence: [{ label: 'CDN', value: 'none' }],
			nextStep: 'No action needed.'
		})
	};

	const shopChecks: Record<TestId, CheckResult> = {
		logs_read: verifiedCheck('CrowdSec metrics: acquisition', 'Access log acquired and flowing.', [
			{ label: 'Data source', value: '/var/log/caddy/shop.example.com.log' },
			{ label: 'Lines read (24 h)', value: '52,911' }
		]),
		logs_parsed: verifiedCheck('CrowdSec metrics: parsers', '98.9% of acquired lines parse.', [
			{ label: 'Parsed (24 h)', value: '52,322' },
			{ label: 'Unparsed', value: '589' }
		]),
		client_ip: check({
			state: 'failed',
			measuredAt: at,
			method: 'Header spoofing probe',
			summary: 'X-Forwarded-For is honored from any source; client IPs are spoofable.',
			evidence: [
				{ label: 'trusted_proxies', value: 'not set' },
				{ label: 'Probe result', value: 'spoofed IP accepted' }
			],
			nextStep: 'Set trusted_proxies to the Cloudflare ranges for this zone.',
			fix: {
				title: 'Trust only Cloudflare ranges',
				steps: [
					'Add trusted_proxies with the published Cloudflare ranges.',
					'Reload Caddy and re-run the spoofing probe.'
				],
				code: 'shop.example.com {\n\ttrusted_proxies 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22\n}'
			}
		}),
		bouncer: check({
			state: 'degraded',
			measuredAt: at,
			method: 'Bouncer metrics',
			summary: 'Bouncer enforcing but its last decision pull was 26 min ago.',
			evidence: [
				{ label: 'Last pull', value: '26 min ago' },
				{ label: 'Dropped decisions applied', value: '21,240' }
			],
			nextStep: 'Check the bouncer log for LAPI timeouts; LAPI load may be high.'
		}),
		waf: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'CrowdSec config inspection',
			summary: 'AppSec endpoint exists but this site does not forward to it.',
			evidence: [
				{ label: 'AppSec endpoint', value: 'appsec:7422 listening' },
				{ label: 'Site forwarding', value: 'off' }
			],
			nextStep: 'Enable appsec forwarding in this site’s bouncer block.'
		}),
		edge: check({
			state: 'stale',
			measuredAt: ago(181),
			method: 'Cloudflare sync state',
			summary: 'Behind Cloudflare; the edge list is 3 h behind LAPI decisions.',
			evidence: [
				{ label: 'Edge list', value: 'csdash-decisions (21,301 items)' },
				{ label: 'Last sync', value: '3 h ago' },
				{ label: 'Free-plan capacity', value: '21,301 / 10,000+ items — near the 10k guidance' }
			],
			nextStep: 'Investigate the stalled edge sync worker; decisions still enforce at origin.'
		})
	};

	const statusChecks: Record<TestId, CheckResult> = {
		logs_read: check({
			state: 'failed',
			measuredAt: at,
			method: 'CrowdSec metrics: acquisition',
			summary: 'Acquisition configured but the log file is unreadable.',
			evidence: [
				{ label: 'Data source', value: '/var/log/caddy/status.example.com.log' },
				{ label: 'Error', value: 'permission denied (EACCES)' }
			],
			nextStep: 'Mount the log read-only into the CrowdSec view or fix file ownership.',
			fix: {
				title: 'Fix log file permissions',
				steps: [
					'Confirm the caddy container writes the log.',
					'Bind-mount the log file read-only where CrowdSec can read it.',
					'Reload CrowdSec and re-check acquisition metrics.'
				]
			}
		}),
		logs_parsed: check({
			state: 'stale',
			measuredAt: ago(300),
			method: 'CrowdSec metrics: parsers',
			summary: 'Parser healthy, but no lines have arrived for 5 h.',
			evidence: [
				{ label: 'Last parsed line', value: '5 h ago' },
				{ label: 'Unparsed', value: '0' }
			],
			nextStep: 'Follows T1 — restore acquisition first.'
		}),
		client_ip: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Proxy config inspection',
			summary: 'trusted_proxies not evaluated: upstream checks are failing.',
			evidence: [{ label: 'trusted_proxies', value: 'private ranges' }],
			nextStep: 'Re-evaluate once the site is being served again.'
		}),
		bouncer: check({
			state: 'failed',
			measuredAt: at,
			method: 'LAPI auth check',
			summary: 'Bouncer present but LAPI rejects its credentials (401).',
			evidence: [
				{ label: 'Bouncer', value: 'caddy-crowdsec-bouncer v0.14.1' },
				{ label: 'LAPI response', value: '401 unauthorized' }
			],
			nextStep: 'Re-issue the bouncer API key and update the proxy secret.',
			fix: {
				title: 'Re-issue the bouncer key',
				steps: [
					'Create a fresh bouncer API key.',
					'Update the proxy environment secret and restart the proxy.',
					'Confirm the bouncer appears in the registered list.'
				],
				code: 'sudo cscli bouncers add caddy-status-site'
			}
		}),
		waf: check({
			state: 'degraded',
			measuredAt: at,
			method: 'AppSec metrics',
			summary: 'AppSec forwarding on, but 2 of 3 appsec out-of-band checks timed out.',
			evidence: [
				{ label: 'Endpoint', value: 'appsec:7422' },
				{ label: 'Timeouts (24 h)', value: '2' }
			],
			nextStep: 'Watch for repeated timeouts; AppSec should fail-open per config.'
		}),
		edge: check({
			state: 'not_configured',
			measuredAt: at,
			method: 'Integration inventory',
			summary: 'Internal status site; not published through the CDN.',
			evidence: [{ label: 'CDN', value: 'none' }],
			nextStep: 'No action needed.'
		})
	};

	const sites = [
		site('blog.example.com', 'Caddy (Docker)', blogChecks),
		site('shop.example.com', 'Caddy (Docker) · Cloudflare', shopChecks),
		site('status.example.com', 'Caddy (Docker)', statusChecks)
	];

	const serverChecks: ServerCheck[] = [
		{
			id: 'engine',
			label: 'CrowdSec engine',
			state: 'verified',
			detail: 'v1.7.6, native (systemd)',
			measuredAt: at
		},
		{
			id: 'lapi',
			label: 'LAPI',
			state: 'degraded',
			detail: 'Reachable; 3 timeouts during the last inspection window',
			measuredAt: at
		},
		{
			id: 'firewall-bouncer',
			label: 'Firewall bouncer',
			state: 'verified',
			detail: 'INPUT and DOCKER-USER chains covered',
			measuredAt: at
		},
		{
			id: 'blocklist',
			label: 'Community blocklist',
			state: 'verified',
			detail: '21,301 active decisions',
			measuredAt: at
		}
	];

	const observations: Observation[] = [
		{
			code: 'C1',
			title: 'status.example.com has no enforcement',
			detail:
				'Its bouncer fails LAPI authentication (401), so active decisions — including the 21,301 community-blocklist entries — are not applied to this site.',
			fix: {
				title: 'Re-issue the bouncer key',
				steps: [
					'Create a fresh bouncer API key.',
					'Update the proxy secret and restart the proxy.',
					'Re-run this check.'
				],
				code: 'sudo cscli bouncers add caddy-status-site'
			}
		},
		{
			code: 'C2',
			title: 'Client IPs are spoofable on shop.example.com',
			detail:
				'The site honors X-Forwarded-For from any source, so attackers can pick the IP decisions apply to — and poisoning affects allowlists.',
			fix: {
				title: 'Trust only Cloudflare ranges',
				steps: [
					'Set trusted_proxies to the published Cloudflare ranges.',
					'Re-run the spoofing probe.'
				]
			}
		},
		{
			code: 'FI',
			title: 'Edge sync for shop.example.com is 3 h stale',
			detail:
				'The Cloudflare IP list has not caught up with LAPI for 3 h. Origin enforcement still applies; edge coverage is delayed.',
			fix: {
				title: 'Check the edge sync worker',
				steps: [
					'Inspect the worker log for Cloudflare API errors or quota exhaustion.',
					'Free plan allows 1,000 list writes/day — check the quota meter.',
					'Trigger a manual sync, then re-check.'
				]
			}
		},
		{
			code: 'C3',
			title: 'AppSec not enabled on shop.example.com',
			detail:
				'The AppSec endpoint is listening and virtual-patching is installed, but this site does not forward requests to it.',
			fix: {
				title: 'Enable AppSec forwarding for the shop site',
				steps: ['Turn on appsec in the site’s bouncer block, then verify with the WAF probe.']
			}
		}
	];

	const measurements: Measurement[] = [
		{ label: 'Active decisions', value: 21301, note: '21,286 community + 15 local' },
		{ label: 'Decisions from this host', value: 15 },
		{ label: 'Alerts (24 h)', value: 18 },
		{ label: 'CAPI blocklist alerts', value: 71 },
		{ label: 'Log lines parsed (24 h)', value: 70671 },
		{ label: 'WAF blocks (24 h)', value: 41, note: 'blog.example.com only' }
	];

	const activity = Array.from({ length: 24 }, (_, i) => {
		const atHour = new Date(now.getTime() - (23 - i) * 3_600_000);
		atHour.setMinutes(0, 0, 0);
		const alerts = [0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 3, 1, 0, 2, 0, 0, 1, 0, 0, 1, 2, 0, 0, 1][i];
		const decisions = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0][i];
		return { at: atHour.toISOString(), alerts, decisions };
	});

	return {
		source: 'fixture',
		server: { name: 'reference-host', crowdsecVersion: '1.7.6', lapi: '127.0.0.1:8080' },
		verdict: { state: 'degraded', label: 'Protection degraded' },
		inspectedAt: at,
		serverChecks,
		sites,
		observations,
		measurements,
		activity,
		topScenarios: [
			{ name: 'crowdsecurity/http-probing', count: 7 },
			{ name: 'crowdsecurity/ssh-bf', count: 4 },
			{ name: 'crowdsecurity/http-cve', count: 3 },
			{ name: 'crowdsecurity/appsec-generic', count: 2 },
			{ name: 'crowdsecurity/http-sensitive-files', count: 2 }
		],
		mapPoints: [
			{ x: 552, y: 122, count: 7 }, // CN
			{ x: 295, y: 170, count: 5 }, // US
			{ x: 424, y: 96, count: 4 }, // RU
			{ x: 342, y: 224, count: 2 } // BR
		]
	};
}

/** Empty overview for a dashboard not connected to CrowdSec yet. */
export function emptyOverview(): OverviewData {
	return {
		source: 'none',
		server: { name: null, crowdsecVersion: null, lapi: null },
		verdict: null,
		inspectedAt: null,
		serverChecks: [],
		sites: [],
		observations: [],
		measurements: [],
		activity: [],
		topScenarios: [],
		mapPoints: []
	};
}
