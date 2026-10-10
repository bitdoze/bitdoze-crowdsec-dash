#!/usr/bin/env node
/**
 * Benchmarks — measured limits on the REAL schema + a live built server.
 * Query/ingest-level numbers, not a production capacity claim: results
 * reflect this host, this SQLite build, WAL mode, one process.
 *
 *   node scripts/bench.mjs          # boot a scratch server, run, report
 *   BENCH_SCALE=2 node scripts/bench.mjs
 *
 * Covers: alert ingest, attribution writes, list/rollup queries, decision
 * sync selection, in-memory list diff, notification upsert, outbox due
 * selection, retention delete, and live /healthz + /login latency.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { createClient } from '@libsql/client';

// Pick a free port — a crashed earlier run can leave one bound.
const PORT = await new Promise((res) => {
	const s = createServer().listen(0, '127.0.0.1', () => {
		const p = s.address().port;
		s.close(() => res(p));
	});
});
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SCALE = Math.max(0.2, Number(process.env.BENCH_SCALE) || 1);
const dataDir = mkdtempSync(path.join(tmpdir(), 'crowdsec-dash-bench-'));
const dbFile = path.join(dataDir, 'app.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
	const proc = spawn('node', ['server/index.js'], {
		env: {
			...process.env,
			PORT: String(PORT),
			HOST: '127.0.0.1',
			ORIGIN,
			DATA_DIR: dataDir,
			SETUP_TOKEN: 'bench-token',
			SYNC_INTERVAL_MS: '60000',
			NODE_ENV: 'production'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	proc.stdout.resume();
	proc.stderr.on('data', (d) => process.stderr.write(`[bench-app] ${d}`));
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${ORIGIN}/healthz`)).ok) return proc;
		} catch {
			// retry/best-effort
		}
		if (proc.exitCode !== null) throw new Error(`app exited early (${proc.exitCode})`);
		await sleep(150);
	}
	throw new Error('app never answered /healthz');
}

const results = [];
/** time an async block; rows/sec when n given */
async function bench(name, n, fn) {
	const mem0 = process.memoryUsage().rss;
	const t0 = performance.now();
	const out = await fn();
	const ms = performance.now() - t0;
	const mem = Math.round((process.memoryUsage().rss - mem0) / 1e6);
	results.push({
		name,
		n: n ?? null,
		ms: Math.round(ms),
		perSec: n ? Math.round(n / (ms / 1000)) : null,
		detail: out ?? '',
		memDelta: mem
	});
	console.log(
		`  ${name}: ${Math.round(ms)}ms${n ? ` (${Math.round(n / (ms / 1000)).toLocaleString()}/s)` : ''}${out ? ` — ${out}` : ''}`
	);
}

console.log(`scratch: ${dataDir}`);
const app = await boot();
// Crash-safe cleanup — a bench failure must not leak the app or scratch dir.
process.on('exit', () => {
	try {
		app.kill('SIGKILL');
	} catch {
		// retry/best-effort
	}
	rmSync(dataDir, { recursive: true, force: true });
});
const c = createClient({ url: `file:${dbFile}` });
await c.execute('PRAGMA busy_timeout = 30000');

// /healthz can answer before init finishes migrating — wait for schema.
for (let i = 0; i < 50; i++) {
	const { rows } = await c.execute(
		`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='site'`
	);
	if (Number(rows[0].n) === 1) break;
	await sleep(200);
}

const ALERTS = Math.round(5000 * SCALE);
const DECISIONS = Math.round(10000 * SCALE);
const NOTIFS = Math.round(2000 * SCALE);
const SITES = 25;

// -- fixtures ---------------------------------------------------------------
{
	const t = Date.now();
	await c.execute('BEGIN');
	for (let i = 0; i < SITES; i++) {
		await c.execute(
			`INSERT INTO site (id, hostname, source, created_at)
			 VALUES ('site-${i}', 'site${i}.example.com', 'manual', ${t})`
		);
	}
	await c.execute('COMMIT');
}

