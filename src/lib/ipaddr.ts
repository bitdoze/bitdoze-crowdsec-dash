/**
 * IP/CIDR normalization and duration parsing for decision forms.
 * Pure module — safe on client and server.
 */

const IPV4 = /^(\d{1,3})(?:\.(\d{1,3})){3}$/;

function isIpv4(v: string): boolean {
	const m = IPV4.exec(v);
	return !!m && v.split('.').every((o) => Number(o) <= 255);
}

/** Loosely accepts canonical and shorthand IPv6 (no zone ids). */
function isIpv6(v: string): boolean {
	if (!/^[0-9a-fA-F:]+$/.test(v) || !v.includes(':')) return false;
	const halves = v.split('::');
	if (halves.length > 2) return false;
	const groups = (s: string) => (s === '' ? [] : s.split(':'));
	const head = groups(halves[0]);
	const tail = halves.length === 2 ? groups(halves[1]) : [];
	if (head.length + tail.length > 8) return false;
	if (halves.length === 1 && head.length !== 8) return false;
	return [...head, ...tail].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

export interface Target {
	scope: 'ip' | 'range';
	value: string;
}

/**
 * Normalize "1.2.3.4", "1.2.3.4/32", or "10.0.0.0/8" into a typed target.
 * /32 and /128 collapse to a plain ip target. Returns null when invalid.
 */
export function normalizeTarget(raw: string): Target | null {
	const v = raw.trim();
	if (!v) return null;
	const slash = v.indexOf('/');
	if (slash === -1) return isIpv4(v) || isIpv6(v) ? { scope: 'ip', value: v } : null;
	const base = v.slice(0, slash);
	const bits = Number(v.slice(slash + 1));
	if (!Number.isInteger(bits) || bits < 0) return null;
	if (isIpv4(base)) {
		if (bits > 32) return null;
		return bits === 32 ? { scope: 'ip', value: base } : { scope: 'range', value: v };
	}
	if (isIpv6(base)) {
		if (bits > 128) return null;
		return bits === 128 ? { scope: 'ip', value: base } : { scope: 'range', value: v };
	}
	return null;
}

/** RFC1918 + loopback + link-local + CGNAT + ULA — "looks like a proxy address". */
export function isPrivateIp(ip: string): boolean {
	if (isIpv4(ip)) {
		const [a, b] = ip.split('.').map(Number);
		return (
			a === 10 ||
			a === 127 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 169 && b === 254) ||
			(a === 100 && b >= 64 && b <= 127)
		);
	}
	const lower = ip.toLowerCase();
	// ::1 loopback, fc00::/7 ULA, fe80::/10 link-local (fe80–febf)
	return (
		lower === '::1' ||
		lower.startsWith('fc') ||
		lower.startsWith('fd') ||
		['fe8', 'fe9', 'fea', 'feb'].includes(lower.slice(0, 3))
	);
}

const DURATION_PART = /(\d+)\s*([smhd])/g;
const MAX_DURATION_S = 30 * 24 * 3600; // 30d cap on manual bans

/** Parse "4h", "4h30m", "90m", "2d" into seconds; null when invalid/zero/over the cap. */
export function parseDuration(raw: string): number | null {
	const v = raw.trim().toLowerCase();
	if (!v || !/^(?:\d+\s*[smhd])+$/.test(v)) return null;
	let total = 0;
	for (const m of v.matchAll(DURATION_PART)) {
		const n = Number(m[1]);
		const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
		total += n * mult;
	}
	return total > 0 && total <= MAX_DURATION_S ? total : null;
}
