import type { PageServerLoad } from './$types';
import { resolveOverview } from '#lib/server/overview.ts';

const RANGES = ['1h', '6h', '24h'] as const;
export type ActivityRange = (typeof RANGES)[number];

export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const overview = resolveOverview(params.get('fixture'));

	const site = params.get('site');
	const rangeParam = params.get('range') ?? '24h';
	const range: ActivityRange = (RANGES as readonly string[]).includes(rangeParam)
		? (rangeParam as ActivityRange)
		: '24h';

	return {
		overview,
		selectedSite: site && overview.sites.some((s) => s.id === site) ? site : null,
		range
	};
};
