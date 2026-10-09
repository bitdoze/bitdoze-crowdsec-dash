/**
 * In-process sync worker. Started once from the server `init` hook — the
 * dashboard runs as a single process, so a module-level guard is the lease.
 * (If a separate worker process ever exists, replace the guard with a DB
 * lease; spec section 4/10.)
 *
 * The loop is deliberately dumb: every interval, sync alerts from the LAPI
 * cursor, scrape the metrics endpoint, record freshness. Errors land in
 * sync_state for the UI to surface — the worker never crashes the process.
 */
import { db } from '#lib/server/db/index.ts';
import { buildClient, getServer } from './connection.ts';
import { syncAlerts } from './sync.ts';
import { scrapeMetrics, recordScrapeError } from './scrape.ts';
import { syncState } from '#lib/server/db/app.schema.ts';

export const SYNC_INTERVAL_MS = 30_000;

let started = false;
let running = false;

async function tick() {
	if (running) return; // a slow tick must not overlap the next one
	running = true;
	try {
		const serverRow = await getServer(db);
		if (!serverRow.connected) return;

		const client = await buildClient(db);
		if (client) {
			try {
				await syncAlerts(db, client);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				await db
					.insert(syncState)
					.values({ source: 'alerts', lastError: message, lastErrorAt: new Date() })
					.onConflictDoUpdate({
						target: syncState.source,
						set: { lastError: message, lastErrorAt: new Date() }
					});
			}
		}

		if (serverRow.metricsUrl) {
			try {
				await scrapeMetrics(db, serverRow.metricsUrl);
			} catch (e) {
				await recordScrapeError(db, e);
			}
		}
	} finally {
		running = false;
	}
}

export function startWorker(intervalMs = SYNC_INTERVAL_MS) {
	if (started) return;
	started = true;
	void tick();
	const timer = setInterval(() => void tick(), intervalMs);
	timer.unref?.();
}
