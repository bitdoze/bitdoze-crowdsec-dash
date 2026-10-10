/**
 * Topology detection without privileges (spec phase 5): fetch the site's
 * public response headers and infer the fronting proxy + Cloudflare. The
 * administrator can always override the guess — detection stores its
 * evidence so the answer is auditable, not authoritative.
 */
import type { ProxyKind } from '#lib/server/protect/templates.ts';
import { assertResolvesSafely } from '#lib/server/net-guard.ts';

export type Detection = {
	probedUrl: string;
	at: string;
	/** Header names/values that drove the guess (values truncated). */
	headers: Record<string, string>;
	proxy: ProxyKind;
	cloudflare: boolean;
	error?: string;
};

const PROBE_HEADERS = [
	'server',
	'via',
	'cf-ray',
	'cf-cache-status',
	'cf-request-id',
	'x-traefik-request-id',
	'x-kong-upstream-latency',
	'x-served-by',
	'x-powered-by'
] as const;

function guessProxy(h: Map<string, string>): ProxyKind {
	const server = (h.get('server') ?? '').toLowerCase();
	if (server.includes('caddy')) return 'caddy';
	if (server.includes('nginx')) return 'nginx';
	if (server.includes('openresty')) return 'nginx';
	if (server.includes('cloudflare')) {
		// Cloudflare masks the origin's Server header — proxy unknown.
		return 'unknown';
	}
	if (h.has('x-traefik-request-id')) return 'traefik';
	if (server.includes('traefik')) return 'traefik';
	if (server) return 'other';
	return 'unknown';
}

function guessCloudflare(h: Map<string, string>): boolean {
	return h.has('cf-ray') || h.has('cf-cache-status') || h.has('cf-request-id');
}

/**
 * Probe a URL's response headers. `url` defaults to https://hostname; an
 * explicit URL lets the admin probe intranet/plain-HTTP front ends. No
 * redirects are followed (a redirect chain could lead anywhere), the body is
 * discarded, and the request times out quickly.
 */
export async function probeSite(hostname: string, url?: string): Promise<Detection> {
	const target = url ?? `https://${hostname}`;
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return {
			probedUrl: target,
			at: new Date().toISOString(),
			headers: {},
			proxy: 'unknown',
			cloudflare: false,
			error: 'Not a valid URL.'
		};
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		return {
			probedUrl: target,
			at: new Date().toISOString(),
			headers: {},
			proxy: 'unknown',
			cloudflare: false,
			error: 'Only http(s) URLs can be probed.'
		};
	}
	try {
		// Operators legitimately probe local proxies, so only link-local and
		// unspecified destinations are refused — never the cloud metadata
		// address via DNS rebinding.
		await assertResolvesSafely(parsed.hostname, 'probe');
	} catch (e) {
		return {
			probedUrl: target,
			at: new Date().toISOString(),
			headers: {},
			proxy: 'unknown',
			cloudflare: false,
			error: e instanceof Error ? e.message.slice(0, 200) : 'Destination not allowed.'
		};
	}
	try {
		const res = await fetch(parsed, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(8000),
			headers: { 'user-agent': 'bitdoze-crowdsec-dash topology probe' }
		});
		const headers: Record<string, string> = {};
		const map = new Map<string, string>();
		for (const name of PROBE_HEADERS) {
			const v = res.headers.get(name);
			if (v) {
				headers[name] = v.slice(0, 120);
				map.set(name, v);
			}
		}
		return {
			probedUrl: target,
			at: new Date().toISOString(),
			headers,
			proxy: guessProxy(map),
			cloudflare: guessCloudflare(map)
		};
	} catch (e) {
		// Common when the site only speaks plain HTTP or is unreachable from
		// this container — try http once as a fallback for the default probe.
		if (!url && parsed.protocol === 'https:') {
			return probeSite(hostname, `http://${hostname}`);
		}
		return {
			probedUrl: target,
			at: new Date().toISOString(),
			headers: {},
			proxy: 'unknown',
			cloudflare: false,
			error: e instanceof Error ? e.message.slice(0, 200) : 'probe failed'
		};
	}
}
