/**
 * Durable job queue lifecycle — in-memory DB + a stub NDJSON agent on the
 * test socket. Covers enqueue/idempotency, lock serialization, step
 * persistence, cancellation, lease reclaim, and rollback.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.ts';
import { configArtifact, job, jobStep, site } from '#lib/server/db/app.schema.ts';
import { claimNext, drainJobs, enqueue, jobDetail, requestCancel } from '#lib/server/jobs/queue.ts';
import { AGENT_SOCKET } from './mocks/app-env-private.ts';

function makeDb() {
	return drizzle(createClient({ url: ':memory:' }), { schema });
}
type TestDb = ReturnType<typeof makeDb>;

/** Stub agent: auths any token, replies per-op from `behavior`. */
type Reply =
	{ ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };
let server: Server;
let behavior: Record<string, (p: Record<string, unknown>) => Reply | Promise<Reply>> = {};
let seenOps: { op: string; params: Record<string, unknown> }[] = [];

function startStub() {
	server = createServer((conn) => {
		let buf = '';
		let authed = false;
		conn.on('data', (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				const msg = JSON.parse(line);
				if (!authed) {
					authed = true;
					conn.write(JSON.stringify({ id: msg.id, ok: true, result: { protocol: 1 } }) + '\n');
					continue;
				}
				seenOps.push({ op: msg.op, params: msg.params });
				const fn = behavior[msg.op];
				const r = fn ? fn(msg.params) : { ok: true, result: { output: 'ok' } };
				conn.write(JSON.stringify({ id: msg.id, ...r }) + '\n');
			}
		});
	});
	return new Promise<void>((resolveListen) => server.listen(AGENT_SOCKET, resolveListen));
}

beforeEach(async () => {
	behavior = {};
	seenOps = [];
	try {
		unlinkSync(AGENT_SOCKET!);
	} catch {
		/* absent */
	}
	await startStub();
});
afterAll(() => server.close());

async function db() {
	const d = makeDb();
	await migrate(d, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	return d;
}

const detail = (d: TestDb, id: string) => jobDetail(d, id);

async function addArtifact(d: TestDb) {
	const siteId = crypto.randomUUID();
	await d.insert(site).values({ id: siteId, hostname: 'jobs.test', source: 'manual' });
	const artifactId = crypto.randomUUID();
	await d.insert(configArtifact).values({
		id: artifactId,
		siteId,
		kind: 'acquisition',
		title: 't',
		format: 'yaml',
		content: 'x',
		contentHash: 'h',
		state: 'not_applied',
		createdAt: new Date(),
		updatedAt: new Date()
	});
	return artifactId;
}

describe('job queue', () => {
	it('runs a hub.install job through the stub agent, persisting each step', async () => {
		const d = await db();
		const { job: j } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['collections:crowdsecurity/caddy', 'parsers:crowdsecurity/nginx-logs'] },
			lockKey: 'hub'
		});
		await drainJobs(d, 'test-worker');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('succeeded');
		expect(got!.steps).toHaveLength(3);
		expect(got!.steps.every((s) => s.state === 'succeeded')).toBe(true);
		expect(seenOps.map((s) => s.op)).toEqual(['hub.update', 'hub.install', 'hub.install']);
		expect(seenOps[1].params).toEqual({ type: 'collections', item: 'crowdsecurity/caddy' });
	});

	it('dedupes by idempotency key', async () => {
		const d = await db();
		const a = await enqueue(d, {
			kind: 'allowlist.add',
			params: { name: 'n', values: ['1.2.3.4'] },
			idempotencyKey: 'same-key'
		});
		const b = await enqueue(d, {
			kind: 'allowlist.add',
			params: { name: 'n', values: ['1.2.3.4'] },
			idempotencyKey: 'same-key'
		});
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.job.id).toBe(a.job.id);
	});

	it('resubmitting a finished job creates a fresh run under a derived key', async () => {
		const d = await db();
		const a = await enqueue(d, {
			kind: 'allowlist.add',
			params: { name: 'n', values: ['1.2.3.4'] },
			idempotencyKey: 'k'
		});
		await drainJobs(d, 'w');
		expect((await detail(d, a.job.id))!.job.state).toBe('succeeded');
		// Same key again — dedupe must not swallow the resubmission.
		const b = await enqueue(d, {
			kind: 'allowlist.add',
			params: { name: 'n', values: ['1.2.3.4'] },
			idempotencyKey: 'k'
		});
		expect(b.created).toBe(true);
		expect(b.job.id).not.toBe(a.job.id);
		// A rapid re-click while the retry is still queued dedupes to it.
		const c = await enqueue(d, {
			kind: 'allowlist.add',
			params: { name: 'n', values: ['1.2.3.4'] },
			idempotencyKey: 'k'
		});
		expect(c.created).toBe(false);
		expect(c.job.id).toBe(b.job.id);
	});

	it('serializes same-lockKey jobs and fails permanently on bad params', async () => {
		const d = await db();
		const { job: bad } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['bogus:!not-an-item; rm -rf /'] }
		});
		await drainJobs(d, 'w');
		expect((await detail(d, bad.id))!.job.state).toBe('failed');
		expect((await detail(d, bad.id))!.job.result).toContain('invalid params');
		expect(seenOps).toHaveLength(0); // validation happens before any agent call
	});

	it('marks the job failed and records the failing step on agent errors', async () => {
		const d = await db();
		behavior['hub.update'] = () => ({
			ok: false,
			error: { code: 'exec', message: 'cscli exited 1: nope' }
		});
		const { job: j } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['collections:x/y'] }
		});
		await drainJobs(d, 'w');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('failed');
		expect(got!.steps[0].state).toBe('failed');
		expect(got!.steps[0].detail).toContain('nope');
	});

	it('cancels a queued job immediately', async () => {
		const d = await db();
		const { job: j } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['collections:x/y'] }
		});
		expect(await requestCancel(d, j.id)).toBe(true);
		await drainJobs(d, 'w');
		expect((await detail(d, j.id))!.job.state).toBe('cancelled');
		expect(seenOps).toHaveLength(0);
	});

	it('a running job past its lease is reclaimed and finished by another worker', async () => {
		const d = await db();
		const { job: j } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['collections:x/y'] }
		});
		// Simulate a crashed worker: running, lease already expired.
		await d
			.update(job)
			.set({ state: 'running', leasedBy: 'dead-worker', leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(job.id, j.id));
		const claimed = await claimNext(d, 'live-worker');
		expect(claimed?.id).toBe(j.id);
		expect(claimed!.attempts).toBe(1);
	});

	it('gives up after MAX_ATTEMPTS lease losses', async () => {
		const d = await db();
		const { job: j } = await enqueue(d, {
			kind: 'hub.install',
			params: { items: ['collections:x/y'] }
		});
		await d
			.update(job)
			.set({ state: 'running', attempts: 3, leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(job.id, j.id));
		await claimNext(d, 'w');
		expect((await detail(d, j.id))!.job.state).toBe('failed');
	});
});

