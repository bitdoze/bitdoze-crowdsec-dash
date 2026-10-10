/**
 * HTTP plumbing for the machine surface: Bearer auth + a small in-memory
 * fixed-window limiter + JSON responses. Single-process app, so an in-memory
 * limiter is honest (it resets on restart and is documented as such).
 */
import type { RequestEvent } from '@sveltejs/kit';
import { authenticateApiKey, type ApiPrincipal, type ApiScope } from '#lib/server/api-keys.ts';
import { ApiError } from './v1.ts';
import { db } from '#lib/server/db/index.ts';

const buckets = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const LIMIT_AUTHED = 120; // per key per minute
const LIMIT_ANON = 30; // per IP per minute — enough to probe, not to brute-force

function rateLimited(bucketKey: string, limit: number): boolean {
	const now = Date.now();
	let b = buckets.get(bucketKey);
	if (!b || b.resetAt <= now) {
		b = { count: 0, resetAt: now + WINDOW_MS };
		buckets.set(bucketKey, b);
		if (buckets.size > 10_000) buckets.clear(); // bound the map
	}
	return ++b.count > limit;
}

export function jsonErr(status: number, message: string, extra: Record<string, unknown> = {}) {
	return Response.json({ error: message, ...extra }, { status });
}

/** Bearer auth + rate limit; returns a Response to send on failure. */
export async function apiAuth(
	event: RequestEvent
): Promise<{ principal: ApiPrincipal } | { response: Response }> {
	const ip = event.getClientAddress();
	const raw = /^Bearer\s+(\S+)$/i.exec(event.request.headers.get('authorization') ?? '')?.[1];

	if (!raw) {
		if (rateLimited(`anon:${ip}`, LIMIT_ANON)) return { response: jsonErr(429, 'Rate limited.') };
		return {
			response: jsonErr(401, 'Missing or malformed Authorization: Bearer <key>.', {
				hint: 'Create a key under Settings → API keys.'
			})
		};
	}
	const principal = await authenticateApiKey(db, raw);
	if (!principal) {
		rateLimited(`anon:${ip}`, LIMIT_ANON);
		return { response: jsonErr(401, 'Invalid or revoked API key.') };
	}
	if (rateLimited(`key:${principal.keyId}`, LIMIT_AUTHED))
		return { response: jsonErr(429, 'Rate limited (120/min per key).') };
	return { principal };
}

export function requireScope(p: ApiPrincipal, scope: ApiScope): Response | null {
	if (scope === 'operate' && p.scope !== 'operate')
		return jsonErr(403, 'This key has read scope; this operation needs an operate-scope key.');
	return null;
}

/** Wrap an op call: uniform ApiError → JSON mapping. */
export async function respond(fn: () => Promise<unknown>): Promise<Response> {
	try {
		return Response.json(await fn());
	} catch (e) {
		if (e instanceof ApiError) return jsonErr(e.status, e.message);
		throw e;
	}
}
