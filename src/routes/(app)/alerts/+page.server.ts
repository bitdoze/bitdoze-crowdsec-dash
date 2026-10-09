import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { listAlerts, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import { savedView, site } from '#lib/server/db/app.schema.ts';
import { requireUser } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';

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
	const views = await db.select().from(savedView).where(eq(savedView.page, 'alerts'));
	return {
		connected,
		freshness,
		sites,
		list,
		views,
		filters: {
			site: url.searchParams.get('site') ?? '',
			scenario: url.searchParams.get('scenario') ?? '',
			ip: url.searchParams.get('ip') ?? ''
		}
	};
};

export const actions: Actions = {
	/** Save the current filter set as a named view chip (spec 9). */
	saveView: async (event) => {
		await requireUser(event);
		const formData = await event.request.formData();
		const name = formData.get('name')?.toString().trim() ?? '';
		if (!name || name.length > 60) error(400, 'Give the view a name (≤60 chars).');
		const params: Record<string, string> = {};
		for (const k of ['site', 'scenario', 'ip']) {
			const v = formData.get(`f_${k}`)?.toString() ?? '';
			if (v) params[k] = v;
		}
		await db.insert(savedView).values({
			id: crypto.randomUUID(),
			page: 'alerts',
			name,
			params: JSON.stringify(params)
		});
		await recordAudit({
			event,
			action: 'view.saved',
			detail: { page: 'alerts', name }
		});
		return { notice: `Saved view "${name}".` };
	},

	deleteView: async (event) => {
		await requireUser(event);
		const formData = await event.request.formData();
		const vid = formData.get('id')?.toString();
		if (vid) await db.delete(savedView).where(eq(savedView.id, vid));
		return { notice: 'View removed.' };
	}
};
