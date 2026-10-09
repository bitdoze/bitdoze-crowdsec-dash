import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { listDecisions, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';

export const load: PageServerLoad = async ({ url }) => {
	const connected = !!(await getServer(db));
	const freshness = await projectionFreshness(db);
	const list = await listDecisions(db, {
		q: url.searchParams.get('q') ?? undefined,
		includeExpired: url.searchParams.get('expired') === '1',
		page: Number(url.searchParams.get('page') ?? 1) || 1
	});
	return {
		connected,
		freshness,
		list,
		filters: {
			q: url.searchParams.get('q') ?? '',
			expired: url.searchParams.get('expired') === '1'
		}
	};
};
