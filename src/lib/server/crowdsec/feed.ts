/**
 * Live enforced-decisions feed — GET /v1/decisions via the observer bouncer
 * key. Unlike the local projection (which mirrors decisions on synced
 * alerts), the feed returns EVERY decision CrowdSec enforces right now,
 * including the centralized CAPI/community blocklist — the honest "what is
 * banned" view.
 *
 * Real 1.7.x semantics (verified): honors ip/contains/range/scope/value/
 * type/scenario/limit/offset; `origin` is silently ignored so it can't be
 * filtered — origins are shown, not searched. An empty result is bare null.
 * There is no count upstream, so paging is offset-based with a perPage+1
 * lookahead and the approximate total comes from the scraped
 * cs_active_decisions metric.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { metricSample } from '#lib/server/db/app.schema.ts';
import { buildClient, getBouncerKey } from './connection.ts';
import { normalizeTarget } from '#lib/ipaddr.ts';
import type { DecisionFeedQuery, LapiDecision } from './types.ts';

export const FEED_PER_PAGE = 25;

/** Origins removable through DELETE /v1/decisions/:id — the rest are
 * centrally managed (CAPI/subscription lists) and need an allowlist. */
export const REMOVABLE_ORIGINS = new Set(['crowdsec', 'cscli', 'console', 'cscli-import']);

export interface FeedRow extends LapiDecision {
	/** DELETE /v1/decisions/:id works for local origins only. */
	removable: boolean;
}

export interface EnforcedFeed {
	state: 'ok' | 'no_key' | 'no_client' | 'error';
	rows: FeedRow[];
	page: number;
	hasNext: boolean;
	approxTotal: number | null;
	error?: string;
}

/**
 * Map free-text search onto the feed's real filters:
 * - "1.2.3.4"      → ip + contains (covers exact and enclosing ranges)
 * - "10.0.0.0/8"   → range
 * - "ssh:bruteforce" / "crowdsecurity/http-probing" → scenario
 * - anything else  → exact value (Country "FR", AS "AS1234", …)
 */
export function feedQueryFor(raw: string): Partial<DecisionFeedQuery> {
	const t = raw.trim();
	if (!t) return {};
	const target = normalizeTarget(t);
	if (target?.scope === 'range') return { range: target.value };
	if (target?.scope === 'ip') return { ip: target.value, contains: true };
	if (t.includes('/') || t.includes(':')) return { scenario: t };
	return { value: t };
}

/** Approximate enforced total — latest cs_active_decisions per label set. */
async function approxEnforcedTotal(database: typeof db): Promise<number | null> {
	const rows = await database
		.select({ value: metricSample.value, labels: metricSample.labels, at: metricSample.at })
		.from(metricSample)
		.where(eq(metricSample.name, 'cs_active_decisions'))
		.orderBy(desc(metricSample.at))
		.limit(300);
	if (!rows.length) return null;
	const latest = new Map<string, { at: Date; value: number }>();
	for (const r of rows) {
		const key = r.labels ?? '';
		const cur = latest.get(key);
		if (!cur || r.at > cur.at) latest.set(key, { at: r.at, value: r.value });
	}
	let sum = 0;
	for (const r of latest.values()) sum += r.value;
	return sum;
}

const empty = (state: EnforcedFeed['state'], error?: string): EnforcedFeed => ({
	state,
	rows: [],
	page: 1,
	hasNext: false,
	approxTotal: null,
	...(error ? { error } : {})
});

export async function loadEnforcedFeed(
	input: { q?: string; scope?: string; type?: string; page?: number },
	database: typeof db = db
): Promise<EnforcedFeed> {
	const key = await getBouncerKey(database);
	const approx = await approxEnforcedTotal(database).catch(() => null);
	if (!key) return { ...empty('no_key'), approxTotal: approx };
	const client = await buildClient(database);
	if (!client) return { ...empty('no_client'), approxTotal: approx };
	const page = Math.max(1, Math.trunc(input.page ?? 1));
	try {
		const rows = await client.decisions(
			{
				...feedQueryFor(input.q ?? ''),
				scope: input.scope || undefined,
				type: input.type || undefined,
				offset: (page - 1) * FEED_PER_PAGE,
				limit: FEED_PER_PAGE + 1 // lookahead — the feed has no count
			},
			key
		);
		return {
			state: 'ok',
			rows: rows.slice(0, FEED_PER_PAGE).map((d) => ({
				...d,
				removable: REMOVABLE_ORIGINS.has(d.origin ?? '')
			})),
			page,
			hasNext: rows.length > FEED_PER_PAGE,
			approxTotal: approx
		};
	} catch (e) {
		return {
			...empty('error', e instanceof Error ? e.message : 'feed query failed'),
			approxTotal: approx
		};
	}
}
