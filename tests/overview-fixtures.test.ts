import { describe, expect, it } from 'vitest';
import { buildBeforeFixture, buildMixedFixture, emptyOverview } from '#lib/overview/fixtures.ts';
import {
	OBSERVATION_ORDER,
	TESTS,
	type CheckState,
	type ObservationCode,
	type OverviewData
} from '#lib/overview/types.ts';

const STATES: CheckState[] = ['verified', 'degraded', 'failed', 'stale', 'not_configured'];
const NOW = new Date('2026-10-09T14:00:00Z');

function checkInvariants(data: OverviewData) {
	// Every site carries exactly the six tests, in a valid state.
	for (const site of data.sites) {
		expect(Object.keys(site.checks).sort(), site.hostname).toEqual(TESTS.map((t) => t.id).sort());
		for (const test of TESTS) {
			const result = site.checks[test.id];
			expect(STATES, `${site.hostname}/${test.id}`).toContain(result.state);
		}
	}

	// Observations follow the inspection-report order C1, C2, FI, C3.
	const rank = (code: ObservationCode) => OBSERVATION_ORDER.indexOf(code);
	const order = data.observations.map((o) => rank(o.code));
	expect(order).toEqual([...order].sort((a, b) => a - b));

	// Every observation and failed/degraded/stale check names a next step or fix.
	for (const obs of data.observations) {
		expect(obs.fix.steps.length, obs.title).toBeGreaterThan(0);
		expect(obs.fix.title.length).toBeGreaterThan(0);
	}
	for (const site of data.sites) {
		for (const test of TESTS) {
			const r = site.checks[test.id];
			if (r.state === 'failed' || r.state === 'degraded' || r.state === 'stale') {
				expect(
					r.nextStep ?? r.fix,
					`${site.hostname}/${test.id} needs a next step or fix`
				).toBeTruthy();
			}
		}
	}

	// An unmeasured metric must say why — it is never silently 0.
	for (const m of data.measurements) {
		if (m.value === null) expect(m.unavailableReason, m.label).toBeTruthy();
	}
}

describe('fixture: before', () => {
	const data = buildBeforeFixture(NOW);

	it('satisfies the shared invariants', () => checkInvariants(data));

	it('mirrors the reference host (spec Appendix B)', () => {
		expect(data.server.name).toBe('reference-host');
		expect(data.server.crowdsecVersion).toBe('1.7.6');
		expect(data.sites).toHaveLength(3);
		expect(data.verdict?.state).toBe('failed');
		expect(data.verdict?.label).toMatch(/not protected/i);

		// 21,286 community-blocklist decisions; none local.
		const active = data.measurements.find((m) => m.label === 'Active decisions');
		expect(active?.value).toBe(21286);

		// No site has bouncer, WAF, or edge configured; client IP is stale.
		for (const site of data.sites) {
			expect(site.checks.bouncer.state).toBe('not_configured');
			expect(site.checks.waf.state).toBe('not_configured');
			expect(site.checks.edge.state).toBe('not_configured');
			expect(site.checks.client_ip.state).toBe('stale');
		}

		// WAF blocks are unmeasured, never reported as 0.
		const waf = data.measurements.find((m) => m.label.startsWith('WAF blocks'));
		expect(waf?.value).toBeNull();
		expect(waf?.unavailableReason).toMatch(/appsec/i);

		// Two C1 observations: enforcement gap and no detection.
		const c1 = data.observations.filter((o) => o.code === 'C1');
		expect(c1.length).toBeGreaterThanOrEqual(2);
	});
});

describe('fixture: mixed', () => {
	const data = buildMixedFixture(NOW);

	it('satisfies the shared invariants', () => checkInvariants(data));

	it('exercises every check state', () => {
		const seen = new Set<CheckState>();
		for (const site of data.sites) {
			for (const test of TESTS) seen.add(site.checks[test.id].state);
		}
		for (const state of STATES) expect(seen).toContain(state);
	});

	it('measures WAF blocks when AppSec runs somewhere', () => {
		const waf = data.measurements.find((m) => m.label.startsWith('WAF blocks'));
		expect(waf?.value).toBeGreaterThan(0);
	});
});

describe('empty overview', () => {
	it('has no fabricated data', () => {
		const data = emptyOverview();
		expect(data.source).toBe('none');
		expect(data.sites).toHaveLength(0);
		expect(data.measurements).toHaveLength(0);
		expect(data.inspectedAt).toBeNull();
	});
});
