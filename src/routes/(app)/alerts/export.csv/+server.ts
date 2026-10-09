import type { RequestHandler } from './$types';
import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { alert, alertSite, site } from '#lib/server/db/app.schema.ts';
import { requireUser } from '#lib/server/roles.ts';
import { csvResponse, toCsv } from '#lib/server/csv.ts';

const CAP = 5000;

/** CSV export honoring the same filters as the alerts list (spec 9). */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const url = event.url;
	const siteId = url.searchParams.get('site') ?? undefined;
	const scenario = url.searchParams.get('scenario') ?? undefined;
	const ip = url.searchParams.get('ip') ?? undefined;
	const where = and(
		ip ? or(like(alert.sourceIp, `%${ip}%`), like(alert.sourceValue, `%${ip}%`)) : undefined,
		scenario ? like(alert.scenario, `%${scenario}%`) : undefined,
		siteId
			? sql`EXISTS (SELECT 1 FROM alert_site WHERE alert_site.alert_upstream_id = ${alert.upstreamId} AND alert_site.site_id = ${siteId})`
			: undefined
	);
	const rows = await db
		.select({
			upstreamId: alert.upstreamId,
			scenario: alert.scenario,
			message: alert.message,
			sourceIp: alert.sourceIp,
			sourceCn: alert.sourceCn,
			sourceAsName: alert.sourceAsName,
			startedAt: alert.startedAt,
			simulated: alert.simulated
		})
		.from(alert)
		.where(where)
		.orderBy(desc(alert.startedAt))
		.limit(CAP);
	const ids = rows.map((r) => r.upstreamId);
	const links = ids.length
		? await db
				.select({
					alertUpstreamId: alertSite.alertUpstreamId,
					hostname: site.hostname
				})
				.from(alertSite)
				.innerJoin(site, eq(alertSite.siteId, site.id))
				.where(inArray(alertSite.alertUpstreamId, ids))
		: [];
	const bySite = new Map<number, string[]>();
	for (const l of links) {
		if (!l.hostname) continue;
		const arr = bySite.get(l.alertUpstreamId) ?? [];
		arr.push(l.hostname);
		bySite.set(l.alertUpstreamId, arr);
	}
	const csv = toCsv(
		[
			'upstream_id',
			'scenario',
			'source_ip',
			'source_cn',
			'source_as',
			'sites',
			'started_at',
			'simulated',
			'message'
		],
		rows.map((r) => [
			r.upstreamId,
			r.scenario,
			r.sourceIp,
			r.sourceCn,
			r.sourceAsName,
			(bySite.get(r.upstreamId) ?? []).join('|'),
			r.startedAt,
			r.simulated ? '1' : '0',
			r.message
		])
	);
	return csvResponse(`alerts-${new Date().toISOString().slice(0, 10)}.csv`, csv);
};
