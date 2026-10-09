import { describe, expect, it } from 'vitest';
import { isPrivateIp, normalizeTarget, parseDuration } from '#lib/ipaddr.ts';

describe('normalizeTarget', () => {
	it('accepts plain IPv4 and IPv6', () => {
		expect(normalizeTarget('1.2.3.4')).toEqual({ scope: 'ip', value: '1.2.3.4' });
		expect(normalizeTarget('2001:db8::1')).toEqual({ scope: 'ip', value: '2001:db8::1' });
		expect(normalizeTarget('::1')).toEqual({ scope: 'ip', value: '::1' });
	});
	it('collapses /32 and /128 to ip scope', () => {
		expect(normalizeTarget('1.2.3.4/32')).toEqual({ scope: 'ip', value: '1.2.3.4' });
		expect(normalizeTarget('2001:db8::1/128')).toEqual({ scope: 'ip', value: '2001:db8::1' });
	});
	it('keeps real CIDRs as ranges', () => {
		expect(normalizeTarget('10.0.0.0/8')).toEqual({ scope: 'range', value: '10.0.0.0/8' });
		expect(normalizeTarget('2001:db8::/32')).toEqual({ scope: 'range', value: '2001:db8::/32' });
	});
	it('rejects garbage', () => {
		for (const bad of [
			'',
			'999.1.1.1',
			'1.2.3.4/33',
			'hello',
			'1.2.3.4/-1',
			'::/129',
			'1.2.3.4.5'
		]) {
			expect(normalizeTarget(bad), bad).toBeNull();
		}
	});
});

describe('isPrivateIp', () => {
	it('flags RFC1918, loopback, link-local, CGNAT', () => {
		for (const ip of [
			'10.1.2.3',
			'172.16.0.1',
			'192.168.1.1',
			'127.0.0.1',
			'169.254.1.1',
			'100.64.0.1'
		]) {
			expect(isPrivateIp(ip), ip).toBe(true);
		}
	});
	it('flags IPv6 loopback, ULA, link-local', () => {
		for (const ip of ['::1', 'fd00::1', 'fc12::1', 'fe80::1', 'febf::1']) {
			expect(isPrivateIp(ip), ip).toBe(true);
		}
	});
	it('passes public addresses', () => {
		for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '2001:db8::1']) {
			expect(isPrivateIp(ip), ip).toBe(false);
		}
	});
});

describe('parseDuration', () => {
	it('parses compound durations', () => {
		expect(parseDuration('4h')).toBe(14400);
		expect(parseDuration('4h30m')).toBe(16200);
		expect(parseDuration('90m')).toBe(5400);
		expect(parseDuration('2d')).toBe(172800);
		expect(parseDuration('45s')).toBe(45);
	});
	it('rejects invalid and over-limit values', () => {
		expect(parseDuration('')).toBeNull();
		expect(parseDuration('0s')).toBeNull();
		expect(parseDuration('4x')).toBeNull();
		expect(parseDuration('-1h')).toBeNull();
		expect(parseDuration('31d')).toBeNull(); // over the 30d cap
	});
});
