/**
 * Mock CrowdSec LAPI + Prometheus endpoint for e2e runs. One small node
 * server on :8090 that speaks just enough of the watcher API for the
 * connect/sync flows: login, paged alerts, and a metrics scrape.
 */
import { createServer } from 'node:http';

// Dates are relative to now so rollups, the attack map, and the 24h windows
// always see the fixture alerts regardless of when the suite runs.
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const ALERTS = [
	{
		id: 2,
		scenario: 'crowdsecurity/http-probing',
		message: 'Ip 203.0.113.7 performed probing',
		created_at: ago(1),
		started_at: ago(1.05),
		stopped_at: ago(1),
		events_count: 42,
		source: {
			scope: 'Ip',
			value: '203.0.113.7',
			ip: '203.0.113.7',
			cn: 'US',
			latitude: 38.9,
			longitude: -77.0,
			as_name: 'EXAMPLENET',
			as_number: '64512'
		},
		decisions: [
			{
				id: 21,
				origin: 'crowdsec',
				type: 'ban',
				scope: 'Ip',
				value: '203.0.113.7',
				duration: '4h',
				scenario: 'crowdsecurity/http-probing',
				until: '2999-01-01T00:00:00Z'
			}
		],
		context: [{ key: 'target_fqdn', value: 'blog.example.com' }],
		events: [{ meta: [{ key: 'service', value: 'http' }] }]
	},
	{
		id: 3,
		scenario: 'crowdsecurity/ssh-bf',
		message: 'Ip 198.51.100.23 performed ssh-bf',
		created_at: ago(2),
		started_at: ago(2.03),
		stopped_at: ago(2),
		events_count: 12,
		source: {
			scope: 'Ip',
			value: '198.51.100.23',
			ip: '198.51.100.23',
			cn: 'NL',
			latitude: 52.37,
			longitude: 4.9
		},
		decisions: [
			{
				id: 22,
				origin: 'crowdsec',
				type: 'ban',
				scope: 'Ip',
				value: '198.51.100.23',
				duration: '24h',
				scenario: 'crowdsecurity/ssh-bf',
				until: '2000-01-01T00:00:00Z'
			}
		],
		context: [],
		events: [{ meta: [{ key: 'service', value: 'ssh' }] }]
	},
	{
		id: 4,
		scenario: 'crowdsecurity/community-blocklist',
		message: 'CAPI-sourced alert — must be skipped',
		created_at: ago(3),
		started_at: ago(3),
		stopped_at: ago(3),
		source: { scope: 'Ip', value: '192.0.2.1', ip: '192.0.2.1' },
		decisions: [{ id: 23, origin: 'CAPI', type: 'ban', scope: 'Ip', value: '192.0.2.1' }],
		context: [],
		events: []
	}
];

const METRICS = `# TYPE cs_info gauge
cs_info{version="v1.7.6-mock"} 1
cs_active_decisions{action="ban",origin="CAPI",scenario=""} 21286
cs_active_decisions{action="ban",origin="crowdsec",scenario="crowdsecurity/http-probing"} 1
cs_parser_hits_total{source="/var/log/caddy/blog.log"} 1234
cs_parser_hits_ok_total{source="/var/log/caddy/blog.log"} 1200
cs_parser_hits_ko_total{source="/var/log/caddy/blog.log"} 34
cs_lapi_requests_total{endpoint="/v1/alerts",method="get"} 9
`;

let down = false;

// Manual decisions pushed via POST /v1/alerts — surfaced back through
// GET /v1/alerts so the projection confirms them like a real LAPI.
let nextAlertId = 100;
let nextDecisionId = 9100;
const manualAlerts = [];
const deletedDecisions = new Set();
let lastHookBody = null;

// Centralized allowlist fixture — covers one address for the check flow.
const ALLOWLISTS = [
	{
		id: 1,
		name: 'office-egress',
		description: 'Office egress IPs',
		created_at: ago(500),
		updated_at: ago(500),
		items: ['198.51.100.23']
	}
];

