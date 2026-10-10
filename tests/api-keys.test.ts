/**
 * API keys: mint/auth/revoke lifecycle, the owner-role scope cap, and the
 * MCP tool dispatcher's scope enforcement.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '#lib/server/db/schema.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { apiKey } from '#lib/server/db/app.schema.ts';
import {
	authenticateApiKey,
	createApiKey,
	keyDigest,
	listApiKeys,
	revokeApiKey
} from '#lib/server/api-keys.ts';

function makeDb() {
	return drizzle(createClient({ url: ':memory:' }), { schema });
}
type TestDb = ReturnType<typeof makeDb>;

const seedUser = async (db: TestDb, id: string, role: string, banned = false) =>
	db.insert(user).values({
		id,
		name: id,
		email: `${id}@t.t`,
		emailVerified: true,
		role,
		banned
	});

describe('api keys', () => {
	let db: TestDb;
	beforeEach(async () => {
		db = makeDb();
		await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
		await seedUser(db, 'u-admin', 'admin');
		await seedUser(db, 'u-viewer', 'viewer');
	});

	it('mints a csd_ key, stores only its hash, and authenticates it', async () => {
		const { raw } = await createApiKey(db, { userId: 'u-admin', name: 'bot', scope: 'operate' });
		expect(raw.startsWith('csd_')).toBe(true);
		const rows = await db.select().from(apiKey);
		expect(rows[0].keyHash).toBe(keyDigest(raw));
		expect(JSON.stringify(rows)).not.toContain(raw);

		const p = await authenticateApiKey(db, raw);
		expect(p?.userId).toBe('u-admin');
		expect(p?.scope).toBe('operate');
	});

	it('rejects wrong, revoked, and banned-owner keys', async () => {
		const { raw, id } = await createApiKey(db, { userId: 'u-admin', name: 'b', scope: 'read' });
		expect(await authenticateApiKey(db, 'csd_nope')).toBeNull();
		expect(await authenticateApiKey(db, raw + 'x')).toBeNull();

		expect(await revokeApiKey(db, id, { id: 'u-admin', isAdmin: false })).toBe('revoked');
		expect(await authenticateApiKey(db, raw)).toBeNull();

		await db.update(user).set({ banned: true }).where(eq(user.id, 'u-admin'));
		const { raw: raw2 } = await createApiKey(db, { userId: 'u-admin', name: 'b2', scope: 'read' });
		expect(await authenticateApiKey(db, raw2)).toBeNull();
	});

	it('caps operate scope by the owner role — a viewer key never operates', async () => {
		// A viewer cannot mint operate via the UI, but a stale/pre-demotion key
		// could carry it — the cap is what matters.
		const { raw } = await createApiKey(db, { userId: 'u-viewer', name: 'v', scope: 'operate' });
		const p = await authenticateApiKey(db, raw);
		expect(p?.scope).toBe('read');
	});

	it("forbids revoking other users' keys unless admin", async () => {
		const { id } = await createApiKey(db, { userId: 'u-admin', name: 'x', scope: 'read' });
		expect(await revokeApiKey(db, id, { id: 'u-viewer', isAdmin: false })).toBe('forbidden');
		expect(await revokeApiKey(db, id, { id: 'u-other', isAdmin: true })).toBe('revoked');
	});

	it('rejects bad names/scopes and enforces the per-user cap', async () => {
		await expect(
			createApiKey(db, { userId: 'u-admin', name: '', scope: 'read' })
		).rejects.toThrow();
		await expect(
			createApiKey(db, { userId: 'u-admin', name: 'x', scope: 'configure' as 'read' })
		).rejects.toThrow();
		for (let i = 0; i < 25; i++)
			await createApiKey(db, { userId: 'u-admin', name: `k${i}`, scope: 'read' });
		await expect(
			createApiKey(db, { userId: 'u-admin', name: 'over', scope: 'read' })
		).rejects.toThrow('At most');
		const keys = await listApiKeys(db, 'u-admin');
		expect(keys.every((k) => !('keyHash' in k))).toBe(true);
	});
});
