import { describe, expect, it } from 'vitest';
import { SetupToken } from '../src/lib/server/setup-token.ts';

describe('SetupToken', () => {
	it('generates a base64url token when none is given', () => {
		const t = new SetupToken();
		expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('verifies the right token and is single-use', () => {
		const t = new SetupToken('fixed-token');
		expect(t.verify('fixed-token')).toBe('ok');
		expect(t.verify('fixed-token')).toBe('invalid');
	});

	it('can be re-armed with release() after a failed follow-up', () => {
		const t = new SetupToken('fixed-token');
		expect(t.verify('fixed-token')).toBe('ok');
		t.release();
		expect(t.verify('fixed-token')).toBe('ok');
	});

	it('rejects wrong tokens and does not consume itself', () => {
		const t = new SetupToken('fixed-token');
		expect(t.verify('wrong')).toBe('invalid');
		expect(t.verify('fixed-token')).toBe('ok');
	});

	it('rate-limits after 10 failed attempts in 15 minutes', () => {
		let now = 0;
		const t = new SetupToken('fixed-token', () => now);
		for (let i = 0; i < 10; i++) expect(t.verify('nope')).toBe('invalid');
		expect(t.verify('fixed-token')).toBe('too_many');
		// window slides: 16 minutes later the failures expire
		now = 16 * 60 * 1000;
		expect(t.verify('fixed-token')).toBe('ok');
	});

	it('does not leak timing by length (any length is checked)', () => {
		const t = new SetupToken('fixed-token');
		expect(t.verify('x')).toBe('invalid');
		expect(t.verify('x'.repeat(200))).toBe('invalid');
	});
});
