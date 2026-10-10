import type { PageServerLoad } from './$types';
import { resolveOverview } from '#lib/server/overview.ts';
import { requireUser } from '#lib/server/roles.ts';

const RANGES = ['1h', '6h', '24h'] as const;
export type ActivityRange = (typeof RANGES)[number];

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const params = event.url.searchParams;

	const rangeParam = params.get('range') ?? '24h';
	const range: ActivityRange = (RANGES as readonly string[]).includes(rangeParam)
		? (rangeParam as ActivityRange)
		: '24h';
	const rangeHours = range === '1h' ? 1 : range === '6h' ? 6 : 24;

	const overview = await resolveOverview(params.get('fixture'), rangeHours);

	const site = params.get('site');

	return {
		overview,
		selectedSite: site && overview.sites.some((s) => s.id === site) ? site : null,
		range
	};
};
