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
import type { AlertsQuery } from './client.ts';
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
import { parseAliases } from '#lib/sites.ts';

export const HISTORY_DAYS = 30;
export const PAGE_SIZE = 100;

type Db = typeof db;

/**
 * LAPI `since`/`created_before` are Go durations measured from the server's
 * own clock — convert an instant into a "<n>s" duration, clamped at 0.
 * `slackS` widens (positive) or narrows (negative) the window.
 */
export function durationSince(at: Date, now = Date.now(), slackS = 0): string {
	return `${Math.max(0, Math.floor((now - at.getTime()) / 1000) + slackS)}s`;
}

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
export function isCentralOnly(a: LapiAlert): boolean {
	const ds = a.decisions ?? [];
	return ds.length > 0 && ds.every((d) => isCentralOrigin(d.origin));
}

/**
 * Sites keyed by hostname for datasource fallback + learned-site inserts.
 * Aliases resolve to the same site id; a real hostname always wins over an
 * alias, and the same alias on two sites is ambiguous — it resolves to
 * neither so attribution never assigns misleading ownership (spec 9).
 */
async function siteIndex(
	database: Db
): Promise<{ byName: Map<string, string>; ambiguous: Set<string> }> {
	const rows = await database
		.select({ id: site.id, hostname: site.hostname, aliases: site.aliases })
		.from(site);
	const owner = new Map<string, string>(); // hostname or alias → site id
	const ambiguous = new Set<string>();
	for (const r of rows) owner.set(normalize(r.hostname), r.id);
	// Aliases: a real hostname always wins over another site's claimed alias
	// (the alias is ignored, not ambiguous); the same alias on two sites is
	// ambiguous and resolves to neither.
	const aliasOwner = new Map<string, string>();
	for (const r of rows) {
		for (const a of parseAliases(r.aliases)) {
			if (owner.has(a)) continue; // real hostname takes precedence
			const prior = aliasOwner.get(a);
			if (prior === r.id) continue;
			if (prior) {
				ambiguous.add(a);
				continue;
			}
			aliasOwner.set(a, r.id);
		}
	}
	for (const [a, id] of aliasOwner) if (!ambiguous.has(a)) owner.set(a, id);
	return { byName: owner, ambiguous };
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
					// Refresh every mutable field — upstream ids are stable
					// identities on a real LAPI, but fixtures/mocks can reuse
					// them across restarts.
					type: d.type ?? null,
					scope: d.scope ?? null,
					value: d.value ?? null,
					scenario: d.scenario ?? a.scenario ?? null,
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
	index: { byName: Map<string, string>; ambiguous: Set<string> }
): Promise<string[]> {
	await database.delete(alertSite).where(eq(alertSite.alertUpstreamId, a.id!));
	const siteIds: string[] = [];
	for (const hit of attributeAlert(a, datasourceMap())) {
		const hostname = normalize(hit.hostname);
		// Ambiguous names get no owner — never a misleading learned site.
		if (index.ambiguous.has(hostname)) continue;
		let siteId = index.byName.get(hostname);
		if (!siteId) {
			siteId = crypto.randomUUID();
			await database
				.insert(site)
				.values({ id: siteId, hostname, source: 'learned' })
				.onConflictDoNothing();
			index.byName.set(hostname, siteId);
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

/**
 * Page backward through GET /v1/alerts. `since` is a duration computed from
 * the cursor; further pages constrain `created_before` to the oldest
 * created_at seen so far (5 s overlap, deduped by upstream id). LAPI orders
 * by created_at DESC, so each page is strictly older than the previous one.
 */
export async function syncAlerts(
	database: Db,
	client: LapiClient,
	{ historyDays = HISTORY_DAYS, pageSize = PAGE_SIZE, maxPages = 40 } = {}
): Promise<SyncResult> {
	const state = await getSyncRow(database, 'alerts');
	const cursor = state?.cursor ?? null; // ISO of the newest created_at seen
	// since filters started_at, which precedes created_at for slow buckets —
	// 6 h of slack keeps the overlap wide and absorbs clock skew.
	const since = cursor
		? durationSince(new Date(cursor), Date.now(), 6 * 3600)
		: `${historyDays * 24}h`;

	let fetched = 0;
	let stored = 0;
	let skippedCentral = 0;
	let pages = 0;
	let newest = cursor ?? '';
	let hitPageLimit = false;
	const siteIdx = await siteIndex(database);

	/**
	 * Store one batch; returns the oldest created_at in it (normalized to
	 * toISOString — LAPI timestamps arrive in mixed formats, and raw-string
	 * comparison sorts "…05Z" before "…05.000Z"). Incremental mode skips
	 * alerts already known AND at-or-before the cursor (the overlap window
	 * re-delivers them every tick); backfill mode skips anything already in
	 * the table — liveness is reconcileActiveDecisions' job.
	 */
	const processBatch = async (batch: LapiAlert[], mode: 'incremental' | 'backfill') => {
		const ids = batch.flatMap((a) => (a.id === undefined ? [] : [a.id]));
		const known = new Set(
			ids.length
				? (
						await database
							.select({ u: alert.upstreamId })
							.from(alert)
							.where(inArray(alert.upstreamId, ids))
					).map((r) => r.u)
				: []
		);
		let oldest: string | null = null;
		let processed = 0;
		for (const a of batch) {
			const created = ts(a.created_at)?.toISOString() ?? null;
			if (created && (!oldest || created < oldest)) oldest = created;
			if (a.id === undefined) continue;
			const skip =
				mode === 'backfill'
					? known.has(a.id)
					: cursor !== null && created !== null && created <= cursor && known.has(a.id);
			if (skip) continue;
			if (isCentralOnly(a)) {
				skippedCentral++;
				continue;
			}
			const { fresh } = await upsertAlert(database, a);
			await replaceDecisions(database, a);
			const siteIds = await attachSites(database, a, siteIdx);
			if (fresh) await rollupAlert(database, a, siteIds);
			stored++;
			processed++;
			if (created && created > newest) newest = created;
		}
		return { oldest, processed };
	};

	// Incremental pass: from the cursor forward (overlap) then backward.
	let oldestPrev: string | null = null;
	let reached: string | null = null; // oldest created_at processed so far
	for (;;) {
		const q: AlertsQuery = {
			since,
			limit: pageSize,
			includeCapi: false,
			includeSimulation: false,
			sort: 'DESC'
		};
		if (oldestPrev) {
			// Floor + 5 s overlap — same-second boundaries dedupe by upstream id.
			q.createdBefore = durationSince(new Date(oldestPrev), Date.now(), -5);
		}
		const batch = await client.alerts(q);
		pages++;
		if (batch.length === 0) break;
		fetched += batch.length;
		const { oldest } = await processBatch(batch, 'incremental');
		if (oldest) reached = oldest;

		if (batch.length < pageSize) break;
		if (cursor && oldest && oldest <= cursor) break;
		if (oldestPrev && oldest && oldest >= oldestPrev) {
			hitPageLimit = true; // >PAGE alerts share one second — can't page deeper
			break;
		}
		if (pages >= maxPages) {
			hitPageLimit = true;
			break;
		}
		oldestPrev = oldest;
	}

	// A backfill row created by an earlier call is continued below — read it
	// before inserting this pass's own cursor so the row we just wrote isn't
	// consumed in the same call.
	const backfill = await getSyncRow(database, 'alerts.backfill');

	// Any pass that stopped short of the window (initial import or an
	// incremental pass catching up after a long outage) leaves a backfill
	// cursor so later ticks keep walking back — otherwise the gap between
	// `reached` and the previous cursor is lost forever.
	if (hitPageLimit && reached && !backfill?.cursor) {
		await database
			.insert(syncState)
			.values({ source: 'alerts.backfill', cursor: reached })
			.onConflictDoUpdate({ target: syncState.source, set: { cursor: reached } });
	}

	// Continuation pass: up to 5 more backward pages per tick while a
	// backfill cursor exists.
	if (backfill?.cursor) {
		let bfCursor = backfill.cursor;
		let exhausted = false;
		for (let i = 0; i < 5 && !exhausted; i++) {
			const batch = await client.alerts({
				since: `${historyDays * 24}h`,
				createdBefore: durationSince(new Date(bfCursor), Date.now(), -5),
				limit: pageSize,
				includeCapi: false,
				includeSimulation: false,
				sort: 'DESC'
			});
			if (batch.length === 0) {
				exhausted = true;
				break;
			}
			fetched += batch.length;
			pages++;
			const { oldest, processed } = await processBatch(batch, 'backfill');
			if (oldest) bfCursor = oldest;
			if (batch.length < pageSize) exhausted = true;
			// A full page of nothing-but-known alerts means this stretch was
			// already covered — also terminates >PAGE-in-one-second replays.
			if (batch.length === pageSize && processed === 0) exhausted = true;
			if (oldest && new Date(oldest).getTime() < Date.now() - historyDays * 86_400_000)
				exhausted = true;
		}
		if (exhausted) {
			await database.delete(syncState).where(eq(syncState.source, 'alerts.backfill'));
		} else {
			await database
				.update(syncState)
				.set({ cursor: bfCursor })
				.where(eq(syncState.source, 'alerts.backfill'));
		}
	}

	// Expired decisions reconcile on every pass.
	await database.update(decision).set({ expired: true }).where(lt(decision.until, new Date()));

	// Partial means a backfill row is still outstanding — a pass that hit
	// the limit but whose continuation exhausted within this call is done.
	const partial = !!(await getSyncRow(database, 'alerts.backfill'))?.cursor;
	await setSyncOk(database, 'alerts', newest || null, partial);
	return { fetched, stored, skippedCentral, partial, cursor: newest };
}

/**
 * Reconcile local decision liveness against upstream's active set —
 * independent of the sync window, so removals (unbans, LAPI-side expiries)
 * on alerts outside `since` still propagate. Fetches every alert with an
 * active decision; when upstream answers at the limit the mark-missing
 * step is skipped because the set is provably incomplete.
 */
export async function reconcileActiveDecisions(
	database: Db,
	client: LapiClient
): Promise<{ refreshed: number; expired: number; partial: boolean }> {
	const LIMIT = 5000;
	const batch = await client.alerts({
		hasActiveDecision: true,
		includeCapi: false,
		includeSimulation: false,
		limit: LIMIT
	});
	const siteIdx = await siteIndex(database);
	const now = Date.now();
	const activeUpstream = new Set<number>();
	let refreshed = 0;

	for (const a of batch) {
		if (a.id === undefined) continue;
		if (isCentralOnly(a)) continue;
		const { fresh } = await upsertAlert(database, a);
		await replaceDecisions(database, a);
		if (fresh) {
			const siteIds = await attachSites(database, a, siteIdx);
			await rollupAlert(database, a, siteIds);
		}
		refreshed++;
		for (const d of a.decisions ?? []) {
			if (d.id === undefined) continue;
			const until = ts(d.until);
			if (until && until.getTime() > now) activeUpstream.add(d.id);
		}
	}

	if (batch.length >= LIMIT) return { refreshed, expired: 0, partial: true };

	const local = await database
		.select({ id: decision.id, upstreamId: decision.upstreamId })
		.from(decision)
		.where(eq(decision.expired, false));
	const missing = local.filter((r) => !activeUpstream.has(r.upstreamId)).map((r) => r.id);
	for (let i = 0; i < missing.length; i += 500) {
		await database
			.update(decision)
			.set({ expired: true })
			.where(inArray(decision.id, missing.slice(i, i + 500)));
	}
	return { refreshed, expired: missing.length, partial: false };
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
