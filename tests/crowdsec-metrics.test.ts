import { describe, expect, it } from 'vitest';
import { parsePrometheus, summarizeMetrics, whitelisted } from '#lib/server/crowdsec/metrics.ts';

const SAMPLE = `
# HELP cs_active_decisions Number of active decisions.
# TYPE cs_active_decisions gauge
cs_active_decisions{action="ban",origin="CAPI",scenario=""} 21286
cs_active_decisions{action="ban",origin="crowdsec",scenario="crowdsecurity/ssh-bf"} 2
cs_info{version="v1.7.6"} 1
cs_parser_hits_total{source="/var/log/auth.log"} 900
cs_parser_hits_ok_total{source="/var/log/auth.log"} 870
cs_parser_hits_ko_total{source="/var/log/auth.log"} 30
cs_lapi_requests_total{endpoint="/v1/alerts",method="get"} 44
cs_appsec_processed_requests_total{appsec_engine="default"} 1200
cs_appsec_block_hits_total{appsec_engine="default"} 3
cs_bogus_high_cardinality{ip="1.2.3.4",ua="x"} 7
not a metric line
`;

describe('parsePrometheus', () => {
	it('parses series with and without labels', () => {
		const pts = parsePrometheus(SAMPLE);
		expect(pts.length).toBeGreaterThan(8);
		const capi = pts.find((p) => p.labels.origin === 'CAPI');
		expect(capi?.value).toBe(21286);
		expect(pts.every((p) => Number.isFinite(p.value))).toBe(true);
	});

	it('ignores comments and malformed lines', () => {
		expect(parsePrometheus('# comment\n\n!!bad!!\n')).toEqual([]);
	});

	it('unescapes quoted label values', () => {
		const [p] = parsePrometheus('m{l="a\\"b"} 1');
		expect(p.labels.l).toBe('a"b');
	});
});

describe('whitelisted', () => {
	it('keeps low-cardinality series we know', () => {
		expect(whitelisted({ name: 'cs_active_decisions', labels: { origin: 'CAPI' }, value: 1 })).toBe(
			true
		);
	});
	it('drops unknown names and extra labels', () => {
		expect(whitelisted({ name: 'cs_random', labels: {}, value: 1 })).toBe(false);
		expect(
			whitelisted({ name: 'cs_active_decisions', labels: { origin: 'x', ip: '1.1.1.1' }, value: 1 })
		).toBe(false);
	});
});

describe('summarizeMetrics', () => {
	it('aggregates the exported counters', () => {
		const s = summarizeMetrics(parsePrometheus(SAMPLE));
		expect(s.version).toBe('v1.7.6');
		expect(s.activeDecisionsByOrigin.CAPI).toBe(21286);
		expect(s.activeDecisionsByOrigin.crowdsec).toBe(2);
		expect(s.acquisition[0]).toEqual({
			source: '/var/log/auth.log',
			read: 900,
			parsed: 870,
			failed: 30
		});
		expect(s.appsec).toEqual({ processed: 1200, blocked: 3 });
		expect(s.lapiRequests).toBe(44);
	});
});
