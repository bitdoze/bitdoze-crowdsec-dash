import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { ipDetail, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';

export const load: PageServerLoad = async ({ params }) => {
	const connected = !!(await getServer(db));
	const freshness = await projectionFreshness(db);
	const detail = await ipDetail(db, params.ip);
	return { connected, freshness, ip: params.ip, detail };
};
