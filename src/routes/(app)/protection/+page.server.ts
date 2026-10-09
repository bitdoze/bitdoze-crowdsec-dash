import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { CHECKS, protectionMatrix } from '#lib/server/protect/checks.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import { projectionFreshness } from '#lib/server/crowdsec/lists.ts';

export const load: PageServerLoad = async () => {
	const [srv, freshness, matrix] = await Promise.all([
		getServer(db),
		projectionFreshness(db),
		protectionMatrix(db)
	]);
	return {
		connected: srv.connected,
		freshness,
		checkDefs: CHECKS,
		matrix
	};
};
