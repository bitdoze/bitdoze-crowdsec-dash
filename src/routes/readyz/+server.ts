import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.ts';
import { appState } from '#lib/server/state.ts';

export const GET: RequestHandler = async () => {
	let ready = appState.migrationsApplied;
	if (ready) {
		try {
			await db.run(sql`SELECT 1`);
		} catch {
			ready = false;
		}
	}
	return Response.json(
		{ status: ready ? 'ok' : 'not_ready' },
		{ status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
