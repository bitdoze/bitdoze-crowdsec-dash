/**
 * Site alias parsing/validation. Pure module — safe on client and server.
 * An alias is an alternate hostname whose alerts attribute to the site.
 */

const HOST = /^(?=.{1,253}\.?$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;

/**
 * WAF protection levels (spec §5.5). Each level composes Hub AppSec
 * collections; level 3 observes out-of-band before level 4 blocks in-band.
 */
export type WafLevel = 'off' | '1' | '2' | '3' | '4';

export const WAF_LEVELS: { value: WafLevel; label: string; risk: string }[] = [
	{ value: 'off', label: 'Off — detection only', risk: 'no inline WAF' },
	{ value: '1', label: 'Level 1 — Virtual patching', risk: 'low false-positive risk' },
	{ value: '2', label: 'Level 2 — + generic rules', risk: 'low–moderate false-positive risk' },
	{ value: '3', label: 'Level 3 — CRS observe-only', risk: 'moderate; surfaced as alerts' },
	{ value: '4', label: 'Level 4 — CRS blocking', risk: 'high; needs observed CRS alerts' }
];

export type RemediationPreset = 'flat' | 'escalating' | 'captcha';

export const REMEDIATION_PRESETS: { value: RemediationPreset; label: string }[] = [
	{ value: 'flat', label: 'Flat — every detection bans 4h' },
	{ value: 'escalating', label: 'Escalating — repeat offenders +4h each' },
	{ value: 'captcha', label: 'Captcha — challenge low-confidence scenarios' }
];

export function normalizeHost(v: string): string {
	return v.trim().toLowerCase().replace(/\.$/, '');
}

/** Parse a JSON array stored in `site.aliases` — tolerant of junk input. */
export function parseAliases(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return [...new Set(arr.filter((a): a is string => typeof a === 'string').map(normalizeHost))];
	} catch {
		return [];
	}
}

/**
 * Validate a comma/space-separated alias list typed by the operator.
 * Returns normalized aliases or an error message naming the bad entry.
 */
export function validateAliases(
	input: string,
	primary: string
): { aliases: string[] } | { error: string } {
	const aliases = [
		...new Set(
			input
				.split(/[\s,]+/)
				.map(normalizeHost)
				.filter(Boolean)
		)
	];
	if (aliases.length > 32) return { error: 'At most 32 aliases per site.' };
	for (const a of aliases) {
		if (!HOST.test(a)) return { error: `"${a}" is not a valid hostname.` };
		if (a === normalizeHost(primary)) return { error: `"${a}" duplicates the site hostname.` };
	}
	return { aliases };
}

/** Parse a JSON array stored in `site.appsecExclusions` — tolerant of junk. */
export function parseCollections(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return [...new Set(arr.filter((x): x is string => typeof x === 'string'))];
	} catch {
		return [];
	}
}

/** Hub item name shape: `author/name` (collections, scenarios, parsers). */
const HUB_ITEM = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127}$/i;

/**
 * Validate a comma/space-separated list of AppSec exclusion collection
 * names (e.g. crowdsecurity/appsec-wordpress). Stored verbatim — cscli
 * refuses unknown items at install time.
 */
export function validateCollections(input: string): { items: string[] } | { error: string } {
	const items = [
		...new Set(
			input
				.split(/[\s,]+/)
				.map((x) => x.trim().toLowerCase())
				.filter(Boolean)
		)
	];
	if (items.length > 16) return { error: 'At most 16 exclusion collections per site.' };
	for (const i of items) {
		if (!HUB_ITEM.test(i))
			return {
				error: `"${i}" is not a hub item name — use author/name (e.g. crowdsecurity/appsec-wordpress).`
			};
	}
	return { items };
}
