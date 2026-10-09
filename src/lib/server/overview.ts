/**
 * Server-side overview resolution. A connected CrowdSec connection yields
 * live data from the projection tables; otherwise the overview shows
 * labeled fixture data in development (or when DEMO_FIXTURES=true) and an
 * empty state otherwise.
 */
import { dev } from '$app/env';
import { DEMO_FIXTURES } from '$app/env/private';
import { buildBeforeFixture, buildMixedFixture, emptyOverview } from '#lib/overview/fixtures.ts';
import type { OverviewData } from '#lib/overview/types.ts';
import { db } from '#lib/server/db/index.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import { liveOverview } from '#lib/server/live-overview.ts';

export function fixturesEnabled(): boolean {
	return dev || DEMO_FIXTURES === 'true';
}

/**
 * Resolve the overview for a request. `?fixture=before|mixed|none` selects
 * between fixtures; it is honored only while fixtures are enabled, so a
 * production build never serves fabricated data. A live connection always
 * wins over fixtures unless a fixture is explicitly selected.
 */
export async function resolveOverview(
	fixtureParam: string | null,
	rangeHours = 24
): Promise<OverviewData> {
	const srv = await getServer(db);
	if (srv && fixturesEnabled() && fixtureParam && fixtureParam !== 'live') {
		return fixture(fixtureParam);
	}
	if (srv) return liveOverview(db, srv, rangeHours);
	return fixture(fixtureParam ?? 'before');
}

function fixture(name: string | null): OverviewData {
	if (!fixturesEnabled()) return emptyOverview();
	switch (name) {
		case 'none':
			return emptyOverview();
		case 'mixed':
			return buildMixedFixture();
		default:
			return buildBeforeFixture();
	}
}