console.log(`\n== ingest (${ALERTS} alerts + attribution) ==`);
await bench('alert.insert (batch 100)', ALERTS, async () => {
	const t = Date.now();
	for (let b = 0; b < ALERTS; b += 100) {
		await c.execute('BEGIN');
		for (let i = b; i < Math.min(b + 100, ALERTS); i++) {
			await c.execute(
				`INSERT INTO alert (id, upstream_id, scenario, source_ip, source_cn, started_at, synced_at)
				 VALUES ('a${i}', ${i}, 'crowdsecurity/http-bf', '203.0.113.${i % 250}',
				         'DE', ${t - i * 17_280}, ${t})`
			);
		}
		await c.execute('COMMIT');
	}
	return 'WAL, 100-row txns';
});

await bench('alertSite.insert (attribution)', ALERTS, async () => {
	for (let b = 0; b < ALERTS; b += 100) {
		await c.execute('BEGIN');
		for (let i = b; i < Math.min(b + 100, ALERTS); i++) {
			await c.execute(
				`INSERT INTO alert_site (alert_upstream_id, site_id, signal)
				 VALUES (${i}, 'site-${i % SITES}', 'context')`
			);
		}
		await c.execute('COMMIT');
	}
});

console.log(`\n== dashboard query shapes (${ALERTS} alerts) ==`);
await bench('alerts.list (filter+page)', 200, async () => {
	for (let i = 0; i < 200; i++) {
		await c.execute(
			`SELECT id, scenario, source_ip, started_at FROM alert
			 WHERE scenario LIKE 'crowdsecurity/%' AND started_at > ${Date.now() - 86400_000}
			 ORDER BY started_at DESC LIMIT 25 OFFSET ${(i % 10) * 25}`
		);
	}
	return '200 paginated reads';
});

await bench('alerts.byScenario (rollup query)', 50, async () => {
	for (let i = 0; i < 50; i++) {
		await c.execute(
			`SELECT scenario, count(*) AS n FROM alert
			 WHERE started_at > ${Date.now() - 86400_000} GROUP BY scenario ORDER BY n DESC LIMIT 10`
		);
	}
});

await bench('activity.rollup (hourly bucket scan)', 50, async () => {
	for (let i = 0; i < 50; i++) {
		await c.execute(
			`SELECT (started_at / 3600000) * 3600000 AS hour, count(*) AS n
			 FROM alert WHERE started_at > ${Date.now() - 7 * 86400_000}
			 GROUP BY hour ORDER BY hour`
		);
	}
});

await bench('site.attribution join', 50, async () => {
	for (let i = 0; i < 50; i++) {
		await c.execute(
			`SELECT s.hostname, count(*) AS n FROM alert_site a
			 JOIN site s ON s.id = a.site_id GROUP BY a.site_id ORDER BY n DESC LIMIT 10`
		);
	}
});

console.log(`\n== decisions + edge diff (${DECISIONS} rows) ==`);
await bench('decision.insert', DECISIONS, async () => {
	const t = Date.now();
	for (let b = 0; b < DECISIONS; b += 200) {
		await c.execute('BEGIN');
		for (let i = b; i < Math.min(b + 200, DECISIONS); i++) {
			await c.execute(
				`INSERT INTO decision (id, upstream_id, origin, type, scope, value, until, expired, synced_at)
				 VALUES ('d${i}', ${i}, 'crowdsec', 'ban', 'ip', '198.51.100.${i % 250}',
				         ${t + 3600_000}, 0, ${t})`
			);
		}
		await c.execute('COMMIT');
	}
});

let wantedIps;
await bench('edge.candidateSelect', 50, async () => {
	let rows = 0;
	for (let i = 0; i < 50; i++) {
		const r = await c.execute(
			`SELECT value, origin, scope, type, scenario, until, expired FROM decision
			 WHERE expired = 0 AND origin IN ('crowdsec','cscli','crowdsec-appsec')`
		);
		rows = r.rows.length;
	}
	return `${rows} candidates/scan`;
});

