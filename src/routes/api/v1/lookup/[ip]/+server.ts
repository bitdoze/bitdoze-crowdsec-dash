import type { RequestHandler } from './$types';
import { apiAuth, respond } from '#lib/server/api/http.ts';
import { lookupIp } from '#lib/server/api/v1.ts';
import { db } from '#lib/server/db/index.ts';

export const GET: RequestHandler = async (event) => {
	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;
	return respond(() => lookupIp(db, auth.principal, event.params.ip));
};
