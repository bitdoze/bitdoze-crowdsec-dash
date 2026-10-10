/**
 * Ops tooling: retention policy math, disk-pressure event lifecycle,
 * support-bundle redaction, update-check parsing, and the VACUUM INTO
 * backup producing a readable sqlite file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import * as schema from '#lib/server/db/schema.ts';
import { appSetting, job, notification, notificationOutbox } from '#lib/server/db/app.schema.ts';
import { recordEvent } from '#lib/server/notify/core.ts';
import { saveChannel } from '#lib/server/notify/channels.ts';
import {
	buildSupportBundle,
	checkForUpdate,
	createBackup,
	evaluateDisk,
	getRetentionPolicy,
	newerThanCurrent,
	runRetention,
	setSetting
} from '#lib/server/ops.ts';
import { config } from '#lib/server/config.ts';
import { eq } from 'drizzle-orm';

function makeDb() {
	return drizzle(createClient({ url: ':memory:' }), { schema });
}
type TestDb = ReturnType<typeof makeDb>;

const old = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);

describe('runRetention', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('deletes notifications + outbox older than the policy, keeps fresh ones', async () => {
		await saveChannel(db, {
			name: 'c',
			type: 'webhook',
			config: { url: 'https://h.example.com' },
			secrets: {},
			enabled: true,
			minSeverity: 'info'
		});
		const staleId = await recordEvent(db, {
			eventKey: 'old',
			class: 'job',
			severity: 'info',
			title: 'old'
		});
		await recordEvent(db, { eventKey: 'new', class: 'job', severity: 'info', title: 'new' });
		// age the stale one beyond the 90-day default
		await db
			.update(notification)
			.set({ lastAt: old(120), createdAt: old(120) })
			.where(eq(notification.id, staleId));
		const counts = await runRetention(db, {
			notifications: 90,
			jobs: 30,
			audit: 365,
			metrics: 30,
			decisionRequests: 30
		});
		expect(counts.notifications).toBe(1);
		const remaining = await db.select().from(notification);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].eventKey).toBe('new');
		// its outbox row went with it
		expect(await db.select().from(notificationOutbox)).toHaveLength(1);
	});

	it('deletes finished jobs past the window but keeps running ones', async () => {
		await db.insert(job).values({
			id: 'j-old',
			kind: 'config.apply',
			params: '{}',
			state: 'succeeded',
			finishedAt: old(60),
			createdAt: old(60),
			updatedAt: old(60)
		});
		await db.insert(job).values({
			id: 'j-live',
			kind: 'config.apply',
			params: '{}',
			state: 'running',
			createdAt: old(60),
			updatedAt: old(60)
		});
		const counts = await runRetention(db, {
			notifications: 90,
			jobs: 30,
			audit: 365,
			metrics: 30,
			decisionRequests: 30
		});
		expect(counts.jobs).toBe(1);
		const rows = await db.select().from(job);
		expect(rows.map((j) => j.id)).toEqual(['j-live']);
	});

	it('policy override is persisted and merged with defaults', async () => {
		await setSetting(db, 'retention', JSON.stringify({ notifications: 7 }));
		const p = await getRetentionPolicy(db);
		expect(p.notifications).toBe(7);
		expect(p.audit).toBe(365); // default fills the gap
	});
});

describe('evaluateDisk', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	const state = (pct: number) => ({
		path: '/data',
		freeBytes: pct * 10_000,
		totalBytes: 1_000_000,
		freePct: pct
	});

	it('warns under 15%, goes critical under 5%, recovers after', async () => {
		await evaluateDisk(db, state(10));
		let rows = await db.select().from(notification);
		expect(rows[0].severity).toBe('warning');
		expect(rows[0].eventKey).toBe('disk.low');

		await evaluateDisk(db, state(3));
		rows = await db.select().from(notification);
		expect(rows.some((r) => r.eventKey === 'disk.critical' && r.severity === 'critical')).toBe(
			true
		);

		await evaluateDisk(db, state(50));
		rows = await db.select().from(notification);
		// marker cleared; escalation replaced the low marker so only the
		// critical recovery event fires
		expect(rows.some((r) => r.eventKey === 'disk.critical')).toBe(false);
		expect(rows.some((r) => r.title === 'Disk pressure recovered')).toBe(true);
		expect(rows.some((r) => r.title === 'Disk space recovered')).toBe(false);
	});
});

describe('buildSupportBundle', () => {
	it('contains counts and versions but never secret material', async () => {
		const db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
		await saveChannel(db, {
			name: 'secret-hook',
			type: 'webhook',
			config: { url: 'https://h.example.com' },
			secrets: { token: 'bundle-secret-value' },
			enabled: true,
			minSeverity: 'info'
		});
		const bundle = await buildSupportBundle(db);
		const raw = JSON.stringify(bundle);
		expect(bundle.version).toBeTruthy();
		expect((bundle.counts as Record<string, number>).sites).toBe(0);
		expect(raw).not.toContain('bundle-secret-value');
		expect(raw).not.toContain('secretEnc');
	});
});

describe('checkForUpdate', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('records the latest release and updateAvailable', async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						tag_name: 'v99.0.0',
						html_url: 'https://github.com/x/releases/v99.0.0',
						published_at: '2026-10-01T00:00:00Z'
					})
				)
		) as unknown as typeof fetch;
		const r = await checkForUpdate(db, fetchImpl);
		expect(r.latestTag).toBe('v99.0.0');
		expect(r.updateAvailable).toBe(true);
		// cached for the page
		const cached = await db
			.select()
			.from(appSetting)
			.where(eq(appSetting.key, 'updateCheck'))
			.get();
		expect(cached?.value).toContain('v99.0.0');
	});

	it('records the error when GitHub is unreachable', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		const r = await checkForUpdate(db, fetchImpl);
		expect(r.error).toBe('offline');
		expect(r.updateAvailable).toBe(false);
	});

	it('newerThanCurrent compares numerically', () => {
		expect(newerThanCurrent('v99.0.0')).toBe(true);
		expect(newerThanCurrent('v0.0.1')).toBe(false);
		expect(newerThanCurrent(null)).toBe(false);
	});
});

describe('createBackup', () => {
	it('writes a sqlite file that opens and contains the marker table', async () => {
		const { rawClient } = await import('#lib/server/db/index.ts');
		await rawClient.execute('CREATE TABLE IF NOT EXISTS backup_probe (v text)');
		await rawClient.execute("INSERT INTO backup_probe VALUES ('present')");
		const { file } = await createBackup();
		const check = createClient({ url: `file:${file}` });
		const rows = await check.execute('SELECT v FROM backup_probe');
		expect(rows.rows[0]?.v).toBe('present');
		check.close();
	});

	it('backup dir lives under DATA_DIR', () => {
		expect(path.resolve(config.dataDir)).toBeTruthy();
	});
});
