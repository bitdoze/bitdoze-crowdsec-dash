/**
 * Per-user API keys for the machine surface (`/api/v1/*`, `/mcp`).
 *
 * Raw keys are `csd_<base64url>`; only their sha256 is stored — a leaked DB
 * cannot mint requests. A key's effective scope is additionally capped by the
 * owner's current role at auth time, so demoting an operator to viewer turns
 * their `operate` keys into read-only without touching the key rows.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { db } from './db/index.ts';
import { apiKey } from './db/app.schema.ts';
import { user } from './db/auth.schema.ts';
import { hasPermission } from '#lib/roles.ts';

type Db = typeof db;

export type ApiScope = 'read' | 'operate';

export interface ApiPrincipal {
	keyId: string;
	userId: string;
	userName: string;
	role: string | null;
	/** 'read' or 'operate' — after the owner-role cap. */
	scope: ApiScope;
}

const MAX_KEYS_PER_USER = 25;
const LAST_USED_TOUCH_MS = 60_000;

export function keyDigest(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

/** Mint a key. The raw value is returned here only — never persisted. */
export async function createApiKey(
	database: Db,
	opts: { userId: string; name: string; scope: ApiScope }
): Promise<{ id: string; raw: string }> {
	const name = opts.name.trim();
	if (name.length < 1 || name.length > 64) throw new Error('Name must be 1–64 characters.');
	if (opts.scope !== 'read' && opts.scope !== 'operate')
		throw new Error('Scope must be read or operate.');

	const existing = await database
		.select({ n: apiKey.id })
		.from(apiKey)
		.where(and(eq(apiKey.userId, opts.userId), isNull(apiKey.revokedAt)));
	if (existing.length >= MAX_KEYS_PER_USER)
		throw new Error(`At most ${MAX_KEYS_PER_USER} active keys per user.`);

	const raw = `csd_${randomBytes(30).toString('base64url')}`;
	const row = {
		id: randomUUID(),
		userId: opts.userId,
		name,
		prefix: raw.slice(0, 12),
		keyHash: keyDigest(raw),
		scope: opts.scope
	};
	await database.insert(apiKey).values(row);
	return { id: row.id, raw };
}

export async function listApiKeys(database: Db, userId: string) {
	return database
		.select({
			id: apiKey.id,
			name: apiKey.name,
			prefix: apiKey.prefix,
			scope: apiKey.scope,
			createdAt: apiKey.createdAt,
			lastUsedAt: apiKey.lastUsedAt,
			revokedAt: apiKey.revokedAt
		})
		.from(apiKey)
		.where(eq(apiKey.userId, userId))
		.orderBy(desc(apiKey.createdAt));
}

export async function revokeApiKey(
	database: Db,
	id: string,
	owner: { id: string; isAdmin: boolean }
): Promise<'revoked' | 'missing' | 'forbidden'> {
	const row = await database
		.select({ userId: apiKey.userId, revokedAt: apiKey.revokedAt })
		.from(apiKey)
		.where(eq(apiKey.id, id))
		.get();
	if (!row) return 'missing';
	if (row.userId !== owner.id && !owner.isAdmin) return 'forbidden';
	if (row.revokedAt) return 'revoked';
	await database.update(apiKey).set({ revokedAt: new Date() }).where(eq(apiKey.id, id));
	return 'revoked';
}

/**
 * Resolve a Bearer token to a principal, or null. Also enforces the account
 * boundary: banned/expired-ban users and revoked keys resolve to nothing.
 */
export async function authenticateApiKey(
	database: Db,
	raw: string | undefined
): Promise<ApiPrincipal | null> {
	if (!raw || !raw.startsWith('csd_')) return null;
	const row = await database
		.select({
			id: apiKey.id,
			userId: apiKey.userId,
			scope: apiKey.scope,
			lastUsedAt: apiKey.lastUsedAt,
			userName: user.name,
			role: user.role,
			banned: user.banned,
			banExpires: user.banExpires
		})
		.from(apiKey)
		.innerJoin(user, eq(apiKey.userId, user.id))
		.where(and(eq(apiKey.keyHash, keyDigest(raw)), isNull(apiKey.revokedAt)))
		.get();
	if (!row) return null;
	if (row.banned && (!row.banExpires || row.banExpires.getTime() > Date.now())) return null;

	const scope: ApiScope =
		row.scope === 'operate' && hasPermission(row.role, 'operate') ? 'operate' : 'read';

	// Cheap usage stamp — throttled so reads don't amplify into writes.
	if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_TOUCH_MS) {
		void (async () => {
			try {
				await database.update(apiKey).set({ lastUsedAt: new Date() }).where(eq(apiKey.id, row.id));
			} catch {
				// best-effort stamp
			}
		})();
	}
	return { keyId: row.id, userId: row.userId, userName: row.userName, role: row.role, scope };
}