const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://x');
	const json = (code, body) => {
		res.writeHead(code, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(body));
	};

	// Test-only kill switch: /_down?set=1|0 flips all endpoints to 503.
	if (url.pathname === '/_down') {
		down = url.searchParams.get('set') === '1';
		json(200, { down });
		return;
	}

	// Fake website for the topology probe: serves headers that detect.ts
	// recognises (Server: Caddy + a Cloudflare ray id).
	if (url.pathname === '/_site') {
		res.writeHead(200, {
			'Content-Type': 'text/html',
			Server: 'Caddy',
			'CF-Ray': 'abc123-FRA'
		});
		res.end('<html>ok</html>');
		return;
	}

	// Alert injector for the verification-check e2e: POST /_inject with
	// {scenario, fqdn} pushes a synthetic alert into the GET stream.
	if (url.pathname === '/_inject' && req.method === 'POST') {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const { scenario, fqdn, ip } = JSON.parse(body || '{}');
			manualAlerts.push({
				id: nextAlertId++,
				scenario: scenario ?? 'crowdsecurity/http-generic-test',
				message: `injected ${scenario ?? 'test'} alert`,
				created_at: new Date().toISOString(),
				started_at: new Date().toISOString(),
				stopped_at: new Date().toISOString(),
				source: { scope: 'Ip', value: ip ?? '203.0.113.99', ip: ip ?? '203.0.113.99' },
				decisions: [],
				context: fqdn ? [{ key: 'target_fqdn', value: fqdn }] : [],
				events: [{ meta: [{ key: 'service', value: 'http' }] }]
			});
			json(200, { ok: true });
		});
		return;
	}

	// Webhook receiver for notification-delivery e2e: POST /_hook records the
	// body; GET /_hook/last returns it. The dashboard's SSRF guard allows
	// RFC1918 destinations, so tests POST to the host's LAN address.
	if (url.pathname === '/_hook' && req.method === 'POST') {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			lastHookBody = body;
			json(200, { ok: true });
		});
		return;
	}
	if (url.pathname === '/_hook/last' && req.method === 'GET') {
		json(200, { body: lastHookBody });
		return;
	}
	if (down) {
		json(503, { message: 'mock outage' });
		return;
	}

	if (url.pathname === '/v1/watchers/login' && req.method === 'POST') {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const { machine_id, password } = JSON.parse(body || '{}');
			if (machine_id === 'e2e-machine' && password === 'e2e-password') {
				json(200, { token: 'e2e-jwt', expire: '2999-01-01T00:00:00Z' });
			} else {
				json(401, { message: 'bad credentials' });
			}
		});
		return;
	}

	if (url.pathname === '/metrics' || url.pathname === '/v1/metrics') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end(METRICS);
		return;
	}

	// Observer-bouncer lookup: keyed by the bouncer key, not the watcher JWT.
	if (url.pathname === '/v1/decisions') {
		if (req.headers.authorization !== 'Bearer e2e-bouncer-key') {
			json(401, { message: 'unauthorized' });
			return;
		}
		const ip = url.searchParams.get('ip');
		json(
			200,
			ip === '203.0.113.7'
				? [
						{
							id: 9001,
							origin: 'CAPI',
							type: 'ban',
							scope: 'Ip',
							value: '203.0.113.7',
							duration: '72h',
							scenario: 'crowdsecurity/community-blocklist'
						},
						{
							id: 9002,
							origin: 'crowdsec',
							type: 'ban',
							scope: 'Ip',
							value: '203.0.113.7',
							duration: '4h',
							scenario: 'crowdsecurity/http-probing'
						}
					]
				: []
		);
		return;
	}

	if (req.headers.authorization !== 'Bearer e2e-jwt') {
		json(401, { message: 'unauthorized' });
		return;
	}

	// Manual decision write path (watcher credential): POST /v1/alerts with a
	// decision body → stored and returned by subsequent GET /v1/alerts.
	if (url.pathname === '/v1/alerts' && req.method === 'POST') {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const alerts = JSON.parse(body || '[]');
			const ids = [];
			for (const a of alerts) {
				const alertId = nextAlertId++;
				const decisions = (a.decisions ?? []).map((d, i) => ({
					id: nextDecisionId++,
					uuid: `mock-${alertId}-${i}`,
					origin: d.origin ?? 'manual',
					type: d.type,
					scope: d.scope === 'ip' ? 'Ip' : 'Range',
					value: d.value,
					duration: d.duration,
					scenario: a.scenario ?? 'manual',
					until: new Date(Date.now() + 4 * 3_600_000).toISOString(),
					simulated: false
				}));
				manualAlerts.push({
					id: alertId,
					scenario: a.scenario ?? 'manual',
					message: a.message ?? 'manual decision via dashboard',
					created_at: new Date().toISOString(),
					started_at: new Date().toISOString(),
					stopped_at: new Date().toISOString(),
					source: a.source ?? {},
					decisions,
					context: [],
					events: []
				});
				ids.push(alertId);
			}
			json(200, ids);
		});
		return;
	}

	// Decision removal (watcher): DELETE /v1/decisions/:id
	const delMatch = /^\/v1\/decisions\/(\d+)$/.exec(url.pathname);
	if (delMatch && req.method === 'DELETE') {
		deletedDecisions.add(Number(delMatch[1]));
		json(200, { nbDeleted: 1 });
		return;
	}

	if (url.pathname === '/v1/allowlists' && req.method === 'GET') {
		json(200, ALLOWLISTS);
		return;
	}

	const allowMatch = /^\/v1\/allowlists\/check\/(.+)$/.exec(url.pathname);
	if (allowMatch && req.method === 'GET') {
		const ip = decodeURIComponent(allowMatch[1]);
		const covered = ALLOWLISTS.filter((l) => l.items.includes(ip));
		json(200, { address: ip, allowlists: covered });
		return;
	}

	if (url.pathname === '/v1/alerts' && req.method === 'GET') {
		// Fixture set + pushed manual decisions, minus any deleted ones —
		// the projection upserts by upstream id so re-delivery is idempotent.
		const all = [...ALERTS, ...manualAlerts].map((a) => ({
			...a,
			decisions: a.decisions.filter((d) => !deletedDecisions.has(d.id))
		}));
		json(200, all);
		return;
	}
	json(404, { message: 'not found' });
});

// Bind all interfaces so the SSRF-safe webhook test can reach us via the
// host's LAN address (loopback destinations are correctly rejected).
server.listen(8090, '0.0.0.0', () => console.log('mock LAPI on :8090'));
