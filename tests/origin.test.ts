import { describe, expect, it } from 'vitest';
import { parseOrigin, pinOriginHeaders } from '../server/origin.js';

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