await bench('edge.diff (memory, 10k×10k)', 10, async () => {
	const { rows } = await c.execute(`SELECT value FROM decision WHERE expired = 0`);
	wantedIps = new Set(rows.map((r) => r.value));
	for (let i = 0; i < 10; i++) {
		const current = new Set();
		for (let k = 0; k < DECISIONS; k++) current.add(`203.0.113.${k % 250}`);
		let add = 0;
		for (const v of wantedIps) if (!current.has(v)) add++;
		let rem = 0;
		for (const v of current) if (!wantedIps.has(v)) rem++;
		if (i === 0) globalThis.__diffInfo = `+${add} −${rem}`;
	}
	return globalThis.__diffInfo;
});

console.log(`\n== notifications (${NOTIFS} events) ==`);
await bench('notification.upsert (recordEvent shape)', NOTIFS, async () => {
	const t = Date.now();
	for (let i = 0; i < NOTIFS; i++) {
		await c.execute(
			`INSERT INTO notification (id, event_key, class, severity, title, count, created_at, last_at)
			 VALUES ('n${i}', 'bench.key.${i % 50}', 'security', 'warning', 'bench', 1, ${t}, ${t})
			 ON CONFLICT(event_key) DO UPDATE SET count = count + 1, last_at = ${t}`
		);
	}
});

await bench('outbox.dueSelect (dispatch query)', 50, async () => {
	await c.execute(
		`INSERT INTO notification_channel (id, name, type, config, enabled, min_severity, created_at)
		 VALUES ('bchan', 'bench', 'webhook', '{"url":"http://10.0.0.9/hook"}', 1, 'info', ${Date.now()})`
	);
	await c.execute(
		`INSERT INTO notification_outbox (id, notification_id, channel_id, state, attempts, created_at)
		 SELECT 'o' || id, id, 'bchan', 'pending', 0, ${Date.now()} FROM notification LIMIT ${NOTIFS}`
	);
	for (let i = 0; i < 50; i++) {
		await c.execute(
			`SELECT o.id FROM notification_outbox o
			 JOIN notification_channel ch ON ch.id = o.channel_id
			 WHERE o.state = 'pending' AND (o.next_retry_at IS NULL OR o.next_retry_at < ${Date.now()})
			 ORDER BY o.created_at LIMIT 20`
		);
	}
	return `${NOTIFS} pending rows`;
});

console.log(`\n== retention (delete 40% of ${ALERTS}) ==`);
await bench('retention.alertDelete', 1, async () => {
	const cutoff = Date.now() - 86400_000 / 2;
	const r = await c.execute(`DELETE FROM alert WHERE started_at < ${cutoff}`);
	return `${r.rowsAffected} rows deleted`;
});
await bench('retention.outboxDelete', 1, async () => {
	const r = await c.execute(`DELETE FROM notification_outbox WHERE state = 'delivered'`);
	return `${r.rowsAffected} rows deleted`;
});

console.log(`\n== live HTTP (warm, sequential) ==`);
await bench('GET /healthz', 300, async () => {
	for (let i = 0; i < 300; i++) await fetch(`${ORIGIN}/healthz`);
});
await bench('GET /login (render)', 100, async () => {
	for (let i = 0; i < 100; i++) await fetch(`${ORIGIN}/login`);
});

const { rows: pages } = await c.execute('PRAGMA page_count');
const { rows: pageSize } = await c.execute('PRAGMA page_size');
const dbBytes = Number(pages[0].page_count) * Number(pageSize[0].page_size);

console.log(`\n== summary ==`);
console.log(`db size: ${(dbBytes / 1e6).toFixed(1)} MiB`);
console.log(
	`env: ${platform()} ${cpus()[0]?.model} ×${cpus().length}, ${(totalmem() / 1e9).toFixed(0)} GiB, node ${process.version}`
);
console.log(`\n| benchmark | n | ms | ops/s | note |`);
console.log(`|---|---:|---:|---:|---|`);
for (const r of results) {
	console.log(
		`| ${r.name} | ${r.n ?? '—'} | ${r.ms} | ${r.perSec?.toLocaleString() ?? '—'} | ${r.detail} |`
	);
}

c.close();
app.kill('SIGTERM');
await Promise.race([once(app, 'exit'), sleep(5_000)]);
rmSync(dataDir, { recursive: true, force: true });
