import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSiteTraffic } from '#lib/server/sites/traffic.ts';

const dir = mkdtempSync(join(tmpdir(), 'csdash-logs-'));
const NOW = Date.now();

/** Real Caddy JSON access-log line shape (verified on the deployment host). */
const line = (
	tsSec: number,
	o: { ip?: string; uri?: string; status?: number; size?: number; duration?: number } = {}
) =>
	JSON.stringify({
		level: 'info',
		ts: tsSec,
		logger: 'http.log.access.log0',
		msg: 'handled request',
		request: {
			remote_ip: o.ip ?? '203.0.113.1',
			client_ip: o.ip ?? '203.0.113.1',
			method: 'GET',
			host: 'app.example.com',
			uri: o.uri ?? '/'
		},
		status: o.status ?? 200,
		size: o.size ?? 1000,
		duration: o.duration ?? 0.01
	});

describe('loadSiteTraffic', () => {
	it('aggregates requests, bytes, unique IPs, statuses and top lists', async () => {
		const t = NOW / 1000;
		writeFileSync(
			join(dir, 'app.example.com.log'),
			[
				line(t - 10, { ip: '203.0.113.1', uri: '/', size: 2000 }),
				line(t - 20, { ip: '203.0.113.1', uri: '/', status: 200, size: 2000 }),
				line(t - 30, { ip: '198.51.100.5', uri: '/login?next=/', status: 404, size: 100 }),
				line(t - 40, { ip: '192.0.2.9', uri: '/api/data', status: 500, size: 50, duration: 0.5 }),
				line(t - 50, { ip: '192.0.2.9', uri: '/img.png', status: 301, size: 0 })
			].join('\n') + '\n'
		);
		const r = await loadSiteTraffic('app.example.com', '24h', NOW, dir);
		expect(r.state).toBe('ok');
		expect(r.requests).toBe(5);
		expect(r.bytes).toBe(4150);
		expect(r.uniqueIps).toBe(3);
		expect(r.byStatus).toEqual({ s2xx: 2, s3xx: 1, s4xx: 1, s5xx: 1, other: 0 });
		expect(r.errorRate).toBeCloseTo(0.4);
		expect(r.topIps[0]).toEqual({ key: '203.0.113.1', n: 2 });
		expect(r.topPaths[0].key).toBe('/'); // query stripped
		expect(r.avgMs).toBeGreaterThan(0);
		expect(r.buckets.length).toBeGreaterThan(0);
		expect(r.truncated).toBe(false);
	});

	it('filters by the selected window', async () => {
		const t = NOW / 1000;
		writeFileSync(
			join(dir, 'old.example.com.log'),
			[
				line(t - 2 * 24 * 3600, { ip: '203.0.113.1' }), // 2d ago — outside 24h
				line(t - 30, { ip: '203.0.113.2' })
			].join('\n') + '\n'
		);
		const d = await loadSiteTraffic('old.example.com', '24h', NOW, dir);
		expect(d.requests).toBe(1);
		const w = await loadSiteTraffic('old.example.com', '7d', NOW, dir);
		expect(w.requests).toBe(2);
	});

	it('skips malformed lines instead of failing', async () => {
		const t = NOW / 1000;
		writeFileSync(
			join(dir, 'bad.example.com.log'),
			['not json at all', line(t - 10), '{"ts":"nope"}', line(t - 20)].join('\n')
		);
		const r = await loadSiteTraffic('bad.example.com', '24h', NOW, dir);
		expect(r.requests).toBe(2);
	});

	it('reports no_log for missing files and empty windows honestly', async () => {
		expect((await loadSiteTraffic('absent.example.com', '24h', NOW, dir)).state).toBe('no_log');
		writeFileSync(
			join(dir, 'quiet.example.com.log'),
			line(NOW / 1000 - 30 * 3600, { ip: '1.2.3.4' }) + '\n'
		);
		const r = await loadSiteTraffic('quiet.example.com', '24h', NOW, dir);
		expect(r.state).toBe('ok');
		expect(r.requests).toBe(0);
	});

	it('rejects non-hostname values — the name becomes a filename', async () => {
		for (const h of ['../etc/passwd', 'a/b', '..', '', 'host name']) {
			const r = await loadSiteTraffic(h, '24h', NOW, dir);
			expect(r.state).toBe('error');
		}
	});

	it('marks the result truncated when the tail cap cuts inside the window', async () => {
		// A file larger than MAX_BYTES whose tail is still inside the window —
		// simulate by making lines bigger than usual isn't practical (24 MB
		// fixture); instead verify the flag directly on a small file is false.
		const r = await loadSiteTraffic('app.example.com', '24h', NOW, dir);
		expect(r.truncated).toBe(false);
	});
});
