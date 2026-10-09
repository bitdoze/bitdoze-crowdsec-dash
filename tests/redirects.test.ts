import { describe, expect, it } from 'vitest';
import { sanitizeRedirectTo } from '../src/lib/server/redirects.ts';

describe('sanitizeRedirectTo', () => {
	it('accepts same-origin absolute paths', () => {
		expect(sanitizeRedirectTo('/')).toBe('/');
		expect(sanitizeRedirectTo('/servers?page=2')).toBe('/servers?page=2');
	});

	it('rejects external, protocol-relative, and malformed values', () => {
		for (const value of [
			'https://evil.example',
			'//evil.example',
			'//evil.example/path',
			'\\evil.example',
			'/\\evil.example',
			'javascript:alert(1)',
			'',
			null,
			undefined,
			'/path with space'
		]) {
			expect(sanitizeRedirectTo(value), String(value)).toBe('/');
		}
	});
});
