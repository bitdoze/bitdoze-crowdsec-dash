/**
 * In-process sync worker. Started once from the server `init` hook — the
 * dashboard runs as a single process, so a module-level guard is the lease.
 * (If a separate worker process ever exists, replace the guard with a DB
 * lease; spec section 4/10.)
 *
 * The loop is deliberately dumb: every interval, sync alerts from the LAPI
 * cursor, scrape the metrics endpoint, reconcile decision requests, drain the
 * notification outbox. Errors land in sync_state for the UI to surface and fan
 * out to notifications — the worker never crashes the process.
 */
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { buildClient, getServer } from './connection.ts';
import { syncAlerts } from './sync.ts';
import { scrapeMetrics, recordScrapeError } from './scrape.ts';
import { reconcile } from './decisions.ts';
import { dispatchOutbox } from '#lib/server/notify/deliver.ts';
import { recordEvent } from '#lib/server/notify/core.ts';
import { syncState } from '#lib/server/db/app.schema.ts';

export const SYNC_INTERVAL_MS = 30_000;

let started = false;
let running = false;

async function previousError(source: 'alerts' | 'metrics'): Promise<string | null> {
	const row = await db
		.select({ lastError: syncState.lastError })
		.from(syncState)
		.where(eq(syncState.source, source))
		.get();
	return row?.lastError ?? null;
}

/**
 * Report an outage or recovery. `hadError` must be captured BEFORE the
 * operation runs — a successful sync clears sync_state.lastError itself.
 */
async function reportOutcome(
	source: 'alerts' | 'metrics',
	error: unknown | null,
	detail: string,
	hadError: boolean
) {
	if (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordEvent(db, {
			eventKey: `${source}.down`,
			class: 'outage',
			severity: source === 'alerts' ? 'critical' : 'warning',
			title: source === 'alerts' ? 'LAPI sync failing' : 'Metrics scrape failing',
			body: `${detail}: ${message}`
		});
	} else if (hadError) {
		await recordEvent(db, {
			eventKey: `${source}.recovered.${Date.now()}`,
			class: 'outage',
			severity: 'info',
			title: source === 'alerts' ? 'LAPI sync recovered' : 'Metrics scrape recovered',
			body: detail
		});
	}
}

async function tick() {
	if (running) return; // a slow tick must not overlap the next one
	running = true;
	try {
		// Deliveries must run even while disconnected — audit/admin events
		// still need their channels.
		await dispatchOutbox(db).catch((e) => console.error('outbox dispatch failed:', e));

		const serverRow = await getServer(db);
		if (!serverRow.connected) return;

		const client = await buildClient(db);
		if (client) {
			const hadError = await previousError('alerts');
			try {
				const result = await syncAlerts(db, client);
				await reportOutcome('alerts', null, `${result.stored} alerts stored`, !!hadError);
				if (result.stored > 0) {
					const hour = new Date().toISOString().slice(0, 13);
					await recordEvent(db, {
						eventKey: `security.alerts.${hour}`,
						class: 'security',
						severity: 'warning',
						title: `${result.stored} new alert${result.stored === 1 ? '' : 's'} synced`,
						body: 'New CrowdSec alerts arrived in the last sync window.',
						href: '/alerts'
					});
				}
				await reconcile(db);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				await db
					.insert(syncState)
					.values({ source: 'alerts', lastError: message, lastErrorAt: new Date() })
					.onConflictDoUpdate({
						target: syncState.source,
						set: { lastError: message, lastErrorAt: new Date() }
					});
				await reportOutcome('alerts', e, 'sync threw', !!hadError);
			}
		}

		if (serverRow.metricsUrl) {
			const hadError = await previousError('metrics');
			try {
				await scrapeMetrics(db, serverRow.metricsUrl);
				await reportOutcome('metrics', null, 'scrape ok', !!hadError);
			} catch (e) {
				await recordScrapeError(db, e);
				await reportOutcome('metrics', e, 'scrape threw', !!hadError);
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
