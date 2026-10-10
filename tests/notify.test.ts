import { beforeEach, describe, expect, it, vi } from 'vitest';

// Webhook delivery re-resolves destinations at send time — give every test
// hostname a public answer so the guard lets the stubbed fetch through.
vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}));
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import * as schema from '#lib/server/db/schema.ts';
import { notification, notificationOutbox } from '#lib/server/db/app.schema.ts';
import { listNotifications, markRead, recordEvent } from '#lib/server/notify/core.ts';
import {
	MAX_ATTEMPTS,
	assertSafeHttpUrl,
	dispatchOutbox,
	retryOutboxRow,
	UnsafeDestinationError
} from '#lib/server/notify/deliver.ts';
import { saveChannel, validateChannel } from '#lib/server/notify/channels.ts';

function makeDb() {
	return drizzle(createClient({ url: ':memory:' }), { schema });
}
type TestDb = ReturnType<typeof makeDb>;

async function webhookChannel(db: TestDb, minSeverity: 'info' | 'warning' | 'critical' = 'info') {
	return saveChannel(db, {
		name: 'test hook',
		type: 'webhook',
		config: { url: 'https://hooks.example.com/x' },
		secrets: { token: 's3cr3t-token' },
		enabled: true,
		minSeverity
	});
}

describe('recordEvent', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('dedupes on eventKey — bumps count, marks unread, no extra outbox rows', async () => {
		const channelId = await webhookChannel(db);
		const base = {
			eventKey: 'lapi.down',
			class: 'outage' as const,
			severity: 'critical' as const,
			title: 'LAPI down'
		};
		const id1 = await recordEvent(db, base);
		const id2 = await recordEvent(db, base);
		expect(id1).toBe(id2);

		const rows = await db.select().from(notification);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(2);
		expect(rows[0].readAt).toBeNull();

		// outbox fan-out happens once — repeats don't re-email
		const outbox = await db.select().from(notificationOutbox);
		expect(outbox).toHaveLength(1);
		expect(outbox[0].channelId).toBe(channelId);
	});

	it('respects per-channel severity filters', async () => {
		await webhookChannel(db, 'critical');
		await recordEvent(db, {
			eventKey: 'low.pri',
			class: 'admin',
			severity: 'info',
			title: 'minor'
		});
		expect(await db.select().from(notificationOutbox)).toHaveLength(0);

		await recordEvent(db, {
			eventKey: 'high.pri',
			class: 'admin',
			severity: 'critical',
			title: 'major'
		});
		expect(await db.select().from(notificationOutbox)).toHaveLength(1);
	});

	it('markRead flips readAt', async () => {
		const id = await recordEvent(db, {
			eventKey: 'x',
			class: 'admin',
			severity: 'info',
			title: 't'
		});
		await markRead(db, id);
		const list = await listNotifications(db, { unreadOnly: true });
		expect(list.rows).toHaveLength(0);
	});
});

describe('dispatchOutbox', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('delivers pending rows and records deliveredAt', async () => {
		await webhookChannel(db);
		await recordEvent(db, { eventKey: 'e1', class: 'admin', severity: 'info', title: 'hello' });
		const send = vi.fn(async () => {});
		const res = await dispatchOutbox(db, { sendImpl: send });
		expect(res.sent).toBe(1);
		expect(send).toHaveBeenCalledOnce();
		const row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('delivered');
		expect(row.deliveredAt).not.toBeNull();
	});

	it('retries with backoff and fails after MAX_ATTEMPTS', async () => {
		await webhookChannel(db);
		await recordEvent(db, { eventKey: 'e2', class: 'admin', severity: 'info', title: 'x' });
		const send = vi.fn(async () => {
			throw new Error('nope');
		});

		// First attempt → pending with a future retry
		await dispatchOutbox(db, { sendImpl: send });
		let row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('pending');
		expect(row.attempts).toBe(1);
		expect(row.nextRetryAt).not.toBeNull();
		expect(row.lastError).toBe('nope');

		// Drive remaining attempts — `now` must outpace each scheduled nextRetryAt
		for (let i = 1; i < MAX_ATTEMPTS; i++) {
			await dispatchOutbox(db, {
				sendImpl: send,
				now: new Date(Date.now() + (i + 1) * 86400_000)
			});
		}
		row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('failed');
		expect(row.attempts).toBe(MAX_ATTEMPTS);

		// Manual retry re-queues
		await retryOutboxRow(db, row.id);
		row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('pending');
		expect(row.attempts).toBe(0);
	});

	it('redacts secrets from recorded errors', async () => {
		await webhookChannel(db);
		await recordEvent(db, { eventKey: 'e3', class: 'admin', severity: 'info', title: 'x' });
		const send = vi.fn(async () => {
			throw new Error('upstream said token s3cr3t-token was bad');
		});
		await dispatchOutbox(db, { sendImpl: send });
		const row = (await db.select().from(notificationOutbox))[0];
		expect(row.lastError).not.toContain('s3cr3t-token');
		expect(row.lastError).toContain('•••');
	});
});

