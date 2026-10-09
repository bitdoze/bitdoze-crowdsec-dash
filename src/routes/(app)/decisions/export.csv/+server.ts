import type { RequestHandler } from './$types';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { decision } from '#lib/server/db/app.schema.ts';
import { requireUser } from '#lib/server/roles.ts';
import { csvResponse, toCsv } from '#lib/server/csv.ts';

const CAP = 5000;

/** CSV export honoring the decisions list filters (spec 9). */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	const url = event.url;
	const q = url.searchParams.get('q') ?? undefined;
	const includeExpired = url.searchParams.get('expired') === '1';
	const where = and(
		includeExpired ? undefined : eq(decision.expired, false),
		q
			? or(
					like(decision.value, `%${q}%`),
					like(decision.scenario, `%${q}%`),
					like(decision.origin, `%${q}%`)
				)
			: undefined
	);
	const rows = await db
		.select()
		.from(decision)
		.where(where)
		.orderBy(desc(decision.syncedAt))
		.limit(CAP);
	const csv = toCsv(
		['upstream_id', 'type', 'scope', 'value', 'origin', 'scenario', 'duration', 'until', 'expired'],
		rows.map((r) => [
			r.upstreamId,
			r.type,
			r.scope,
			r.value,
			r.origin,
			r.scenario,
			r.duration,
			r.until,
			r.expired ? '1' : '0'
		])
	);
	return csvResponse(`decisions-${new Date().toISOString().slice(0, 10)}.csv`, csv);
};
