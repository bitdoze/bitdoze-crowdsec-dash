import { describe, expect, it } from 'vitest';
import { feedQueryFor, REMOVABLE_ORIGINS } from '#lib/server/crowdsec/feed.ts';

describe('feedQueryFor', () => {
	it('maps an IP to ip+contains (covers enclosing ranges upstream)', () => {
		expect(feedQueryFor('203.0.113.7')).toEqual({ ip: '203.0.113.7', contains: true });
		expect(feedQueryFor('  2001:db8::1 ')).toEqual({ ip: '2001:db8::1', contains: true });
	});

	it('maps a CIDR to range', () => {
		expect(feedQueryFor('10.0.0.0/8')).toEqual({ range: '10.0.0.0/8' });
		expect(feedQueryFor('2001:db8::/32')).toEqual({ range: '2001:db8::/32' });
	});

	it('maps scenario-ish text to the scenario filter', () => {
		expect(feedQueryFor('ssh:bruteforce')).toEqual({ scenario: 'ssh:bruteforce' });
		expect(feedQueryFor('crowdsecurity/http-probing')).toEqual({
			scenario: 'crowdsecurity/http-probing'
		});
	});

	it('maps anything else to an exact value; empty → no filter', () => {
		expect(feedQueryFor('CN')).toEqual({ value: 'CN' });
		expect(feedQueryFor('AS1234')).toEqual({ value: 'AS1234' });
		expect(feedQueryFor('')).toEqual({});
		expect(feedQueryFor('   ')).toEqual({});
	});
});

describe('REMOVABLE_ORIGINS', () => {
	it('covers local origins and excludes central ones', () => {
		for (const o of ['crowdsec', 'cscli', 'console', 'cscli-import'])
			expect(REMOVABLE_ORIGINS.has(o), o).toBe(true);
		for (const o of ['CAPI', 'lists:blocklist', 'lists'])
			expect(REMOVABLE_ORIGINS.has(o), o).toBe(false);
	});
});
