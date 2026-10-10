/**
 * Edge-sync pure logic — which decisions belong on the Cloudflare list,
 * how they diff against confirmed list state, and the rule expression
 * per zone. No I/O; unit-tested directly.
 */

import type { CfListItem } from './client.ts';

/**
 * Origins whose decisions the dashboard enforces at the edge. Local
 * sources only — the community blocklist alone exceeds Free-plan list
 * capacity, so `lists:*` origins never leave the origin bouncer.
 */
export const EDGE_ORIGINS = new Set(['crowdsec', 'cscli', 'crowdsec-appsec']);

export interface EdgeCandidate {
	/** IP or CIDR value as stored in the decision row. */
	value: string | null;
	origin: string | null;
	scope: string | null;
	type: string | null;
	scenario: string | null;
	/** Expiry; null = no expiry on record. */
	until: Date | null;
	expired: boolean;
}

export interface EdgeItem {
	ip: string;
	comment: string;
	/** Sort key — later expiry wins when capacity forces a cut. */
	untilMs: number;
}

function isIpOrCidr(value: string): boolean {
	return (
		/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(value) || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(value)
	);
}

/** Dedupe + filter active decisions into list items. */
export function edgeCandidates(decisions: EdgeCandidate[]): EdgeItem[] {
	const seen = new Map<string, EdgeItem>();
	for (const d of decisions) {
		if (d.expired) continue;
		if (!d.origin || !EDGE_ORIGINS.has(d.origin)) continue;
		if (!d.value || !isIpOrCidr(d.value)) continue;
		if (d.until && d.until.getTime() <= Date.now()) continue;
		const untilMs = d.until?.getTime() ?? Number.MAX_SAFE_INTEGER;
		const comment = `${d.origin}:${(d.scenario ?? d.type ?? 'decision').slice(0, 80)}`.slice(
			0,
			128
		);
		const prev = seen.get(d.value);
		if (!prev || untilMs > prev.untilMs) seen.set(d.value, { ip: d.value, comment, untilMs });
	}
	return [...seen.values()];
}

/**
 * Trim to capacity keeping the latest-expiring entries; returns how
 * many were dropped so the UI can report it honestly.
 */
export function applyCapacity(
	items: EdgeItem[],
	capacity: number
): { kept: EdgeItem[]; dropped: number } {
	if (items.length <= capacity) return { kept: items, dropped: 0 };
	const sorted = [...items].sort((a, b) => b.untilMs - a.untilMs);
	return { kept: sorted.slice(0, capacity), dropped: items.length - capacity };
}

export interface ListDiff {
	add: CfListItem[];
	remove: { ip: string }[];
}

/** Bulk-update payload — add everything wanted but absent, remove stale. */
export function diffItems(current: CfListItem[], wanted: EdgeItem[]): ListDiff {
	const currentIps = new Set(current.map((i) => i.ip));
	const wantedIps = new Set(wanted.map((i) => i.ip));
	return {
		add: wanted.filter((i) => !currentIps.has(i.ip)).map((i) => ({ ip: i.ip, comment: i.comment })),
		remove: current.filter((i) => !wantedIps.has(i.ip)).map((i) => ({ ip: i.ip }))
	};
}

export const RULE_REF = 'crowdsec-dash-edge';

/**
 * The per-zone WAF custom rule. `http.host in {...}` narrows to selected
 * hostnames (empty = whole zone); `paths` narrows further to URI prefixes
 * via `starts_with` (empty = all paths).
 */
export function ruleExpression(
	listName: string,
	hostnames: string[],
	paths: string[] = []
): string {
	let expr = `ip.src in $${listName}`;
	if (hostnames.length) {
		expr += ` and http.host in {${hostnames.map((h) => `"${h}"`).join(' ')}}`;
	}
	if (paths.length) {
		const p = paths.map((p) => `starts_with(http.request.uri.path, "${p}")`).join(' or ');
		expr += ` and (${p})`;
	}
	return `(${expr})`;
}

/** `log` is Cloudflare's observe mode — matches are recorded, not blocked. */
export type EdgeRuleAction = 'block' | 'challenge' | 'log';

export function edgeRule(
	listName: string,
	hostnames: string[],
	action: EdgeRuleAction,
	paths: string[] = []
): { ref: string; expression: string; action: string; description: string; enabled: boolean } {
	const scope = [hostnames.length ? 'selected hosts' : '', paths.length ? 'selected paths' : '']
		.filter(Boolean)
		.join(' + ');
	return {
		ref: RULE_REF,
		expression: ruleExpression(listName, hostnames, paths),
		action,
		description: `CrowdSec edge — decisions from ${listName}${scope ? ` (${scope})` : ''}. Managed by bitdoze-crowdsec-dash.`,
		enabled: true
	};
}
