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
import { runSiteChecks } from '#lib/server/protect/checks.ts';
import { drainJobs, enqueue } from '#lib/server/jobs/queue.ts';
import { checkDiskPressure, checkForUpdate, runRetention } from '#lib/server/ops.ts';
import { cloudflareAccount, site, syncState } from '#lib/server/db/app.schema.ts';

export const SYNC_INTERVAL_MS = 30_000;
/** Automated protection checks re-run once an hour — cheap projection reads. */
const CHECKS_EVERY_MS = 3_600_000;
/** Retention cleanup + update check once a day. */
const OPS_EVERY_MS = 86_400_000;
/** Edge lists fully reconcile every 15 min; fresher syncs happen on change. */
const EDGE_RECONCILE_MS = 15 * 60_000;
/** Don't re-enqueue an edge sync fresher than this without new alerts. */
const EDGE_DEBOUNCE_MS = 120_000;

/**
 * Enqueue a `cloudflare.sync` job for every active account that has a
 * list or selected zones. Idempotency keys collapse overlapping ticks;
 * the job itself diffs live list state, so bursts are harmless.
 */
async function maybeEnqueueEdgeSync(freshAlerts: boolean) {
	const accounts = await db
		.select({
			id: cloudflareAccount.id,
			tokenStatus: cloudflareAccount.tokenStatus,
			listId: cloudflareAccount.listId,
			lastSyncAt: cloudflareAccount.lastSyncAt
		})
		.from(cloudflareAccount);
	const now = Date.now();
	for (const a of accounts) {
		if (a.tokenStatus !== 'active' && !a.listId) continue;
		const age = a.lastSyncAt ? now - a.lastSyncAt.getTime() : Infinity;
		const due = age > EDGE_RECONCILE_MS || freshAlerts;
		if (!due || age < EDGE_DEBOUNCE_MS) continue;
		await enqueue(db, {
			kind: 'cloudflare.sync',
			params: { accountId: a.id },
			idempotencyKey: `edge-sync:${a.id}`,
			lockKey: `cloudflare:${a.id}`
		});
	}
}

let started = false;
let running = false;
let lastChecksAt = 0;
let lastOpsAt = 0;
let lastDiskAt = 0;

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
		// still need their channels. Durable jobs drain the same way — they
		// may not need CrowdSec at all (agent ops).
		await dispatchOutbox(db).catch((e) => console.error('outbox dispatch failed:', e));
		await drainJobs(db, `worker-${process.pid}`).catch((e) =>
			console.error('job drain failed:', e)
		);

		// Disk pressure is checked hourly — local state only, no LAPI needed.
		if (Date.now() - lastDiskAt >= CHECKS_EVERY_MS) {
			lastDiskAt = Date.now();
			await checkDiskPressure(db).catch((e) => console.error('disk check failed:', e));
		}
		// Retention + release check once a day; failures are non-fatal.
		if (Date.now() - lastOpsAt >= OPS_EVERY_MS) {
			lastOpsAt = Date.now();
			await runRetention(db).catch((e) => console.error('retention failed:', e));
			await checkForUpdate(db).catch((e) => console.error('update check failed:', e));
		}

		const serverRow = await getServer(db);
		if (!serverRow.connected) return;

		const client = await buildClient(db);
		if (client) {
			const hadError = await previousError('alerts');
			try {
				const result = await syncAlerts(db, client);
				await reportOutcome('alerts', null, `${result.stored} alerts stored`, !!hadError);
				await maybeEnqueueEdgeSync(result.stored > 0).catch((e) =>
					console.error('edge sync enqueue failed:', e)
				);
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

		// Hourly re-run of the automated protection checks — spec 5.6 wants
		// verification re-checked on a schedule, not just on demand.
		if (Date.now() - lastChecksAt >= CHECKS_EVERY_MS) {
			lastChecksAt = Date.now();
			const rows = await db.select({ id: site.id }).from(site);
			for (const row of rows) {
				await runSiteChecks(db, row.id).catch(() => undefined);
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
