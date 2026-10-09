/**
 * Metrics scraping (tier C — network reachability only, no credentials).
 * Parses the Prometheus endpoint, stores whitelisted low-cardinality
 * counters as samples, and updates sync_state.metrics freshness.
 */
import { eq, lt } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import { metricSample, server, syncState } from '#lib/server/db/app.schema.ts';
import { parsePrometheus, whitelisted, summarizeMetrics } from './metrics.ts';

type Db = typeof db;

const RETENTION_MS = 7 * 86_400_000; // raw samples ~7 days (spec section 8)
const TIMEOUT_MS = 6_000;

export interface ScrapeResult {
	points: number;
	version: string | null;
}

export async function scrapeMetrics(
	database: Db,
	metricsUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<ScrapeResult> {
	const res = await fetchImpl(metricsUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`metrics endpoint returned ${res.status}`);
	const points = parsePrometheus(await res.text()).filter(whitelisted);
	const summary = summarizeMetrics(points);

	const now = new Date();
	const rows = points.map((p) => ({
		id: crypto.randomUUID(),
		at: now,
		name: p.name,
		labels: Object.keys(p.labels).length ? JSON.stringify(p.labels) : null,
		value: p.value
	}));
	if (rows.length) await database.insert(metricSample).values(rows);

	if (summary.version) {
		await database
			.update(server)
			.set({ crowdsecVersion: summary.version })
			.where(eq(server.id, 'main'));
	}

	await database
		.insert(syncState)
		.values({ source: 'metrics', lastSuccessAt: now, lastError: null, lastErrorAt: null })
		.onConflictDoUpdate({
			target: syncState.source,
			set: { lastSuccessAt: now, lastError: null }
		});

	// Cheap retention — amortized, deletes a bounded slice each pass.
	await database
		.delete(metricSample)
		.where(lt(metricSample.at, new Date(now.getTime() - RETENTION_MS)));

	return { points: rows.length, version: summary.version };
}

export async function recordScrapeError(database: Db, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	await database
		.insert(syncState)
		.values({ source: 'metrics', lastError: message, lastErrorAt: new Date() })
		.onConflictDoUpdate({
			target: syncState.source,
			set: { lastError: message, lastErrorAt: new Date() }
		});
}
