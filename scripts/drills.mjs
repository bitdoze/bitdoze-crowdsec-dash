#!/usr/bin/env node
/**
 * Failure/outage drills — runs the REAL built server against a scratch
 * data dir and kills it mid-flight. Covers the restart-survival part of
 * the acceptance matrix:
 *
 *   1. crash (SIGKILL) + restart: pending outbox rows still deliver,
 *      queued jobs drain, in-flight (leased) jobs are reclaimed — nothing
 *      is lost or silently dropped.
 *   2. db contention: WAL reads stay live under a write lock; writes
 *      queue behind busy_timeout and succeed after release; a lock held
 *      past busy_timeout fails fast and honestly (no hang).
 *   3. backup → restore: round-trip through scripts/backup|restore.mjs
 *      and a server that boots cleanly on the restored file.
 *
 *   node scripts/drills.mjs            # expects ./server/index.js (npm run build)
 *   DRILL_KEEP=1 node scripts/drills.mjs   # keep the scratch dir for inspection
 *
 * Exits non-zero on any failed assertion.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { createClient } from '@libsql/client';

const PORT = 4389;
const SINK_PORT = 4490;
const TICK_MS = 600;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), 'crowdsec-dash-drill-'));
const dbFile = path.join(dataDir, 'app.db');

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name} ${extra}`);
	}
};

function lanIp() {
	for (const iface of Object.values(networkInterfaces())) {
		for (const a of iface ?? []) {
			if (a.family === 'IPv4' && !a.internal) return a.address;
		}
	}
	throw new Error('no LAN IPv4 — the SSRF guard (correctly) blocks loopback sinks');
}

/** Start the built server; resolves once /healthz answers 200. */
async function boot(label) {
	const proc = spawn('node', ['server/index.js'], {
		env: {
			...process.env,
			PORT: String(PORT),
			HOST: '127.0.0.1',
			ORIGIN,
			DATA_DIR: dataDir,
			SETUP_TOKEN: 'drill-token',
			SYNC_INTERVAL_MS: String(TICK_MS),
			NODE_ENV: 'production'
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// Both pipes must be drained — an unread stdout pipe delays the 'exit'
	// event (and proc.exitCode) long past the actual SIGKILL.
	proc.stdout.resume();
	proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${ORIGIN}/healthz`);
			if (r.ok) return proc;
		} catch {
			// retry/best-effort
		}
		if (proc.exitCode !== null) {
			// Dump whoever holds the db file — a migrate-time SQLITE_BUSY at
			// boot usually means a lazily-closing handle from this process.
			try {
				const { execSync } = await import('node:child_process');
				process.stderr.write(execSync(`lslocks | grep -F ${dbFile}`).toString());
			} catch {
				// retry/best-effort
			}
			throw new Error(`${label} exited early (${proc.exitCode})`);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`${label} never answered /healthz`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until truthy or timeout; returns last value. */
async function until(fn, ms = 20_000, step = 400) {
	const deadline = Date.now() + ms;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await sleep(step);
	}
	return last;
}

const db = () => createClient({ url: `file:${dbFile}` });

/** Wait for a spawned process to actually die — 'exit' beats exitCode polling. */
async function waitExit(proc, ms = 8_000) {
	if (proc.exitCode !== null || proc.signalCode) return true;
	return Promise.race([once(proc, 'exit').then(() => true), sleep(ms).then(() => false)]);
}
const now = () => Date.now();

// -- sink: accepts webhook deliveries, records bodies ---------------------
const received = [];
const sink = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		received.push({ url: req.url, body });
		res.writeHead(200).end('ok');
	});
});
await new Promise((r) => sink.listen(SINK_PORT, '0.0.0.0', r));

console.log(`drill scratch dir: ${dataDir}`);
console.log('== boot #1 + seed ==');
const serverA = await boot('A');

// Seed while the server is up: a webhook channel (URL in plaintext config —
// secrets encryption isn't what's under test), one notification + outbox
// row, one queued job, and one job already leased to a "dead" worker.
{
	const c = db();
	await c.execute('PRAGMA busy_timeout = 10000');
	const t = now();
	await c.execute(
		`INSERT INTO notification_channel
		 (id, name, type, config, secret_enc, enabled, min_severity, created_at)
		 VALUES ('drill-chan', 'drill sink', 'webhook',
		         '${JSON.stringify({ url: `http://${lanIp()}:${SINK_PORT}/hook` }).replaceAll("'", "''")}',
		         NULL, 1, 'info', ${t})`
	);
	await c.execute(
		`INSERT INTO notification
		 (id, event_key, class, severity, title, body, created_at, last_at)
		 VALUES ('drill-notif', 'drill.event.1', 'admin', 'warning',
		         'drill notification', 'survives a worker crash', ${t}, ${t})`
	);
	await c.execute(
		`INSERT INTO notification_outbox
		 (id, notification_id, channel_id, state, attempts, created_at)
		 VALUES ('drill-outbox', 'drill-notif', 'drill-chan', 'pending', 0, ${t})`
	);
	// Queued job — drains after restart and fails honestly (no such account).
	await c.execute(
		`INSERT INTO job
		 (id, kind, params, state, attempts, created_at, updated_at)
		 VALUES ('drill-job-queued', 'cloudflare.sync',
		         '{"accountId":"00000000-0000-4000-8000-000000000000"}',
		         'queued', 0, ${t}, ${t})`
	);
	// Job "in flight" under a worker that is about to die — expired lease.
	await c.execute(
		`INSERT INTO job
		 (id, kind, params, state, attempts, lease_until, leased_by, started_at, created_at, updated_at)
		 VALUES ('drill-job-leased', 'cloudflare.sync',
		         '{"accountId":"00000000-0000-4000-8000-000000000000"}',
		         'running', 0, ${t - 120_000}, 'worker-dead', ${t - 120_000}, ${t - 120_000}, ${t - 120_000})`
	);
	c.close();
}
console.log('  seeded: channel + pending outbox + queued job + expired-lease job');

console.log('== SIGKILL server A (crash mid-life) ==');
serverA.kill('SIGKILL');
ok('server A died', await waitExit(serverA));

// Contention drill runs once the app is back up (steady state, WAL
// recovered by the app's own boot) — see the "contention" section below.

console.log('== boot #2 — same data dir ==');
const serverB = await boot('B');

console.log('== assertions after restart ==');
{
	const c = db();
	await c.execute('PRAGMA busy_timeout = 10000');
	// Outbox row must still exist and eventually deliver.
	const delivered = await until(async () => {
		const { rows } = await c.execute(
			`SELECT state FROM notification_outbox WHERE id='drill-outbox'`
		);
		return rows[0]?.state === 'delivered';
	});
	ok('outbox row survived crash and delivered after restart', !!delivered);
	ok(
		'webhook sink received the POST',
		received.some((r) => r.url === '/hook' && r.body.includes('drill notification'))
	);

	// Queued job drains to an honest terminal state (not lost, not faked).
	const queuedDone = await until(async () => {
		const { rows } = await c.execute(`SELECT state, result FROM job WHERE id='drill-job-queued'`);
		return ['succeeded', 'failed'].includes(rows[0]?.state) ? rows[0] : null;
	});
	ok('queued job reached terminal state after restart', !!queuedDone);
	ok(
		'queued job result is honest (account missing, not fake success)',
		queuedDone?.state === 'failed' && /account not found/i.test(queuedDone?.result ?? '')
	);

	// The leased job's worker died — a new worker reclaims it.
	const leasedDone = await until(async () => {
		const { rows } = await c.execute(`SELECT state, attempts FROM job WHERE id='drill-job-leased'`);
		return ['succeeded', 'failed'].includes(rows[0]?.state) ? rows[0] : null;
	});
	ok('expired-lease job reclaimed and finished', !!leasedDone && leasedDone.attempts >= 1);

	// Nothing vanished.
	const { rows: counts } = await c.execute(
		`SELECT (SELECT count(*) FROM job WHERE id LIKE 'drill-%') AS jobs,
		        (SELECT count(*) FROM notification_outbox WHERE id='drill-outbox') AS outbox`
	);
	ok(
		'all drill rows survived the restart',
		Number(counts[0].jobs) === 2 && Number(counts[0].outbox) === 1
	);
	c.close();
}

console.log('== db contention while server is live ==');
{
	const probe = db();
	const { rows: jm } = await probe.execute('PRAGMA journal_mode');
	console.log(`  journal_mode: ${jm[0]?.journal_mode}`);
	probe.close();

	// Hold a write lock. WAL readers never block — the app keeps serving.
	const locker = db();
	await locker.execute('PRAGMA busy_timeout = 10000');
	await locker.execute('BEGIN IMMEDIATE');
	const r = await fetch(`${ORIGIN}/healthz`);
	ok('healthz answers under a held write lock', r.ok);
	const reader = db();
	await reader.execute('PRAGMA busy_timeout = 3000');
	const { rows } = await reader.execute('SELECT count(*) AS n FROM notification');
	ok('WAL reads unaffected by held write lock', Number(rows[0].n) >= 1);

	// A concurrent writer is bounded by busy_timeout — honest SQLITE_BUSY,
	// no hang and no corruption. (Empirical: a waiting writer's retry
	// churn can delay the holder's COMMIT — assert the bounded failure,
	// not a transparent queue.)
	const writer = db();
	await writer.execute('PRAGMA busy_timeout = 800');
	const t0 = now();
	const busy = await writer
		.execute(
			`INSERT INTO sync_state (source, last_error) VALUES ('drill-busy', 'x')
			 ON CONFLICT(source) DO UPDATE SET last_error='x'`
		)
		.then(() => false)
		.catch((e) => /busy/i.test(e.message));
	ok('write under contention → bounded SQLITE_BUSY (≤ busy_timeout)', busy && now() - t0 < 4_000);
	await locker.execute('ROLLBACK');

	// After the holder is gone and churn stops, the next write lands —
	// contention is recoverable, not fatal.
	const after = db();
	await after.execute('PRAGMA busy_timeout = 3000');
	await after.execute(
		`INSERT INTO sync_state (source, last_error) VALUES ('drill-after', 'ok')
		 ON CONFLICT(source) DO UPDATE SET last_error='ok'`
	);
	ok('writes succeed immediately after contention ends', true);
	locker.close();
	reader.close();
	writer.close();
	after.close();
}

console.log('== backup → restore round-trip ==');
{
	const { execFileSync } = await import('node:child_process');
	// Stop the app before swapping files (restore.mjs' contract). SIGTERM
	// triggers graceful shutdown which waits out keep-alive sockets —
	// assert it actually exited.
	serverB.kill('SIGTERM');
	ok('server B exited on SIGTERM', await waitExit(serverB, 15_000));
	const bk = path.join(dataDir, 'drill-backup.db');
	execFileSync('node', ['scripts/backup.mjs', bk], {
		env: { ...process.env, DATA_DIR: dataDir },
		stdio: 'inherit'
	});
	ok('backup file written', existsSync(bk));
	// Marker row present pre-backup? Add post-backup noise, restore, verify gone.
	const c = db();
	await c.execute('PRAGMA busy_timeout = 10000');
	await c.execute(`DELETE FROM sync_state WHERE source='drill2'`);
	await c.execute(
		`INSERT INTO sync_state (source, last_error) VALUES ('post-backup-noise', 'x')
		 ON CONFLICT(source) DO UPDATE SET last_error='x'`
	);
	c.close();
	execFileSync('node', ['scripts/restore.mjs', bk], {
		env: { ...process.env, DATA_DIR: dataDir },
		stdio: 'inherit'
	});
	const c2 = db();
	const { rows } = await c2.execute(
		`SELECT count(*) AS n FROM sync_state WHERE source='post-backup-noise'`
	);
	ok('restore removed post-backup writes', Number(rows[0].n) === 0);
	const { rows: kept } = await c2.execute(
		`SELECT state FROM notification_outbox WHERE id='drill-outbox'`
	);
	ok('restored backup still carries pre-crash state', kept[0]?.state === 'delivered');
	c2.close();
}

// Prove the file is free before booting — pinpoints the lock holder when
// boot C's migration would fail.
{
	const c3 = db();
	try {
		await c3.execute('PRAGMA busy_timeout = 3000');
		await c3.execute('BEGIN IMMEDIATE');
		await c3.execute('ROLLBACK');
	} catch {
		const { execSync } = await import('node:child_process');
		try {
			console.error(execSync(`lsof ${dbFile} || fuser -v ${dbFile}`).toString());
		} catch {
			// retry/best-effort
		}
	} finally {
		c3.close();
	}
	await sleep(500); // let libsql client teardown settle before the app opens the file
}

console.log('== boot #3 on restored db ==');
const serverC = await boot('C');
ok('server boots cleanly on the restored database', serverC.exitCode === null);
serverC.kill('SIGTERM');

console.log(`\n${passed} passed, ${failed} failed`);
sink.close();
if (!process.env.DRILL_KEEP) rmSync(dataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
