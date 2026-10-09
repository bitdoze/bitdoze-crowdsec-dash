import { describe, expect, it } from 'vitest';
import {
	attributeAlert,
	mergedEventMeta,
	normalize,
	type DatasourceMap
} from '#lib/server/crowdsec/attribution.ts';
import type { LapiAlert } from '#lib/server/crowdsec/types.ts';

const base: LapiAlert = { id: 1 };
const empty: DatasourceMap = { pathPrefix: [] };

describe('attributeAlert', () => {
	it('uses context target_fqdn with the context signal', () => {
		const a: LapiAlert = {
			...base,
			context: [{ key: 'target_fqdn', value: 'Blog.Example.com' }]
		};
		const hits = attributeAlert(a, empty);
		expect(hits).toEqual([{ hostname: 'blog.example.com', signal: 'context' }]);
	});

	it('falls back to event meta when context has no fqdn', () => {
		const a: LapiAlert = {
			...base,
			events: [
				{ meta: [{ key: 'target_fqdn', value: 'shop.example.com' }] },
				{ meta: [{ key: 'foo', value: 'bar' }] }
			]
		};
		expect(attributeAlert(a, empty)).toEqual([
			{ hostname: 'shop.example.com', signal: 'event_meta' }
		]);
	});

	it('collects distinct hostnames across signals', () => {
		const a: LapiAlert = {
			...base,
			context: [{ key: 'target_fqdn', value: 'a.example.com' }],
			events: [{ meta: [{ key: 'target_fqdn', value: 'b.example.com' }] }]
		};
		expect(attributeAlert(a, empty)).toHaveLength(2);
	});

	it('uses the datasource prefix map only when no fqdn signal exists', () => {
		const map: DatasourceMap = {
			pathPrefix: [['/var/log/caddy/blog.', 'blog.example.com']]
		};
		const withDs: LapiAlert = {
			...base,
			events: [{ meta: [{ key: 'datasource_path', value: '/var/log/caddy/blog.log' }] }]
		};
		expect(attributeAlert(withDs, map)).toEqual([
			{ hostname: 'blog.example.com', signal: 'datasource' }
		]);
		const withFqdn: LapiAlert = {
			...withDs,
			context: [{ key: 'target_fqdn', value: 'x.example.com' }]
		};
		expect(attributeAlert(withFqdn, map).every((h) => h.signal !== 'datasource')).toBe(true);
	});

	it('returns [] for unattributable alerts', () => {
		expect(attributeAlert({ ...base, scenario: 'crowdsecurity/ssh-bf' }, empty)).toEqual([]);
	});
});

describe('mergedEventMeta / normalize', () => {
	it('first value wins per key across events', () => {
		const meta = mergedEventMeta({
			...base,
			events: [{ meta: [{ key: 'k', value: 'first' }] }, { meta: [{ key: 'k', value: 'second' }] }]
		});
		expect(meta).toEqual([{ key: 'k', value: 'first' }]);
	});
	it('normalizes case and trailing dot', () => {
		expect(normalize('  WWW.Example.COM. ')).toBe('www.example.com');
	});
});
