import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { buildSupportBundle } from '#lib/server/ops.ts';
import { recordAudit } from '#lib/server/audit.ts';

/** Redacted diagnostic bundle — counts, versions, sync state; never secrets. */
export const GET: RequestHandler = async (event) => {
	requirePermission(event, 'configure');
	const bundle = await buildSupportBundle(db);
	await recordAudit({ event, action: 'system.support_bundle' });
	const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
	return new Response(JSON.stringify(bundle, null, 2), {
		headers: {
			'content-type': 'application/json',
			'content-disposition': `attachment; filename="crowdsec-dash-support-${ts}.json"`
		}
	});
};
