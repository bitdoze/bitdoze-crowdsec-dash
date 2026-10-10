/**
 * Read-side queries over the CrowdSec projection tables — shared by the
 * alerts, decisions, and IP detail pages. Everything here reads the local
 * projection; nothing hits the LAPI per request.
 */
import { and, desc, eq, gte, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import { alert, alertSite, decision, site, syncState } from '#lib/server/db/app.schema.ts';

type Db = typeof db;

export const PER_PAGE = 25;

export interface AlertRow {
	upstreamId: number;
	scenario: string | null;
	message: string | null;
	sourceIp: string | null;
	sourceCn: string | null;
	sourceAsName: string | null;
	startedAt: Date | null;
	simulated: boolean;
	sites: { id: string; hostname: string; signal: string }[];
	decisions: number;
	activeDecisions: number;
}

export interface ListResult<T> {
	rows: T[];
	total: number;
	page: number;
	perPage: number;
	pages: number;
}

/** Sync freshness for the stale/partial banner. */
export async function projectionFreshness(database: Db) {
	const rows = await database.select().from(syncState);
	const alerts = rows.find((r) => r.source === 'alerts');
	return {
		lastSuccessAt: alerts?.lastSuccessAt ?? null,
		lastError: alerts?.lastError ?? null,
		partial: alerts?.partial ?? false,
		empty: !alerts?.lastSuccessAt
	};
}

export async function listAlerts(
	database: Db,
	opts: { siteId?: string; scenario?: string; ip?: string; page?: number; since?: Date } = {}
): Promise<ListResult<AlertRow>> {
	const page = Math.max(1, opts.page ?? 1);
	const where = and(
		opts.ip
			? or(like(alert.sourceIp, `%${opts.ip}%`), like(alert.sourceValue, `%${opts.ip}%`))
			: undefined,
		opts.scenario ? like(alert.scenario, `%${opts.scenario}%`) : undefined,
		opts.since ? gte(alert.startedAt, opts.since) : undefined,
		opts.siteId
			? sql`EXISTS (SELECT 1 FROM alert_site WHERE alert_site.alert_upstream_id = ${alert.upstreamId} AND alert_site.site_id = ${opts.siteId})`
			: undefined
	);

	const [{ n: total }] = await database
		.select({ n: sql<number>`count(*)` })
		.from(alert)
		.where(where);

	const rows = await database
		.select()
		.from(alert)
		.where(where)
		.orderBy(desc(alert.startedAt))
		.limit(PER_PAGE)
		.offset((page - 1) * PER_PAGE);

	const ids = rows.map((r) => r.upstreamId);
	const links = ids.length
		? await database
				.select({
					alertUpstreamId: alertSite.alertUpstreamId,
					siteId: site.id,
					hostname: site.hostname,
					signal: alertSite.signal
				})
				.from(alertSite)
				.innerJoin(site, eq(alertSite.siteId, site.id))
				.where(inArray(alertSite.alertUpstreamId, ids))
		: [];
	const decs = ids.length
		? await database
				.select({
					alertUpstreamId: decision.alertUpstreamId,
					total: sql<number>`count(*)`,
					active: sql<number>`sum(case when ${decision.expired} = 0 then 1 else 0 end)`
				})
				.from(decision)
				.where(inArray(decision.alertUpstreamId, ids))
				.groupBy(decision.alertUpstreamId)
		: [];

	const bySite = new Map<number, AlertRow['sites']>();
	for (const l of links) {
		const arr = bySite.get(l.alertUpstreamId) ?? [];
		arr.push({ id: l.siteId, hostname: l.hostname, signal: l.signal });
		bySite.set(l.alertUpstreamId, arr);
	}
	const byDec = new Map(decs.map((d) => [d.alertUpstreamId, d]));

	return {
		rows: rows.map((r) => ({
			upstreamId: r.upstreamId,
			scenario: r.scenario,
			message: r.message,
			sourceIp: r.sourceIp,
			sourceCn: r.sourceCn,
			sourceAsName: r.sourceAsName,
			startedAt: r.startedAt,
			simulated: r.simulated,
			sites: bySite.get(r.upstreamId) ?? [],
			decisions: byDec.get(r.upstreamId)?.total ?? 0,
			activeDecisions: byDec.get(r.upstreamId)?.active ?? 0
		})),
		total,
		page,
		perPage: PER_PAGE,
		pages: Math.max(1, Math.ceil(total / PER_PAGE))
	};
}

export interface DecisionRow {
	upstreamId: number;
	alertUpstreamId: number | null;
	origin: string | null;
	type: string | null;
	scope: string | null;
	value: string | null;
	scenario: string | null;
	duration: string | null;
	until: Date | null;
	expired: boolean;
}

export async function listDecisions(
	database: Db,
	opts: { q?: string; includeExpired?: boolean; page?: number } = {}
): Promise<ListResult<DecisionRow>> {
	const page = Math.max(1, opts.page ?? 1);
	const where = and(
		opts.includeExpired ? undefined : eq(decision.expired, false),
		opts.q
			? or(
					like(decision.value, `%${opts.q}%`),
					like(decision.scenario, `%${opts.q}%`),
					like(decision.origin, `%${opts.q}%`)
				)
			: undefined
	);
	const [{ n: total }] = await database
		.select({ n: sql<number>`count(*)` })
		.from(decision)
		.where(where);
	const rows = await database
		.select()
		.from(decision)
		.where(where)
		.orderBy(desc(decision.syncedAt))
		.limit(PER_PAGE)
		.offset((page - 1) * PER_PAGE);
	return {
		rows: rows.map((r) => ({
			upstreamId: r.upstreamId,
			alertUpstreamId: r.alertUpstreamId,
			origin: r.origin,
			type: r.type,
			scope: r.scope,
			value: r.value,
			scenario: r.scenario,
			duration: r.duration,
			until: r.until,
			expired: r.expired
		})),
		total,
		page,
		perPage: PER_PAGE,
		pages: Math.max(1, Math.ceil(total / PER_PAGE))
	};
}

export async function ipDetail(database: Db, ip: string) {
	const alerts = await listAlerts(database, { ip, page: 1 });
	const decs = await database
		.select()
		.from(decision)
		.where(like(decision.value, ip))
		.orderBy(desc(decision.syncedAt))
		.limit(50);
	const a = await database
		.select()
		.from(alert)
		.where(or(eq(alert.sourceIp, ip), eq(alert.sourceValue, ip)))
		.orderBy(desc(alert.startedAt))
		.limit(1)
		.get();
	return {
		source: a
			? {
					cn: a.sourceCn,
					asName: a.sourceAsName,
					asNumber: a.sourceAsNumber,
					latitude: a.sourceLatitude,
					longitude: a.sourceLongitude
				}
			: null,
		alerts,
		decisions: decs.map((r) => ({
			upstreamId: r.upstreamId,
			origin: r.origin,
			type: r.type,
			scope: r.scope,
			value: r.value,
			scenario: r.scenario,
			until: r.until,
			expired: r.expired
		}))
	};
}

export { isNotNull };
