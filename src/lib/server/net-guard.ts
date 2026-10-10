/**
 * SSRF guard for outbound destinations.
 *
 * Two policies:
 * - 'webhook' (notification delivery): blocks loopback, link-local
 *   (incl. cloud metadata), and unspecified addresses. Private LAN ranges
 *   are deliberately ALLOWED — a self-hosted dashboard legitimately
 *   notifies LAN ntfy/Gotify receivers, and channel config is admin-only.
 * - 'probe' (topology detection): blocks link-local + unspecified only —
 *   operators legitimately probe local proxies on loopback/LAN.
 *
 * Built on node:net BlockList rather than hand-rolled parsing: checking an
 * IPv6 literal also evaluates IPv4-mapped forms (`::ffff:a.b.c.d` and the
 * hex `::ffff:XXXX:XXXX` that URL normalization produces) against the
 * IPv4 rules, so `::ffff:7f00:1` is the loopback it actually is.
 */
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

type Policy = 'webhook' | 'probe';

const LISTS: Record<Policy, BlockList> = {
	webhook: buildList(
		['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/8'],
		['::1/128', '::/128', 'fe80::/10']
	),
	probe: buildList(['169.254.0.0/16', '0.0.0.0/8'], ['::/128', 'fe80::/10'])
};

function buildList(v4: string[], v6: string[]): BlockList {
	const bl = new BlockList();
	for (const cidr of v4) {
		const [addr, prefix] = cidr.split('/');
		bl.addSubnet(addr, Number(prefix), 'ipv4');
	}
	for (const cidr of v6) {
		const [addr, prefix] = cidr.split('/');
		bl.addSubnet(addr, Number(prefix), 'ipv6');
	}
	return bl;
}

/** Is this IP literal (v4 or v6, incl. mapped forms) blocked under `policy`? */
export function isBlockedAddress(addr: string, policy: Policy): boolean {
	const host = addr.replace(/^\[|\]$/g, '');
	const kind = isIP(host);
	if (kind === 4) return LISTS[policy].check(host, 'ipv4');
	if (kind === 6) return LISTS[policy].check(host, 'ipv6');
	return false;
}

type Resolver = (host: string) => Promise<{ address: string }[]>;

/**
 * Assert every address a hostname resolves to is allowed under `policy`.
 * IP literals are checked directly — no DNS round-trip. Any blocked
 * answer rejects the whole destination (TOCTOU-safe: runs right before
 * the outbound request, not at save time).
 */
export async function assertResolvesSafely(
	hostname: string,
	policy: Policy,
	resolve?: Resolver
): Promise<void> {
	const host = hostname.replace(/^\[|\]$/g, '');
	if (isIP(host)) {
		if (isBlockedAddress(host, policy)) {
			throw new Error(`Destination host "${host}" is not allowed.`);
		}
		return;
	}
	const addrs = await (resolve ? resolve(host) : lookup(host, { all: true, verbatim: true }));
	for (const a of addrs) {
		if (isBlockedAddress(a.address, policy)) {
			throw new Error(`"${host}" resolves to a blocked address (${a.address}).`);
		}
	}
}