describe('assertSafeHttpUrl', () => {
	it('allows public https and LAN destinations', () => {
		expect(assertSafeHttpUrl('https://hooks.example.com/x').hostname).toBe('hooks.example.com');
		// LAN receivers (ntfy/Gotify on the home network) are legitimate.
		expect(assertSafeHttpUrl('http://192.168.1.10:8091/hook').hostname).toBe('192.168.1.10');
		expect(assertSafeHttpUrl('http://10.0.0.5/')).toBeTruthy();
	});
	it('blocks loopback, link-local, metadata, and non-http schemes', () => {
		for (const bad of [
			'http://127.0.0.1/hook',
			'http://169.254.169.254/latest/meta-data',
			'https://metadata.google.internal/',
			'http://localhost/x',
			'http://[::1]/x',
			'http://[fe80::1]/x',
			'ftp://example.com/x'
		]) {
			expect(() => assertSafeHttpUrl(bad), bad).toThrow(UnsafeDestinationError);
		}
	});
});

describe('validateChannel', () => {
	it('requires fields per type', () => {
		expect(
			validateChannel({
				name: 'g',
				type: 'gotify',
				config: { url: 'https://gotify.example.com' },
				secrets: {},
				enabled: true,
				minSeverity: 'info'
			})
		).toMatch(/token/i);
	});
	it('rejects SSRF destinations at save time', () => {
		expect(
			validateChannel({
				name: 'w',
				type: 'webhook',
				config: { url: 'http://169.254.169.254/x' },
				secrets: {},
				enabled: true,
				minSeverity: 'info'
			})
		).toBeTruthy();
	});
});

