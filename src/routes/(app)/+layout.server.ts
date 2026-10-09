import { redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { user } from '#lib/server/db/auth.schema.ts';
import { sanitizeRedirectTo } from '#lib/server/redirects.ts';
import { fixturesEnabled, resolveOverview } from '#lib/server/overview.ts';
import { site } from '#lib/server/db/app.schema.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import type { OverviewData } from '#lib/overview/types.ts';

export const load: LayoutServerLoad = async (event) => {
	const [{ value: users }] = await db.select({ value: count() }).from(user);
	if (users === 0) redirect(302, '/setup');

	if (!event.locals.user) {
		const target = sanitizeRedirectTo(event.url.pathname + event.url.search);
		redirect(302, `/login?redirectTo=${encodeURIComponent(target)}`);
	}

	// Shell needs the site filter + source chip; mirrors the overview page's
	// fixture/live precedence so `?fixture=` keeps working when connected.
	const srv = await getServer(db);
	const fixtureParam = event.url.searchParams.get('fixture');
	let shell: { source: OverviewData['source']; sites: { id: string; hostname: string }[] };
	if (srv && !(fixturesEnabled() && fixtureParam && fixtureParam !== 'live')) {
		const rows = await db
			.select({ id: site.id, hostname: site.hostname })
			.from(site)
			.orderBy(site.hostname);
		shell = { source: 'live', sites: rows };
	} else {
		const overview = await resolveOverview(fixtureParam);
		shell = {
			source: overview.source,
			sites: overview.sites.map((s) => ({ id: s.id, hostname: s.hostname }))
		};
	}

	return { user: event.locals.user, shell };
};
