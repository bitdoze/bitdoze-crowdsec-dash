import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { listAlerts, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import { site } from '#lib/server/db/app.schema.ts';

export const load: PageServerLoad = async ({ url }) => {
	const connected = !!(await getServer(db));
	const freshness = await projectionFreshness(db);
	const sites = await db
		.select({ id: site.id, hostname: site.hostname })
		.from(site)
		.orderBy(site.hostname);
	const list = await listAlerts(db, {
		siteId: url.searchParams.get('site') ?? undefined,
		scenario: url.searchParams.get('scenario') ?? undefined,
		ip: url.searchParams.get('ip') ?? undefined,
		page: Number(url.searchParams.get('page') ?? 1) || 1
	});
	return {
		connected,
		freshness,
		sites,
		list,
		filters: {
			site: url.searchParams.get('site') ?? '',
			scenario: url.searchParams.get('scenario') ?? '',
			ip: url.searchParams.get('ip') ?? ''
		}
	};
};
