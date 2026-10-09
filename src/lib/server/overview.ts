/**
 * Server-side overview resolution. Until the CrowdSec connection lands in
 * phase 3 the overview shows labeled fixture data in development (or when
 * DEMO_FIXTURES=true) and an empty state otherwise.
 */
import { dev } from '$app/env';
import { DEMO_FIXTURES } from '$app/env/private';
import { buildBeforeFixture, buildMixedFixture, emptyOverview } from '#lib/overview/fixtures.ts';
import type { OverviewData } from '#lib/overview/types.ts';

export function fixturesEnabled(): boolean {
	return dev || DEMO_FIXTURES === 'true';
}

/**
 * Resolve the overview for a request. `?fixture=before|mixed|none` selects
 * between fixtures; it is honored only while fixtures are enabled, so a
 * production build never serves fabricated data.
 */
export function resolveOverview(fixtureParam: string | null): OverviewData {
	if (!fixturesEnabled()) return emptyOverview();
	switch (fixtureParam) {
		case 'none':
			return emptyOverview();
		case 'mixed':
			return buildMixedFixture();
		default:
			return buildBeforeFixture();
	}
}
