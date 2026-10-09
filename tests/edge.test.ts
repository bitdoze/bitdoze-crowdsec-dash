/**
 * Edge-sync pure logic + CF client envelope handling (stub fetch) —
 * candidate filtering, capacity trimming, list diffs, rule expressions,
 * name sanitization, error surface (429 retry-after, CF error codes).
 */
import { describe, expect, it } from 'vitest';
import { cfClient, CfError, listNameFor, type CfListItem } from '#lib/server/cloudflare/client.ts';
import {
	applyCapacity,
	diffItems,
	edgeCandidates,
	edgeRule,
	ruleExpression,
	RULE_REF,
	type EdgeCandidate
} from '#lib/server/cloudflare/sync.ts';

function dec(over: Partial<EdgeCandidate>): EdgeCandidate {
	return {
		value: '203.0.113.10',
		origin: 'crowdsec',
		scope: 'ip',
		type: 'ban',
		scenario: 'crowdsecurity/ssh-bf',
		until: new Date(Date.now() + 3600_000),
		expired: false,
		...over
	};
}

function stubFetch(handlers: Record<string, (init: RequestInit) => unknown>) {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url)
			.replace(/^https?:\/\/[^/]+/, '')
			.replace(/^\/client\/v4/, '');
		for (const [pattern, fn] of Object.entries(handlers)) {
			const [method, path] = pattern.split(' ');
			if (init?.method !== method && !(method === 'GET' && !init?.method)) continue;
			if (path.endsWith('*') ? u.startsWith(path.slice(0, -1)) : u === path) {
				const result = fn(init ?? {});
				return new Response(JSON.stringify(result), { status: 200 });
			}
		}
		return new Response(
			JSON.stringify({ success: false, errors: [{ code: 404, message: 'nf' }] }),
			{
				status: 404
			}
		);
	}) as typeof fetch;
}

describe('edgeCandidates', () => {
	it('keeps local origins, drops expired/community/non-IP', () => {
		const items = edgeCandidates([
			dec({ value: '203.0.113.1' }),
			dec({ value: '203.0.113.2', origin: 'lists:community_blocklist' }),
			dec({ value: '203.0.113.3', expired: true }),
			dec({ value: '203.0.113.4', until: new Date(Date.now() - 1000) }),
			dec({ value: 'not-an-ip' }),
			dec({ value: '203.0.113.5', origin: 'cscli' }),
			dec({ value: null }),
			dec({ value: '2001:db8::42' })
		]);
		expect(items.map((i) => i.ip).sort()).toEqual(['2001:db8::42', '203.0.113.1', '203.0.113.5']);
	});

	it('dedupes by value keeping the latest expiry', () => {
		const items = edgeCandidates([
			dec({ value: '203.0.113.1', until: new Date(Date.now() + 1000) }),
			dec({ value: '203.0.113.1', until: new Date(Date.now() + 9999_000) })
		]);
		expect(items).toHaveLength(1);
		expect(items[0].untilMs).toBeGreaterThan(Date.now() + 9000_000);
	});
});

describe('applyCapacity', () => {
	it('keeps everything under capacity', () => {
		const items = edgeCandidates([dec({}), dec({ value: '203.0.113.2' })]);
		expect(applyCapacity(items, 10).dropped).toBe(0);
	});

	it('drops the soonest-expiring when over capacity', () => {
		const items = edgeCandidates([
			dec({ value: '203.0.113.1', until: new Date(Date.now() + 1000) }),
			dec({ value: '203.0.113.2', until: new Date(Date.now() + 9999_000) }),
			dec({ value: '203.0.113.3', until: null })
		]);
		const { kept, dropped } = applyCapacity(items, 2);
		expect(dropped).toBe(1);
		expect(kept.map((i) => i.ip).sort()).toEqual(['203.0.113.2', '203.0.113.3']);
	});
});

