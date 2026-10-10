import { describe, expect, it } from 'vitest';
import { filterAlerts, parseGoDuration, validateAddAlerts } from '../e2e/lapi-contract.mjs';

const h = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

const mkAlert = (over: Record<string, unknown> = {}) => ({
	id: 1,
	scenario: 'crowdsecurity/http-probing',
	started_at: h(1),
	created_at: h(1),
	source: { scope: 'Ip', value: '203.0.113.7', ip: '203.0.113.7' },
	decisions: [
		{
			id: 10,
			origin: 'crowdsec',
			type: 'ban',
			scope: 'Ip',
			value: '203.0.113.7',
			until: new Date(Date.now() + 3_600_000).toISOString()
		}
	],
	...over
});

const q = (s: string) => new URLSearchParams(s);

describe('parseGoDuration', () => {
	it('parses single and compound units', () => {
		expect(parseGoDuration('90s')).toBe(90);
		expect(parseGoDuration('4h')).toBe(14_400);
		expect(parseGoDuration('30d')).toBe(2_592_000);
		expect(parseGoDuration('1h30m')).toBe(5_400);
		expect(parseGoDuration('0s')).toBe(0);
	});

	it('rejects timestamps and junk like upstream does', () => {
		for (const bad of ['2026-01-01T00:00:00Z', 'tomorrow', '', '4', '4x', 'abc']) {
			expect(() => parseGoDuration(bad), bad).toThrow(/while parsing duration/);
		}
	});
});

describe('filterAlerts', () => {
	const list = [
		mkAlert({ id: 3, created_at: h(1), started_at: h(1) }),
		mkAlert({ id: 2, created_at: h(2), started_at: h(2) })
	];

	it('rejects an RFC3339 since with a 500-style error', () => {
		const r = filterAlerts(list, q('since=2026-01-01T00%3A00%3A00Z'));
		expect(r.error?.status).toBe(500);
		expect(r.error?.message).toContain('while parsing duration');
	});

	it('rejects unknown filter parameters', () => {
		const r = filterAlerts(list, q('bogus=1'));
		expect(r.error?.status).toBe(500);
		expect(r.error?.message).toContain("filter parameter 'bogus' is unknown");
	});

	it('orders by created_at DESC with a default limit of 100', () => {
		const r = filterAlerts(list, q(''));
		expect(r.alerts?.map((a: { id: number }) => a.id)).toEqual([3, 2]);
		const asc = filterAlerts(list, q('sort=ASC'));
		expect(asc.alerts?.map((a: { id: number }) => a.id)).toEqual([2, 3]);
	});

	it('since/until/created_before bound against now by duration', () => {
		expect(filterAlerts(list, q('since=30d')).alerts).toHaveLength(2);
		expect(filterAlerts(list, q('since=30m')).alerts).toHaveLength(0);
		expect(filterAlerts(list, q('until=90m')).alerts).toHaveLength(1); // only the 2h-old one
		expect(filterAlerts(list, q('created_before=90m')).alerts).toHaveLength(1);
		expect(filterAlerts(list, q('created_before=0s')).alerts).toHaveLength(2);
	});

	it('include_capi=false drops alerts with central decisions', () => {
		const capi = mkAlert({
			id: 4,
			created_at: h(3),
			decisions: [{ id: 11, origin: 'CAPI', type: 'ban' }]
		});
		const r = filterAlerts([...list, capi], q('include_capi=false'));
		expect(r.alerts).toHaveLength(2);
		expect(filterAlerts([...list, capi], q('')).alerts).toHaveLength(3);
	});

	it('has_active_decision=true keeps only decisions with until >= now', () => {
		const stale = mkAlert({
			id: 5,
			created_at: h(4),
			decisions: [{ id: 12, origin: 'crowdsec', type: 'ban', until: '2000-01-01T00:00:00Z' }]
		});
		const r = filterAlerts([...list, stale], q('has_active_decision=true'));
		expect(r.alerts).toHaveLength(2);
	});

	it('honors limit and ip filters', () => {
		const r = filterAlerts(list, q('limit=1'));
		expect(r.alerts).toHaveLength(1);
		expect(filterAlerts(list, q('ip=203.0.113.7')).alerts).toHaveLength(2);
		expect(filterAlerts(list, q('ip=9.9.9.9')).alerts).toHaveLength(0);
	});
});

describe('validateAddAlerts', () => {
	const valid = {
		capacity: 0,
		leakspeed: '0',
		events: [],
		events_count: 1,
		message: 'reason',
		scenario: 'reason',
		scenario_hash: '',
		scenario_version: '',
		simulated: false,
		source: { scope: 'Ip', value: '9.9.9.9', ip: '9.9.9.9' },
		start_at: '2026-01-01T00:00:00Z',
		stop_at: '2026-01-01T00:00:00Z',
		decisions: [
			{
				type: 'ban',
				scope: 'Ip',
				value: '9.9.9.9',
				duration: '4h',
				origin: 'cscli',
				scenario: 'reason'
			}
		]
	};

	it('accepts a cscli-shaped alert', () => {
		expect(validateAddAlerts([valid])).toBeNull();
	});

	it('rejects non-array bodies', () => {
		expect(validateAddAlerts({})?.status).toBe(400);
	});

	it('missing required fields fail validation with 500', () => {
		for (const f of ['capacity', 'scenario_hash', 'scenario_version', 'events_count', 'source']) {
			const bad = { ...valid };
			delete bad[f as keyof typeof bad];
			expect(validateAddAlerts([bad])?.status, f).toBe(500);
		}
	});

	it('decisions need their own required fields', () => {
		const bad = { ...valid, decisions: [{ type: 'ban' }] };
		expect(validateAddAlerts([bad])?.status).toBe(500);
	});

	it('object labels fail the JSON bind (400), string labels pass', () => {
		const bad = { ...valid, labels: [{ key: 'k', value: 'v' }] };
		expect(validateAddAlerts([bad])?.status).toBe(400);
		const good = { ...valid, labels: ['k', 'v'] };
		expect(validateAddAlerts([good])).toBeNull();
	});
});
