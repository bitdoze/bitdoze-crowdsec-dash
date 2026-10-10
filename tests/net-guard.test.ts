/**
 * SSRF guard — BlockList-based classification (IPv4-mapped IPv6 incl. hex
 * forms), DNS-resolution policies, and the webhook/probe split (webhooks
 * block loopback; probes allow it).
 */
import { describe, expect, it } from 'vitest';
import { assertResolvesSafely, isBlockedAddress } from '#lib/server/net-guard.ts';
import { assertSafeHttpUrl } from '#lib/server/notify/deliver.ts';

const resolvesTo =
	(...addrs: string[]) =>
	async () =>
		addrs.map((address) => ({ address }));

describe('isBlockedAddress', () => {
	it('evaluates IPv4-mapped IPv6 as the embedded IPv4 (documented BlockList behaviour)', () => {
		expect(isBlockedAddress('::ffff:127.0.0.1', 'webhook')).toBe(true);
		expect(isBlockedAddress('::ffff:7f00:1', 'webhook')).toBe(true); // hex form
		expect(isBlockedAddress('0:0:0:0:0:ffff:a9fe:a9fe', 'webhook')).toBe(true); // 169.254.169.254
		expect(isBlockedAddress('::ffff:0808:0808', 'webhook')).toBe(false); // 8.8.8.8
		// An ffff group that is NOT a mapped form stays a plain public IPv6.
		expect(isBlockedAddress('2001:db8::ffff:1', 'webhook')).toBe(false);
	});

	it('covers loopback, link-local, unspecified on both families', () => {
		expect(isBlockedAddress('127.1.2.3', 'webhook')).toBe(true);
		expect(isBlockedAddress('::1', 'webhook')).toBe(true);
		expect(isBlockedAddress('169.254.10.1', 'webhook')).toBe(true);
		expect(isBlockedAddress('fe80::1', 'webhook')).toBe(true);
		expect(isBlockedAddress('0.0.0.0', 'webhook')).toBe(true);
		expect(isBlockedAddress('::', 'webhook')).toBe(true);
	});

	it('leaves private LAN and ULA allowed for webhooks', () => {
		expect(isBlockedAddress('10.0.0.5', 'webhook')).toBe(false);
		expect(isBlockedAddress('192.168.1.1', 'webhook')).toBe(false);
		expect(isBlockedAddress('fd12::1', 'webhook')).toBe(false); // ULA
		expect(isBlockedAddress('93.184.216.34', 'webhook')).toBe(false);
	});

	it('is not an address for hostnames', () => {
		expect(isBlockedAddress('not-an-ip.example.com', 'webhook')).toBe(false);
	});
});

describe('assertResolvesSafely', () => {
	it('rejects mapped-IPv6 literals without a DNS lookup', async () => {
		const never = async () => {
			throw new Error('must not resolve');
		};
		await expect(assertResolvesSafely('::ffff:127.0.0.1', 'webhook', never)).rejects.toThrow(
			/not allowed/
		);
		await expect(assertResolvesSafely('::ffff:7f00:1', 'webhook', never)).rejects.toThrow(
			/not allowed/
		);
		await expect(assertResolvesSafely('::ffff:a9fe:a9fe', 'probe', never)).rejects.toThrow(
			/not allowed/
		);
	});

	it('webhook rejects DNS answers on loopback or link-local', async () => {
		await expect(
			assertResolvesSafely('evil.example', 'webhook', resolvesTo('127.0.0.1'))
		).rejects.toThrow(/blocked/);
		await expect(
			assertResolvesSafely('evil.example', 'webhook', resolvesTo('169.254.169.254'))
		).rejects.toThrow(/blocked/);
		// One bad answer in a round-robin is enough.
		await expect(
			assertResolvesSafely('evil.example', 'webhook', resolvesTo('93.184.216.34', '::1'))
		).rejects.toThrow(/blocked/);
	});

	it('webhook allows private LAN destinations (product decision)', async () => {
		await expect(
			assertResolvesSafely('ntfy.lan', 'webhook', resolvesTo('10.0.0.20'))
		).resolves.toBeUndefined();
		await expect(
			assertResolvesSafely('ntfy.lan', 'webhook', resolvesTo('10.0.0.20', '192.168.1.5'))
		).resolves.toBeUndefined();
	});

	it('probe allows loopback/local proxies but never link-local', async () => {
		await expect(assertResolvesSafely('127.0.0.1', 'probe')).resolves.toBeUndefined();
		await expect(assertResolvesSafely('::1', 'probe')).resolves.toBeUndefined();
		await expect(
			assertResolvesSafely('proxy.lan', 'probe', resolvesTo('10.0.0.5'))
		).resolves.toBeUndefined();
		await expect(assertResolvesSafely('169.254.169.254', 'probe')).rejects.toThrow(/not allowed/);
		await expect(assertResolvesSafely('fe80::1', 'probe')).rejects.toThrow(/not allowed/);
		await expect(
			assertResolvesSafely('metadata.example', 'probe', resolvesTo('169.254.169.254'))
		).rejects.toThrow(/blocked/);
	});
});

describe('assertSafeHttpUrl mapped literals', () => {
	it('rejects mapped-IPv6 loopback and metadata at save time', () => {
		expect(() => assertSafeHttpUrl('http://[::ffff:127.0.0.1]/hook')).toThrow();
		expect(() => assertSafeHttpUrl('http://[::ffff:7f00:1]/hook')).toThrow();
		expect(() => assertSafeHttpUrl('http://[::ffff:a9fe:a9fe]/meta')).toThrow();
	});
});
