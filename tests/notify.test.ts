import { beforeEach, describe, expect, it, vi } from 'vitest';
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
