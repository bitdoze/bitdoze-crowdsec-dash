/**
 * Mock CrowdSec LAPI + Prometheus endpoint for e2e runs. One small node
 * server on :8090 that speaks just enough of the watcher API for the
 * connect/sync flows: login, paged alerts, and a metrics scrape.
 */
import { createServer } from 'node:http';

const ALERTS = [
	{
		id: 2,
		scenario: 'crowdsecurity/http-probing',
		message: 'Ip 203.0.113.7 performed probing',
		created_at: '2026-10-09T12:00:00Z',
		started_at: '2026-10-09T11:59:00Z',
		stopped_at: '2026-10-09T12:00:00Z',
		events_count: 42,
		source: {
			scope: 'Ip',
			value: '203.0.113.7',
			ip: '203.0.113.7',
			cn: 'US',
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
		created_at: '2026-10-09T13:00:00Z',
		started_at: '2026-10-09T12:58:00Z',
		stopped_at: '2026-10-09T13:00:00Z',
		events_count: 12,
		source: { scope: 'Ip', value: '198.51.100.23', ip: '198.51.100.23', cn: 'NL' },
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
		created_at: '2026-10-09T14:00:00Z',
		started_at: '2026-10-09T14:00:00Z',
		stopped_at: '2026-10-09T14:00:00Z',
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

	if (req.headers.authorization !== 'Bearer e2e-jwt') {
		json(401, { message: 'unauthorized' });
		return;
	}

	if (url.pathname === '/v1/alerts') {
		// Always return the fixture set — the projection upserts by upstream
		// id, so re-delivery is idempotent and exercises the overlap path.
		json(200, ALERTS);
		return;
	}
	json(404, { message: 'not found' });
});

server.listen(8090, '127.0.0.1', () => console.log('mock LAPI on :8090'));
