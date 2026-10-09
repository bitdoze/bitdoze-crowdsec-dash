import { describe, expect, it } from 'vitest';
import {
	parseOrigin,
	pinOriginHeaders,
	resolveClientIp,
	trustedProxyMatcher
} from '../server/origin.js';

describe('parseOrigin', () => {
	it('accepts http and https origins', () => {
		expect(parseOrigin('http://localhost:3999').origin).toBe('http://localhost:3999');
		expect(parseOrigin('https://dash.example.com').origin).toBe('https://dash.example.com');
	});

	it('rejects invalid or non-http origins', () => {
		for (const value of [
			'not-a-url',
			'',
			'ftp://example.com',
			'localhost:3999',
			'http://example.com/some/path',
			'http://example.com?x=1',
			'http://example.com#frag',
			'http://user:pass@example.com'
		]) {
			expect(() => parseOrigin(value), value).toThrow();
		}
	});
});

describe('pinOriginHeaders', () => {
	it('overwrites spoofed forwarding headers', () => {
		const req = {
			headers: {
				'x-forwarded-proto': 'https',
				'x-forwarded-host': 'evil.example',
				host: 'internal:3000'
			}
		};
		pinOriginHeaders(req as never, parseOrigin('http://localhost:3999'));
		expect(req.headers['x-forwarded-proto']).toBe('http');
		expect(req.headers['x-forwarded-host']).toBe('localhost:3999');
	});

	it('sets headers when absent', () => {
		const req = { headers: { host: 'internal:3000' } as Record<string, string> };
		pinOriginHeaders(req as never, parseOrigin('https://dash.example.com'));
		expect(req.headers['x-forwarded-proto']).toBe('https');
		expect(req.headers['x-forwarded-host']).toBe('dash.example.com');
	});
});

describe('trustedProxyMatcher', () => {
	it('returns null when unset', () => {
		expect(trustedProxyMatcher(undefined)).toBeNull();
		expect(trustedProxyMatcher('')).toBeNull();
	});

	it('matches exact proxy IPs and normalizes mapped IPv6', () => {
		const isTrusted = trustedProxyMatcher('127.0.0.1, 172.18.0.1, ::1');
		expect(isTrusted?.('127.0.0.1')).toBe(true);
		expect(isTrusted?.('::ffff:127.0.0.1')).toBe(true);
		expect(isTrusted?.('::1')).toBe(true);
		expect(isTrusted?.('10.0.0.5')).toBe(false);
	});

	it('star trusts every peer', () => {
		expect(trustedProxyMatcher('*')?.('8.8.8.8')).toBe(true);
	});
});

describe('resolveClientIp', () => {
	const req = (xff, socket) => ({
		headers: { 'x-forwarded-for': xff },
		socket: { remoteAddress: socket }
	});

	it('uses the socket address when no proxy is trusted', () => {
		expect(resolveClientIp(req('1.2.3.4, 5.6.7.8', '172.18.0.1'), null)).toBe('172.18.0.1');
	});

	it('uses the leftmost forwarded entry when the peer is trusted', () => {
		const isTrusted = trustedProxyMatcher('172.18.0.1');
		expect(resolveClientIp(req('1.2.3.4, 5.6.7.8', '172.18.0.1'), isTrusted)).toBe('1.2.3.4');
	});

	it('falls back to the socket when a trusted peer sends no chain', () => {
		const isTrusted = trustedProxyMatcher('172.18.0.1');
		expect(resolveClientIp(req(undefined, '172.18.0.1'), isTrusted)).toBe('172.18.0.1');
	});

	it('ignores the chain when the peer is untrusted', () => {
		const isTrusted = trustedProxyMatcher('127.0.0.1');
		expect(resolveClientIp(req('1.2.3.4', '10.0.0.9'), isTrusted)).toBe('10.0.0.9');
	});
});
