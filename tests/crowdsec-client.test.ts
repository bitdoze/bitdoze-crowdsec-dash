import { describe, expect, it, vi } from 'vitest';
import { LapiClient, LapiError } from '#lib/server/crowdsec/client.ts';

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init! });
		return handler(String(url), init!);
	});
	return { f: f as unknown as typeof fetch, calls };
}

const login = () =>
	new Response(JSON.stringify({ token: 'jwt-token', expire: '2999-01-01T00:00:00Z' }), {
		status: 200
	});

const client = (f: typeof fetch) =>
	new LapiClient({
		baseUrl: 'http://lapi.test/',
		machineId: 'dash',
		password: 'pw',
		fetchImpl: f,
		retries: 0
	});

describe('LapiClient', () => {
	it('posts machine credentials to watchers/login and caches the JWT', async () => {
		const { f, calls } = mockFetch((url) =>
			url.includes('watchers/login') ? login() : new Response('[]', { status: 200 })
		);
		const c = client(f);
		await c.alerts();
		await c.alerts();
		expect(calls.filter((x) => x.url.includes('watchers/login'))).toHaveLength(1);
		const loginCall = calls[0];
		expect(JSON.parse(loginCall.init.body as string)).toEqual({
			machine_id: 'dash',
			password: 'pw'
		});
		expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(
			'Bearer jwt-token'
		);
	});

	it('returns [] when LAPI answers null for an empty window', async () => {
		const { f } = mockFetch((url) =>
			url.includes('watchers/login') ? login() : new Response('null', { status: 200 })
		);
		expect(await client(f).alerts()).toEqual([]);
	});

	it('passes since/limit filters as query params', async () => {
		const { f, calls } = mockFetch((url) =>
			url.includes('watchers/login') ? login() : new Response('[]', { status: 200 })
		);
		await client(f).alerts({ since: '2026-01-01T00:00:00Z', limit: 500 });
		const url = calls.at(-1)!.url;
		expect(url).toContain('since=2026-01-01');
		expect(url).toContain('limit=500');
	});

	it('refreshes the token once after a 401', async () => {
		let auths = 0;
		const { f, calls } = mockFetch((url, init) => {
			if (url.includes('watchers/login')) return login();
			const auth = (init.headers as Record<string, string>).Authorization;
			if (auths++ === 0 && auth === 'Bearer jwt-token') return new Response('{}', { status: 401 });
			return new Response('[]', { status: 200 });
		});
		expect(await client(f).alerts()).toEqual([]);
		expect(calls.filter((x) => x.url.includes('watchers/login'))).toHaveLength(2);
	});

	it('maps bad credentials to an auth error', async () => {
		const { f } = mockFetch(() => new Response('{}', { status: 403 }));
		const c = new LapiClient({
			baseUrl: 'http://lapi.test',
			machineId: 'dash',
			password: 'bad',
			fetchImpl: f,
			retries: 0
		});
		await expect(c.login()).rejects.toMatchObject({ kind: 'auth' } satisfies Partial<LapiError>);
	});

	it('retries 5xx with backoff then succeeds', async () => {
		let n = 0;
		const { f } = mockFetch((url) => {
			if (url.includes('watchers/login')) return login();
			return ++n < 3 ? new Response('{}', { status: 503 }) : new Response('[]', { status: 200 });
		});
		const c = new LapiClient({
			baseUrl: 'http://lapi.test',
			machineId: 'dash',
			password: 'pw',
			fetchImpl: f,
			retries: 3
		});
		expect(await c.alerts()).toEqual([]);
		expect(n).toBe(3);
	});

	it('maps connection failures to unreachable', async () => {
		const { f } = mockFetch((url) => {
			if (url.includes('watchers/login')) return login();
			throw Object.assign(new Error('connect fail'), { cause: { code: 'ECONNREFUSED' } });
		});
		await expect(client(f).alerts()).rejects.toMatchObject({
			kind: 'unreachable'
		} satisfies Partial<LapiError>);
	});

	it('rejects non-array alerts payloads', async () => {
		const { f } = mockFetch((url) =>
			url.includes('watchers/login') ? login() : new Response('{"oops":1}', { status: 200 })
		);
		await expect(client(f).alerts()).rejects.toMatchObject({
			kind: 'bad_response'
		} satisfies Partial<LapiError>);
	});
});
