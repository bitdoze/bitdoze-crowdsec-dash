/**
 * Login throttling.
 *
 * Why this exists: Better Auth's rate limiter runs in the HTTP router's
 * `onRequest` (see `onRequestRateLimit` in its api module). Calling
 * `auth.api.signInEmail` from a form action bypasses that hook entirely, so
 * the login form would have no brute-force protection. This limiter is
 * applied explicitly in the login action.
 *
 * Storage: the `rate_limit` table Better Auth already creates, with keys
 * namespaced `login:<email>:<ip>` so they can never collide with its own
 * `<path>:<ip>` keys.
 */
import { and, eq, gt } from 'drizzle-orm';
import { rateLimit } from '#lib/server/db/auth.schema.ts';
import type { db } from '#lib/server/db/index.ts';

type Db = typeof db;

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const TFA_MAX_FAILURES = 10;
const KEY_PREFIX = 'login:';
const TFA_PREFIX = 'login:2fa:';

function key(email: string, ip: string): string {
	return `${KEY_PREFIX}${email.trim().toLowerCase()}:${ip}`;
}

const tfaKey = (ip: string) => `${TFA_PREFIX}${ip}`;

async function retryAfter(database: Db, k: string, max: number): Promise<number> {
	const row = await database
		.select({ count: rateLimit.count, lastRequest: rateLimit.lastRequest })
		.from(rateLimit)
		.where(eq(rateLimit.key, k))
		.get();
	if (!row) return 0;
	const elapsed = Date.now() - row.lastRequest;
	if (elapsed >= WINDOW_MS) return 0;
	if (row.count < max) return 0;
	return WINDOW_MS - elapsed;
}

async function recordFailure(database: Db, k: string): Promise<void> {
	const now = Date.now();
	const row = await database
		.select({ count: rateLimit.count, lastRequest: rateLimit.lastRequest })
		.from(rateLimit)
		.where(eq(rateLimit.key, k))
		.get();
	if (!row || now - row.lastRequest >= WINDOW_MS) {
		await database
			.insert(rateLimit)
			.values({ id: crypto.randomUUID(), key: k, count: 1, lastRequest: now })
			.onConflictDoUpdate({ target: rateLimit.key, set: { count: 1, lastRequest: now } });
		return;
	}
	await database
		.update(rateLimit)
		.set({ count: row.count + 1, lastRequest: now })
		.where(eq(rateLimit.key, k));
}

/**
 * Milliseconds until a blocked email+IP pair may try again, or 0 when the
 * attempt is allowed. Reads the stored window without consuming it.
 */
export async function loginRetryAfter(database: Db, email: string, ip: string): Promise<number> {
	return retryAfter(database, key(email, ip), MAX_FAILURES);
}

/** Record one failed sign-in. The failure count resets after WINDOW_MS of quiet. */
export async function recordLoginFailure(database: Db, email: string, ip: string): Promise<void> {
	await recordFailure(database, key(email, ip));
}

/** Successful sign-in clears the failure window for that email+IP. */
export async function clearLoginFailures(database: Db, email: string, ip: string): Promise<void> {
	await database
		.delete(rateLimit)
		.where(and(eq(rateLimit.key, key(email, ip)), gt(rateLimit.count, 0)));
}

/**
 * Second-factor throttling, keyed by IP only. A password holder can mint
 * unlimited two-factor challenges, so the challenge itself can't be the
 * throttle key — the IP's window is shared across TOTP and backup codes
 * and is also consulted at the signIn step.
 */
export async function twoFactorRetryAfter(database: Db, ip: string): Promise<number> {
	return retryAfter(database, tfaKey(ip), TFA_MAX_FAILURES);
}

export async function recordTwoFactorFailure(database: Db, ip: string): Promise<void> {
	await recordFailure(database, tfaKey(ip));
}

export async function clearTwoFactorFailures(database: Db, ip: string): Promise<void> {
	await database
		.delete(rateLimit)
		.where(and(eq(rateLimit.key, tfaKey(ip)), gt(rateLimit.count, 0)));
}
