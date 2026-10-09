/**
 * Alert/decision synchronization.
 *
 * The local tables are a *projection* of upstream state: alerts are upserted
 * by upstream ID, their decision and alert_site rows are replaced wholesale
 * on every re-sync (so decision removals reconcile), and decision expiry is
 * reconciled from `until`. Alerts whose decisions all carry central origins
 * (CAPI/lists) are skipped by default — community blocklist volume comes
 * from metrics instead (spec phase 3).
 *
 * Cursor: RFC3339 of the newest `created_at` seen. The next page overlaps it
 * deliberately (`since` is inclusive) — upserts dedupe and rollups only
 * count an alert on first insert, so overlap never double-counts.
 *
 * Historical import is bounded to `historyDays`; while a first import is
 * still catching up, `sync_state.partial` stays set so the UI can show a
 * "partial data" state instead of pretending the cache is complete.
 */
import { eq, inArray, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import {
	activityRollup,
	alert,
	alertSite,
	decision,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import type { LapiClient } from './client.ts';
import { isCentralOrigin, type LapiAlert } from './types.ts';
import { attributeAlert, mergedEventMeta, normalize, type DatasourceMap } from './attribution.ts';

export const HISTORY_DAYS = 30;
export const PAGE_SIZE = 500;

type Db = typeof db;

/** LAPI geo fields arrive as strings ("48.8566") — coerce, null on junk. */
const num = (v: number | string | undefined | null): number | null => {
	const n = typeof v === 'string' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const ts = (iso: string | undefined | null): Date | null => {
	if (!iso) return null;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? null : d;
};

async function getSyncRow(database: Db, source: string) {
	return database.select().from(syncState).where(eq(syncState.source, source)).get();
}

async function setSyncOk(database: Db, source: string, cursor: string | null, partial: boolean) {
	await database
		.insert(syncState)
		.values({
			source,
			cursor,
			lastSuccessAt: new Date(),
			lastError: null,
			lastErrorAt: null,
			partial
		})
		.onConflictDoUpdate({
			target: syncState.source,
			set: { cursor, lastSuccessAt: new Date(), lastError: null, partial }
		});
}

async function setSyncError(database: Db, source: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	await database
		.insert(syncState)
		.values({ source, lastError: message, lastErrorAt: new Date() })
		.onConflictDoUpdate({
			target: syncState.source,
			set: { lastError: message, lastErrorAt: new Date() }
		});
}

/** Alert is skipped when every decision has a central origin (CAPI/lists). */
function isCentralOnly(a: LapiAlert): boolean {
	const ds = a.decisions ?? [];
	return ds.length > 0 && ds.every((d) => isCentralOrigin(d.origin));
}

/** Sites keyed by hostname for datasource fallback + learned-site inserts. */
async function siteIndex(database: Db): Promise<Map<string, string>> {
	const rows = await database.select({ id: site.id, hostname: site.hostname }).from(site);
	return new Map(rows.map((r) => [r.hostname, r.id]));
}

/** Datasource prefix map — manual sites may carry one later; empty for now. */
function datasourceMap(): DatasourceMap {
	return { pathPrefix: [] };
}

async function upsertAlert(database: Db, a: LapiAlert): Promise<{ rowId: string; fresh: boolean }> {
	const upstreamId = a.id!;
	const existing = await database
		.select({ id: alert.id })
		.from(alert)
		.where(eq(alert.upstreamId, upstreamId))
		.get();

	const values = {
		upstreamId,
		serverId: 'main',
		machineId: a.machine_id ?? null,
		scenario: a.scenario ?? null,
		scenarioVersion: a.scenario_version ?? null,
		message: a.message ?? null,
		eventsCount: a.events_count ?? null,
		capacity: a.capacity ?? null,
		leakspeed: a.leakspeed ?? null,
		simulated: a.simulated ?? false,
		startedAt: ts(a.started_at),
		stoppedAt: ts(a.stopped_at),
		createdAt: ts(a.created_at),
		sourceScope: a.source?.scope ?? null,
		sourceValue: a.source?.value ?? null,
		sourceIp: a.source?.ip ?? a.source?.value ?? null,
		sourceCn: a.source?.cn ?? null,
		sourceAsName: a.source?.as_name ?? null,
		sourceAsNumber: a.source?.as_number ?? null,
		sourceLatitude: num(a.source?.latitude),
		sourceLongitude: num(a.source?.longitude),
		context: a.context?.length ? JSON.stringify(a.context) : null,
		eventsMeta: JSON.stringify(mergedEventMeta(a)),
		syncedAt: new Date()
	};

	if (existing) {
		await database.update(alert).set(values).where(eq(alert.id, existing.id));
		return { rowId: existing.id, fresh: false };
	}
	const rowId = crypto.randomUUID();
	await database.insert(alert).values({ id: rowId, ...values });
	return { rowId, fresh: true };
}

/** Replace an alert's decision rows wholesale — deletions reconcile. */
async function replaceDecisions(database: Db, a: LapiAlert) {
	await database.delete(decision).where(eq(decision.alertUpstreamId, a.id!));
	for (const d of a.decisions ?? []) {
		if (d.id === undefined) continue;
		const until = ts(d.until);
		await database
			.insert(decision)
			.values({
				id: crypto.randomUUID(),
				upstreamId: d.id,
				alertUpstreamId: a.id!,
				serverId: 'main',
				origin: d.origin ?? null,
				type: d.type ?? null,
				scope: d.scope ?? null,
				value: d.value ?? null,
				duration: d.duration ?? null,
				scenario: d.scenario ?? a.scenario ?? null,
				until,
				expired: until !== null && until.getTime() < Date.now(),
				syncedAt: new Date()
			})
			.onConflictDoUpdate({
				target: decision.upstreamId,
				set: {
					until: until ? until : undefined,
					expired: until !== null && until.getTime() < Date.now(),
					syncedAt: new Date(),
					alertUpstreamId: a.id!
				}
			});
	}
}

/** Attribute an alert to sites; learned sites are created on first sight. */
async function attachSites(
	database: Db,
	a: LapiAlert,
	sitesByName: Map<string, string>
): Promise<string[]> {
	await database.delete(alertSite).where(eq(alertSite.alertUpstreamId, a.id!));
	const siteIds: string[] = [];
	for (const hit of attributeAlert(a, datasourceMap())) {
		const hostname = normalize(hit.hostname);
		let siteId = sitesByName.get(hostname);
		if (!siteId) {
			siteId = crypto.randomUUID();
			await database
				.insert(site)
				.values({ id: siteId, hostname, source: 'learned' })
				.onConflictDoNothing();
			sitesByName.set(hostname, siteId);
		}
		await database
			.insert(alertSite)
			.values({ alertUpstreamId: a.id!, siteId, signal: hit.signal })
			.onConflictDoNothing();
		siteIds.push(siteId);
	}
	return siteIds;
}

/** One rollup row per (hour, site|null, scenario, cn); only fresh alerts count. */
async function rollupAlert(database: Db, a: LapiAlert, siteIds: string[]) {
	const at = ts(a.stopped_at) ?? ts(a.created_at) ?? new Date();
	const hourMs = Math.floor(at.getTime() / 3_600_000) * 3_600_000;
	const hour = new Date(hourMs);
	const targets = siteIds.length ? siteIds : [null];
	for (const siteId of targets) {
		const id = `${hourMs}|${siteId ?? '-'}|${a.scenario ?? '-'}|${a.source?.cn ?? '-'}`;
		await database
			.insert(activityRollup)
			.values({
				id,
				hour,
				siteId,
				scenario: a.scenario ?? null,
				cn: a.source?.cn ?? null,
				count: 1
			})
			.onConflictDoUpdate({
				target: activityRollup.id,
				set: { count: sql`${activityRollup.count} + 1` }
			});
	}
}

export interface SyncResult {
	fetched: number;
	stored: number;
	skippedCentral: number;
	partial: boolean;
	cursor: string;
}

export async function syncAlerts(
	database: Db,
	client: LapiClient,
	{ historyDays = HISTORY_DAYS, pageSize = PAGE_SIZE, maxPages = 40 } = {}
): Promise<SyncResult> {
	const state = await getSyncRow(database, 'alerts');
	let since = state?.cursor ?? new Date(Date.now() - historyDays * 86_400_000).toISOString();
	const initial = !state?.cursor;

	let fetched = 0;
	let stored = 0;
	let skippedCentral = 0;
	let pages = 0;
	let newest = since;
	const sitesByName = await siteIndex(database);

	for (;;) {
		const batch = await client.alerts({ since, limit: pageSize, includeSimulation: false });
		pages++;
		if (batch.length === 0) break;
		fetched += batch.length;

		for (const a of batch) {
			if (a.id === undefined) continue;
			if (isCentralOnly(a)) {
				skippedCentral++;
				continue;
			}
			const { fresh } = await upsertAlert(database, a);
			await replaceDecisions(database, a);
			const siteIds = await attachSites(database, a, sitesByName);
			if (fresh) await rollupAlert(database, a, siteIds);
			stored++;
			const created = ts(a.created_at);
			if (created && created.toISOString() > newest) newest = created.toISOString();
		}

		// LAPI returns newest-first; keep paging while the window still fills a
		// full page. `since` advances so the next page can't repeat rows forever.
		if (batch.length < pageSize || pages >= maxPages) break;
		since = newest;
	}

	// Expired decisions reconcile on every pass.
	await database.update(decision).set({ expired: true }).where(lt(decision.until, new Date()));

	const partial = pages >= maxPages || (initial && fetched === pageSize * maxPages);
	await setSyncOk(database, 'alerts', newest, partial);
	return { fetched, stored, skippedCentral, partial, cursor: newest };
}

export async function recordSyncError(database: Db, error: unknown) {
	await setSyncError(database, 'alerts', error);
}

/** Purge expired-only decisions older than the alert cache window. */
export async function pruneExpired(database: Db, olderThan: Date) {
	const stale = await database
		.select({ id: decision.id })
		.from(decision)
		.where(lt(decision.until, olderThan));
	if (stale.length) {
		await database.delete(decision).where(
			inArray(
				decision.id,
				stale.map((d) => d.id)
			)
		);
	}
}
