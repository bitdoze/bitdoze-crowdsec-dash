import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { rateLimit } from '#lib/server/db/auth.schema.ts';
import { clearLoginFailures, loginRetryAfter, recordLoginFailure } from '#lib/server/throttle.ts';

function makeDb() {
	const client = createClient({ url: ':memory:' });
	return { client, db: drizzle(client) };
}

describe('login throttle', () => {
	beforeEach(async (context) => {
		const { db, client } = makeDb();
		context.db = db;
		await client.execute(
			'CREATE TABLE rate_limit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL)'
		);
	});

	it('allows attempts until the failure cap', async ({ db }) => {
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBe(0);
		for (let i = 0; i < 4; i++) {
			await recordLoginFailure(db, 'a@b.c', '1.2.3.4');
			expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBe(0);
		}
		await recordLoginFailure(db, 'a@b.c', '1.2.3.4');
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBeGreaterThan(0);
	});

	it('scopes the block to the email+ip pair', async ({ db }) => {
		for (let i = 0; i < 6; i++) await recordLoginFailure(db, 'a@b.c', '1.2.3.4');
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBeGreaterThan(0);
		expect(await loginRetryAfter(db, 'other@b.c', '1.2.3.4')).toBe(0);
		expect(await loginRetryAfter(db, 'a@b.c', '9.9.9.9')).toBe(0);
	});

	it('normalizes the email before keying', async ({ db }) => {
		for (let i = 0; i < 6; i++) await recordLoginFailure(db, 'A@b.C ', '1.2.3.4');
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBeGreaterThan(0);
	});

	it('clears after a successful sign-in', async ({ db }) => {
		for (let i = 0; i < 6; i++) await recordLoginFailure(db, 'a@b.c', '1.2.3.4');
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBeGreaterThan(0);
		await clearLoginFailures(db, 'a@b.c', '1.2.3.4');
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBe(0);
		// Better Auth's own rows survive: only `login:` keys are touched.
	});

	it('expires after the window elapses', async ({ db }) => {
		vi.useFakeTimers();
		try {
			for (let i = 0; i < 6; i++) await recordLoginFailure(db, 'a@b.c', '1.2.3.4');
			expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBeGreaterThan(0);
			vi.advanceTimersByTime(10 * 60 * 1000 + 1);
			expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('namespaces keys so Better Auth rate-limit rows cannot collide', async ({ db }) => {
		await db.insert(rateLimit).values({
			id: 'x',
			key: '/sign-in/email:1.2.3.4',
			count: 999,
			lastRequest: Date.now()
		});
		expect(await loginRetryAfter(db, 'a@b.c', '1.2.3.4')).toBe(0);
	});
});
