import type { RequestHandler } from './$types';
import { apiAuth, bodyTooBig, jsonErr, respond } from '#lib/server/api/http.ts';
import { createDecision, decisions, removeDecision } from '#lib/server/api/v1.ts';
import { db } from '#lib/server/db/index.ts';

export const GET: RequestHandler = async (event) => {
	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;
	return respond(() => decisions(db, auth.principal, event.url.searchParams));
};

export const POST: RequestHandler = async (event) => {
	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;
	const tooBig = bodyTooBig(event);
	if (tooBig) return tooBig;
	const body = await event.request.json().catch(() => null);
	if (!body || typeof body !== 'object') return jsonErr(400, 'Expected a JSON object body.');
	return respond(() => createDecision(db, auth.principal, body as Record<string, unknown>));
};

export const DELETE: RequestHandler = async (event) => {
	const auth = await apiAuth(event);
	if ('response' in auth) return auth.response;
	const tooBig = bodyTooBig(event);
	if (tooBig) return tooBig;
	const body = await event.request.json().catch(() => null);
	if (!body || typeof body !== 'object') return jsonErr(400, 'Expected a JSON object body.');
	return respond(() => removeDecision(db, auth.principal, body as Record<string, unknown>));
};