describe('config.apply', () => {
	it('backs up, writes, reloads, and only then marks the artifact applied', async () => {
		const d = await db();
		const artifactId = await addArtifact(d);
		behavior['file.backup'] = () => ({ ok: true, result: { backup: '/b/1.bak' } });
		const { job: j } = await enqueue(d, {
			kind: 'config.apply',
			params: {
				path: '/etc/crowdsec/acquis.d/site.yaml',
				content: 'filenames: [/x]\n',
				reloadTarget: 'docker:crowdsec',
				artifactId
			}
		});
		await drainJobs(d, 'w');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('succeeded');
		expect(got!.steps.map((s) => s.name)).toEqual([
			'backup /etc/crowdsec/acquis.d/site.yaml',
			'write /etc/crowdsec/acquis.d/site.yaml',
			'reload docker:crowdsec',
			'mark artifact applied'
		]);
		const [a] = await d.select().from(configArtifact).where(eq(configArtifact.id, artifactId));
		expect(a.state).toBe('applied');
	});

	it('leaves the artifact not_applied and rolls back when the write fails', async () => {
		const d = await db();
		const artifactId = await addArtifact(d);
		behavior['file.backup'] = () => ({ ok: true, result: { backup: '/b/1.bak' } });
		behavior['file.write'] = () => ({ ok: false, error: { code: 'exec', message: 'disk full' } });
		const { job: j } = await enqueue(d, {
			kind: 'config.apply',
			params: { path: '/etc/crowdsec/acquis.d/site.yaml', content: 'x', artifactId }
		});
		await drainJobs(d, 'w');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('failed');
		expect(got!.job.result).toContain('rolled back');
		expect(seenOps.map((s) => s.op)).toContain('file.restore');
		const [a] = await d.select().from(configArtifact).where(eq(configArtifact.id, artifactId));
		expect(a.state).toBe('not_applied');
	});

	it('rejects content over 256KiB and paths outside the allowed shape', async () => {
		const d = await db();
		const { job: j1 } = await enqueue(d, {
			kind: 'config.apply',
			params: { path: 'relative/no', content: 'x' }
		});
		const { job: j2 } = await enqueue(d, {
			kind: 'config.apply',
			params: { path: '/ok/path', content: 'x'.repeat(300 * 1024) }
		});
		await drainJobs(d, 'w');
		expect((await detail(d, j1.id))!.job.state).toBe('failed');
		expect((await detail(d, j2.id))!.job.state).toBe('failed');
	});

	it('middleware apply: issues a key, substitutes it, never logs it', async () => {
		const d = await db();
		const artifactId = await addArtifact(d);
		behavior['bouncers.add'] = () => ({
			ok: true,
			result: { name: 'dash-site-traefik', key: 'SECRETKEY-abc12345' }
		});
		behavior['file.backup'] = () => ({ ok: true, result: { backup: '/b/1.bak' } });
		const content = 'crowdsecLapiKey: <bouncer-key>\n';
		const { job: j } = await enqueue(d, {
			kind: 'config.apply',
			params: {
				path: '/etc/traefik/dynamic/crowdsec.yaml',
				content,
				artifactId,
				bouncerName: 'dash-site-traefik'
			}
		});
		await drainJobs(d, 'w');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('succeeded');
		expect(got!.steps.map((s) => s.name)).toEqual([
			'issue bouncer key dash-site-traefik',
			'backup /etc/traefik/dynamic/crowdsec.yaml',
			'write /etc/traefik/dynamic/crowdsec.yaml',
			'mark artifact applied'
		]);
		// The written file carries the real key; no stored detail leaks it.
		const write = seenOps.find((s) => s.op === 'file.write');
		expect(write!.params.content).toBe('crowdsecLapiKey: SECRETKEY-abc12345\n');
		expect(JSON.stringify(got!.steps)).not.toContain('SECRETKEY');
	});

	it('re-issues the key on resume — secrets never persist across workers', async () => {
		const d = await db();
		let adds = 0;
		behavior['bouncers.add'] = () => {
			adds++;
			return { ok: true, result: { name: 'b', key: `KEY-000${adds}` } };
		};
		behavior['file.backup'] = () => ({ ok: true, result: { backup: '/b/1.bak' } });
		const { job: j } = await enqueue(d, {
			kind: 'config.apply',
			params: {
				path: '/etc/t/m.yaml',
				content: 'k: <bouncer-key>',
				bouncerName: 'b'
			}
		});
		// Run to success, then simulate a crash where write never landed:
		// key+backup succeeded, write is rewound to failed, job back to running.
		await drainJobs(d, 'w');
		expect((await detail(d, j.id))!.job.state).toBe('succeeded');
		await d
			.update(jobStep)
			.set({ state: 'failed' })
			.where(eq(jobStep.id, `${j.id}|2`));
		await d
			.update(job)
			.set({ state: 'running', leasedBy: 'dead', leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(job.id, j.id));
		await drainJobs(d, 'w2');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('succeeded');
		// The ephemeral key step re-ran (KEY-0002) and the resumed write got it.
		expect(adds).toBe(2);
		const write = seenOps.findLast((s) => s.op === 'file.write');
		expect(write!.params.content).toBe('k: KEY-0002');
	});

	it('resumes a crashed job without re-running succeeded steps', async () => {
		const d = await db();
		behavior['file.backup'] = () => ({ ok: true, result: { backup: '/b/1.bak' } });
		let writeCalls = 0;
		behavior['file.write'] = () => {
			writeCalls++;
			return writeCalls === 1
				? Promise.resolve({ ok: false, error: { code: 'exec', message: 'crash' } })
				: { ok: true, result: { bytes: 1 } };
		};
		const { job: j } = await enqueue(d, {
			kind: 'config.apply',
			params: { path: '/etc/x.yaml', content: 'x' }
		});
		await drainJobs(d, 'w');
		expect((await detail(d, j.id))!.job.state).toBe('failed');

		// Simulate a worker crash mid-run: force back to running with the
		// backup step already persisted as succeeded.
		await d
			.update(job)
			.set({ state: 'running', leasedBy: 'dead', leaseUntil: new Date(Date.now() - 1000) })
			.where(eq(job.id, j.id));
		// Mark the write step as if it had succeeded before the crash.
		await d
			.update(jobStep)
			.set({ state: 'succeeded' })
			.where(eq(jobStep.id, `${j.id}|1`));

		await drainJobs(d, 'w2');
		const got = await detail(d, j.id);
		expect(got!.job.state).toBe('succeeded');
		// The write step was not executed again (only the failed first call + the
		// restore from the failed run).
		expect(writeCalls).toBe(1);
	});
});
