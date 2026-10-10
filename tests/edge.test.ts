/**
 * Edge-sync pure logic + CF client envelope handling (stub fetch) —
 * candidate filtering, capacity trimming, list diffs, rule expressions,
 * name sanitization, error surface (429 retry-after, CF error codes).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { symmetricEncrypt } from 'better-auth/crypto';
import { cfClient, CfError, listNameFor, type CfListItem } from '#lib/server/cloudflare/client.ts';
import {
	applyZoneRule,
	EdgeError,
	setClientFactoryForTests,
	setZoneSelection
} from '#lib/server/cloudflare/accounts.ts';
import { db, migrateDatabase } from '#lib/server/db/index.ts';
import { cloudflareAccount, cloudflareZone } from '#lib/server/db/app.schema.ts';
import { eq } from 'drizzle-orm';
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
	it('narrows further to path prefixes', () => {
		expect(ruleExpression('crowdsec_dash_srv', ['a.example.com'], ['/admin', '/wp-login'])).toBe(
			'(ip.src in $crowdsec_dash_srv and http.host in {"a.example.com"} and ' +
				'(starts_with(http.request.uri.path, "/admin") or starts_with(http.request.uri.path, "/wp-login")))'
		);
	});
	it('paths alone narrow the whole zone', () => {
		expect(ruleExpression('crowdsec_dash_srv', [], ['/admin'])).toBe(
			'(ip.src in $crowdsec_dash_srv and (starts_with(http.request.uri.path, "/admin")))'
		);
	});
	it('edgeRule maps challenge to the managed_challenge CF action', () => {
		const r = edgeRule('crowdsec_dash_srv', [], 'challenge');
		expect(r.ref).toBe(RULE_REF);
		// Stored 'challenge' is the Managed Challenge option — CF's bare
		// 'challenge' action is the legacy interactive one.
		expect(r.action).toBe('managed_challenge');
		expect(r.expression).toContain('$crowdsec_dash_srv');
	});
	it('log action passes through as observe mode', () => {
		const r = edgeRule('crowdsec_dash_srv', [], 'log', ['/private']);
		expect(r.action).toBe('log');
		expect(r.expression).toContain('starts_with');
		expect(r.description).toContain('selected paths');
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

	it('replaceItems PUTs the full item array (not a diff)', async () => {
		let body: unknown;
		const cf = cfClient({
			token: 't',
			baseUrl: 'http://stub',
			fetch: (async (_u: unknown, init?: RequestInit) => {
				body = JSON.parse(init?.body as string);
				return new Response(JSON.stringify({ success: true, result: { operation_id: 'op-1' } }));
			}) as typeof fetch
		});
		const op = await cf.replaceItems('acct', 'list', [
			{ ip: '203.0.113.1' },
			{ ip: '203.0.113.2', comment: 'c' }
		]);
		expect(op.operationId).toBe('op-1');
		expect(body).toEqual([{ ip: '203.0.113.1' }, { ip: '203.0.113.2', comment: 'c' }]);
	});

	it('bulkOperation polls the account-level path without a list id', async () => {
		const cf = cfClient({
			token: 't',
			baseUrl: 'http://stub',
			fetch: (async (url: string | URL | Request) => {
				const u = String(url);
				expect(u).toBe('http://stub/accounts/acct/rules/lists/bulk_operations/op-9');
				return new Response(
					JSON.stringify({ success: true, result: { id: 'op-9', status: 'running' } })
				);
			}) as typeof fetch
		});
		expect((await cf.bulkOperation('acct', 'op-9')).status).toBe('running');
	});

	it('listItems follows result_info.cursors.after across pages', async () => {
		let cursorSeen = '';
		const cf = cfClient({
			token: 't',
			baseUrl: 'http://stub',
			fetch: (async (url: string | URL | Request) => {
				const q = new URL(String(url)).searchParams;
				cursorSeen = q.get('cursor') ?? '';
				expect(q.get('per_page')).toBe('500');
				const page = cursorSeen === '' ? [{ ip: '1.2.3.4' }] : [{ ip: '5.6.7.8' }];
				return new Response(
					JSON.stringify({
						success: true,
						result: page,
						result_info: { cursors: cursorSeen === '' ? { after: 'c2' } : {} }
					})
				);
			}) as typeof fetch
		});
		const items = await cf.listItems('acct', 'list');
		expect(items.map((i) => i.ip)).toEqual(['1.2.3.4', '5.6.7.8']);
		expect(cursorSeen).toBe('c2');
	});

	it('listZones walks page/per_page until total_pages', async () => {
		const pages: number[] = [];
		const cf = cfClient({
			token: 't',
			baseUrl: 'http://stub',
			fetch: (async (url: string | URL | Request) => {
				const q = new URL(String(url)).searchParams;
				const page = Number(q.get('page') ?? 1);
				pages.push(page);
				return new Response(
					JSON.stringify({
						success: true,
						result: [
							{
								id: `z${page}`,
								name: `zone${page}.example.com`,
								status: 'active',
								plan: {},
								account: {}
							}
						],
						result_info: { page, total_pages: 2 }
					})
				);
			}) as typeof fetch
		});
		const zones = await cf.listZones();
		expect(pages).toEqual([1, 2]);
		expect(zones.map((z) => z.name)).toEqual(['zone1.example.com', 'zone2.example.com']);
	});
});

describe('zone rules and plan gating', () => {
	beforeEach(async () => {
		await migrateDatabase();
		await db.delete(cloudflareZone);
		await db.delete(cloudflareAccount);
	});

	async function seedAccountWithZone(plan: string) {
		const accountId = crypto.randomUUID();
		const tokenEnc = await symmetricEncrypt({
			key: process.env.BETTER_AUTH_SECRET!,
			data: JSON.stringify({ token: 't' })
		});
		await db.insert(cloudflareAccount).values({
			id: accountId,
			name: 'acct',
			tokenEnc,
			cfAccountId: 'cf-acct',
			listId: 'list-1',
			listName: 'crowdsec_dash_server',
			listOwned: true,
			tokenStatus: 'active'
		});
		const zoneId = crypto.randomUUID();
		await db.insert(cloudflareZone).values({
			id: zoneId,
			accountId,
			zoneId: 'zone-x',
			name: 'x.example.com',
			plan,
			selected: true,
			hostnames: '[]',
			action: 'block'
		});
		return { accountId, zoneId };
	}

	it('applyZoneRule reuses the existing managed rule id', async () => {
		const { zoneId } = await seedAccountWithZone('Free Website');
		let putBody: { rules?: { id?: string; ref?: string }[] } = {};
		setClientFactoryForTests(
			() =>
				({
					getCustomRules: async () => ({
						id: 'rs-1',
						rules: [
							{ id: 'rule-7', ref: 'crowdsec-dash-edge', expression: 'x', action: 'block' },
							{ id: 'rule-1', ref: 'other', expression: 'y', action: 'block' }
						]
					}),
					putCustomRules: async (_z: string, rules: unknown) => {
						putBody = { rules: rules as { id?: string; ref?: string }[] };
						return { id: 'rs-1', rules };
					}
				}) as never
		);
		try {
			const { ruleId } = await applyZoneRule(zoneId);
			expect(ruleId).toBe('rule-7');
			const mine = putBody.rules!.find((r) => r.ref === 'crowdsec-dash-edge')!;
			expect(mine.id).toBe('rule-7'); // stable identity across updates
			expect(putBody.rules!.find((r) => r.ref === 'other')!.id).toBe('rule-1');
		} finally {
			setClientFactoryForTests(null);
		}
	});

	it('setZoneSelection refuses log on non-Enterprise plans', async () => {
		const { zoneId } = await seedAccountWithZone('Free Website');
		const err = await setZoneSelection(zoneId, { selected: true, action: 'log' }).catch((e) => e);
		expect(err).toBeInstanceOf(EdgeError);
		expect(err.message).toContain('Enterprise');
		const [row] = await db.select().from(cloudflareZone).where(eq(cloudflareZone.id, zoneId));
		expect(row.action).toBe('block'); // selection untouched by the rejected write
	});

	it('setZoneSelection accepts log on Enterprise plans', async () => {
		const { zoneId } = await seedAccountWithZone('Enterprise Website');
		setClientFactoryForTests(
			() =>
				({
					getCustomRules: async () => null,
					putCustomRules: async (_z: string, rules: unknown) => ({
						id: 'rs-1',
						rules: (rules as { ref: string }[]).map((r, i) => ({ id: `r${i}`, ...r }))
					})
				}) as never
		);
		try {
			await setZoneSelection(zoneId, { selected: true, action: 'log' });
			const [row] = await db.select().from(cloudflareZone).where(eq(cloudflareZone.id, zoneId));
			expect(row.action).toBe('log');
		} finally {
			setClientFactoryForTests(null);
		}
	});
});
