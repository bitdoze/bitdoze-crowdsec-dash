/**
 * Anonymous-page-load regression: SvelteKit runs page server loads in
 * parallel with the (app) layout's redirect, so a load without an explicit
 * requireUser would still execute agent calls and DB writes for anonymous
 * requests. Every (app) page load must throw a login redirect FIRST.
 */
import { describe, expect, it, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

// Any agent reach-out from an anonymous load is the bug we're guarding.
vi.mock('#lib/server/agent/client.ts', () => ({
	agentHello: vi.fn(() => {
		throw new Error('agentHello called for anonymous request');
	}),
	callAgent: vi.fn(() => {
		throw new Error('callAgent called for anonymous request');
	})
}));

import { load as overviewLoad } from '../src/routes/(app)/+page.server.ts';
import { load as alertsLoad } from '../src/routes/(app)/alerts/+page.server.ts';
import { load as decisionsLoad } from '../src/routes/(app)/decisions/+page.server.ts';
import { load as edgeLoad } from '../src/routes/(app)/edge/+page.server.ts';
import { load as ipLoad } from '../src/routes/(app)/ip/[ip]/+page.server.ts';
import { load as protectionLoad } from '../src/routes/(app)/protection/+page.server.ts';
import { load as sitesLoad } from '../src/routes/(app)/sites/+page.server.ts';
import { load as siteLoad } from '../src/routes/(app)/sites/[id]/+page.server.ts';
import { load as systemLoad } from '../src/routes/(app)/system/+page.server.ts';

const anon = (path: string, params: Record<string, string> = {}) =>
	({
		locals: {},
		url: new URL(`http://dash.test${path}`),
		params
	}) as never;

const CASES: [string, () => Promise<unknown> | unknown][] = [
	['/', () => overviewLoad(anon('/'))],
	['/alerts', () => alertsLoad(anon('/alerts'))],
	['/decisions', () => decisionsLoad(anon('/decisions'))],
	['/edge', () => edgeLoad(anon('/edge'))],
	['/ip/x', () => ipLoad(anon('/ip/203.0.113.7', { ip: '203.0.113.7' }))],
	['/protection', () => protectionLoad(anon('/protection'))],
	['/sites', () => sitesLoad(anon('/sites'))],
	['/sites/x', () => siteLoad(anon('/sites/abc', { id: 'abc' }))],
	['/system', () => systemLoad(anon('/system'))]
];

describe('(app) page loads require a user before doing any work', () => {
	it.each(CASES)('%s redirects anonymous requests to /login', async (_path, call) => {
		const err = await Promise.resolve()
			.then(call)
			.then(
				() => null,
				(e) => e
			);
		expect(err, 'expected a thrown SvelteKit redirect').toBeTruthy();
		expect(isRedirect(err)).toBe(true);
		expect((err as { location: string }).location).toContain('/login');
	});
});