describe('channel rules', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('class filter: only listed classes fan out', async () => {
		await saveChannel(db, {
			name: 'security only',
			type: 'webhook',
			config: { url: 'https://hooks.example.com/x' },
			secrets: {},
			enabled: true,
			minSeverity: 'info',
			classes: ['security']
		});
		await recordEvent(db, { eventKey: 'a1', class: 'admin', severity: 'info', title: 'admin' });
		await recordEvent(db, { eventKey: 's1', class: 'security', severity: 'info', title: 'sec' });
		const rows = await db.select().from(notificationOutbox);
		const notifIds = rows.map((r) => r.notificationId);
		const notifs = await db.select().from(notification);
		const delivered = notifs.filter((n) => notifIds.includes(n.id));
		expect(delivered).toHaveLength(1);
		expect(delivered[0].class).toBe('security');
	});

	it('site filter: non-matching site events do not fan out, system events always do', async () => {
		await saveChannel(db, {
			name: 'one site',
			type: 'webhook',
			config: { url: 'https://hooks.example.com/x' },
			secrets: {},
			enabled: true,
			minSeverity: 'info',
			siteIds: ['site-a']
		});
		await recordEvent(db, {
			eventKey: 'sa',
			class: 'job',
			severity: 'warning',
			title: 'site A',
			site: 'site-a'
		});
		await recordEvent(db, {
			eventKey: 'sb',
			class: 'job',
			severity: 'warning',
			title: 'site B',
			site: 'site-b'
		});
		await recordEvent(db, {
			eventKey: 'sys',
			class: 'outage',
			severity: 'warning',
			title: 'system'
		});
		const rows = await db.select().from(notificationOutbox);
		expect(rows).toHaveLength(2); // site-a + system event
	});

	it('quiet hours defer non-critical rows to the window end', async () => {
		await saveChannel(db, {
			name: 'quiet',
			type: 'webhook',
			config: { url: 'https://hooks.example.com/x' },
			secrets: {},
			enabled: true,
			minSeverity: 'info',
			quietStart: '22:00',
			quietEnd: '06:00'
		});
		await recordEvent(db, { eventKey: 'q1', class: 'job', severity: 'warning', title: 'night' });
		await recordEvent(db, {
			eventKey: 'q2',
			class: 'outage',
			severity: 'critical',
			title: 'urgent'
		});
		const send = vi.fn(async () => {});
		const now = new Date('2026-10-09T23:30:00Z'); // inside quiet window
		await dispatchOutbox(db, { sendImpl: send, now });
		// critical sent, warning deferred
		expect(send).toHaveBeenCalledOnce();
		const rows = await db.select().from(notificationOutbox);
		const deferred = rows.find((r) => r.nextRetryAt !== null && r.state === 'pending');
		const delivered = rows.find((r) => r.state === 'delivered');
		expect(deferred?.nextRetryAt?.getUTCHours()).toBe(6);
		expect(deferred?.nextRetryAt?.getUTCMinutes()).toBe(0);
		expect(delivered).toBeTruthy();
	});

	it('digest batches pending rows into one payload after the interval', async () => {
		await saveChannel(db, {
			name: 'digest',
			type: 'webhook',
			config: { url: 'https://hooks.example.com/x' },
			secrets: {},
			enabled: true,
			minSeverity: 'info',
			digestMinutes: 15
		});
		await recordEvent(db, { eventKey: 'd1', class: 'job', severity: 'warning', title: 'one' });
		await recordEvent(db, { eventKey: 'd2', class: 'admin', severity: 'info', title: 'two' });
		const send = vi.fn(async () => {});
		// immediately — nothing flushed (oldest row is fresh)
		const r1 = await dispatchOutbox(db, { sendImpl: send });
		expect(r1.sent).toBe(0);
		expect(send).not.toHaveBeenCalled();
		// 16 minutes later — one digest send, both rows delivered
		const r2 = await dispatchOutbox(db, {
			sendImpl: send,
			now: new Date(Date.now() + 16 * 60_000)
		});
		expect(r2.sent).toBe(2);
		expect(send).toHaveBeenCalledOnce();
		const payload = send.mock.calls[0][1] as { title: string; body: string };
		expect(payload.title).toMatch(/2 notifications/);
		expect(payload.body).toContain('one');
		expect(payload.body).toContain('two');
	});

	it('digest failure retries the batch, not individual rows', async () => {
		await saveChannel(db, {
			name: 'digest',
			type: 'webhook',
			config: { url: 'https://hooks.example.com/x' },
			secrets: {},
			enabled: true,
			minSeverity: 'info',
			digestMinutes: 5
		});
		await recordEvent(db, { eventKey: 'df1', class: 'job', severity: 'info', title: 'a' });
		const send = vi.fn(async () => {
			throw new Error('digest nope');
		});
		await dispatchOutbox(db, { sendImpl: send, now: new Date(Date.now() + 6 * 60_000) });
		const row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('pending');
		expect(row.attempts).toBe(1);
		expect(row.lastError).toBe('digest nope');
	});
});

describe('previewDelivery', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('renders the webhook payload with secrets redacted', async () => {
		const { previewDelivery } = await import('#lib/server/notify/deliver.ts');
		const id = await webhookChannel(db); // has token s3cr3t-token
		const channel = await db.query.notificationChannel.findFirst({
			where: (t, { eq }) => eq(t.id, id)
		});
		const p = await previewDelivery(channel!);
		expect(p.destination).toBe('hooks.example.com/x');
		expect(p.headers.authorization).toBe('•••');
		expect(p.body).toContain('Sample event');
		expect(JSON.stringify(p)).not.toContain('s3cr3t-token');
	});
});

describe('at-least-once delivery', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
	});

	it('an ambiguous send (timed out after the destination accepted) may deliver twice', async () => {
		await webhookChannel(db);
		await recordEvent(db, { eventKey: 'dup', class: 'job', severity: 'info', title: 'x' });
		let calls = 0;
		const send = vi.fn(async () => {
			calls++;
			if (calls === 1) throw new Error('timeout — destination may have received it');
		});
		await dispatchOutbox(db, { sendImpl: send });
		let row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('pending'); // ambiguous — must retry
		await dispatchOutbox(db, { sendImpl: send, now: new Date(Date.now() + 120_000) });
		row = (await db.select().from(notificationOutbox))[0];
		expect(row.state).toBe('delivered');
		expect(calls).toBe(2); // at-least-once: duplicates possible, loss never
	});
});