describe('diffItems', () => {
	const current: CfListItem[] = [
		{ ip: '203.0.113.1' },
		{ ip: '203.0.113.9' } // stale — a decision that ended
	];
	it('adds missing, removes stale, ignores unchanged', () => {
		const wanted = edgeCandidates([dec({ value: '203.0.113.1' }), dec({ value: '203.0.113.2' })]);
		const diff = diffItems(current, wanted);
		expect(diff.add.map((i) => i.ip)).toEqual(['203.0.113.2']);
		expect(diff.remove).toEqual([{ ip: '203.0.113.9' }]);
	});
	it('empty diff means the list is in sync', () => {
		const wanted = edgeCandidates([dec({ value: '203.0.113.1' }), dec({ value: '203.0.113.9' })]);
		const diff = diffItems(current, wanted);
		expect(diff.add).toHaveLength(0);
		expect(diff.remove).toHaveLength(0);
	});
});

describe('ruleExpression / edgeRule', () => {
	it('whole zone when no hostnames', () => {
		expect(ruleExpression('crowdsec_dash_srv', [])).toBe('(ip.src in $crowdsec_dash_srv)');
	});
	it('narrows to selected hostnames', () => {
		expect(ruleExpression('crowdsec_dash_srv', ['a.example.com', 'b.example.com'])).toBe(
			'(ip.src in $crowdsec_dash_srv and http.host in {"a.example.com" "b.example.com"})'
		);
	});
	it('edgeRule carries the managed ref and chosen action', () => {
		const r = edgeRule('crowdsec_dash_srv', [], 'challenge');
		expect(r.ref).toBe(RULE_REF);
		expect(r.action).toBe('challenge');
		expect(r.expression).toContain('$crowdsec_dash_srv');
	});
});

describe('listNameFor', () => {
	it('sanitizes to the allowed charset and 50-char cap', () => {
		expect(listNameFor('My Server!')).toBe('crowdsec_dash_my_server');
		expect(listNameFor('x'.repeat(80))).toHaveLength(50);
		expect(listNameFor('---')).toBe('crowdsec_dash_server');
	});
});

describe('cfClient', () => {
	it('verifyToken extracts permission groups', async () => {
		const cf = cfClient({
			token: 't',
			fetch: stubFetch({
				'GET /user/tokens/verify': () => ({
					success: true,
					result: {
						id: 'tok1',
						status: 'active',
						policies: [
							{ permission_groups: [{ name: 'Zone WAF Edit' }, { name: 'Zone Read' }] },
							{ permission_groups: [{ name: 'Account Filter Lists Edit' }] }
						]
					}
				})
			})
		});
		const v = await cf.verifyToken();
		expect(v.status).toBe('active');
		expect(v.permissionGroups).toEqual(
			expect.arrayContaining(['Zone WAF Edit', 'Zone Read', 'Account Filter Lists Edit'])
		);
	});

	it('surfaces CF error code/message', async () => {
		const cf = cfClient({
			token: 't',
			fetch: (async () =>
				new Response(
					JSON.stringify({
						success: false,
						errors: [{ code: 9109, message: 'Invalid access token' }]
					}),
					{ status: 403 }
				)) as typeof fetch
		});
		const err = await cf.verifyToken().catch((e) => e);
		expect(err).toBeInstanceOf(CfError);
		expect(err.code).toBe(9109);
		expect(err.message).toBe('Invalid access token');
	});

	it('bulkUpdate returns the operation id; listItems cursors', async () => {
		let cursorSeen = '';
		const cf = cfClient({
			token: 't',
			baseUrl: 'http://stub',
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				const u = String(url);
				if (u.includes('/items') && init?.method === 'PUT') {
					return new Response(JSON.stringify({ success: true, result: { operation_id: 'op-1' } }));
				}
				if (u.includes('/items')) {
					const q = new URL(u).searchParams;
					cursorSeen = q.get('cursor') ?? '';
					return new Response(
						JSON.stringify({
							success: true,
							result: cursorSeen ? [] : [{ ip: '1.2.3.4' }],
							result_info: { cursor: cursorSeen ? '' : 'c2' }
						})
					);
				}
				return new Response(
					JSON.stringify({ success: false, errors: [{ code: 0, message: 'x' }] })
				);
			}) as typeof fetch
		});
		const op = await cf.bulkUpdate('acct', 'list', { add: [], remove: [] });
		expect(op.operationId).toBe('op-1');
		const items = await cf.listItems('acct', 'list');
		expect(items).toHaveLength(1);
		expect(cursorSeen).toBe('c2');
	});
});
