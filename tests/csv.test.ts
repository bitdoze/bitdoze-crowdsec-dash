import { describe, expect, it } from 'vitest';
import { csvResponse, toCsv } from '#lib/server/csv.ts';

describe('toCsv', () => {
	it('renders headers and plain rows', () => {
		const out = toCsv(['a', 'b'], [[1, 'x']]);
		expect(out).toBe('a,b\n1,x\n');
	});

	it('quotes commas, quotes and newlines; escapes embedded quotes', () => {
		const out = toCsv(['v'], [['say "hi", ok'], ['multi\nline'], [null]]);
		expect(out).toBe('v\n"say ""hi"", ok"\n"multi\nline"\n\n');
	});

	it('serializes dates as ISO', () => {
		const d = new Date('2024-06-01T00:00:00Z');
		expect(toCsv(['t'], [[d]])).toBe(`t\n${d.toISOString()}\n`);
	});

	it('neutralizes spreadsheet formula injection', () => {
		const out = toCsv(
			['v'],
			[['=1+1'], ['+SUM(A1)'], ['-2|cmd'], ['@NOW()'], [' =1'], ['\t=1'], ['safe']]
		);
		const cells = out.split('\n').slice(1, -1);
		for (const c of cells.slice(0, -1)) expect(c.startsWith("'")).toBe(true);
		expect(cells.at(-1)).toBe('safe');
	});
});

describe('csvResponse', () => {
	it('sets csv content type and attachment disposition', () => {
		const r = csvResponse('alerts.csv', 'a\n');
		expect(r.headers.get('content-type')).toContain('text/csv');
		expect(r.headers.get('content-disposition')).toBe('attachment; filename="alerts.csv"');
	});
});
