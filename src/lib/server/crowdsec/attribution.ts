/**
 * Alert → site attribution (spec 5.2). Signals in order of confidence:
 *   1. alert meta key `target_fqdn` — where real 1.7.x puts
 *      `crowdsecurity/http_extended` context output (JSON-list values);
 *      `alert.context` kept as a fallback for pushed/older alerts
 *   2. per-event meta `target_fqdn` (parser-set when the log carries a host)
 *   3. `datasource_path` / container name mapped to a known site — only when
 *      the mapping is unambiguous (the datasource belongs to exactly one site)
 *   4. unattributed
 *
 * The signal used is stored on `alert_site.signal` so the UI can show
 * evidence instead of guessing.
 */
import type { LapiAlert, LapiKeyValue } from './types.ts';

export type AttributionSignal = 'context' | 'event_meta' | 'datasource';

export interface Attribution {
	hostname: string;
	signal: AttributionSignal;
}

const kvValue = (list: LapiKeyValue[] | undefined | null, key: string): string | null => {
	if (!list) return null;
	for (const kv of list) {
		if (kv.key === key && kv.value) return kv.value;
	}
	return null;
};

/**
 * Alert `meta` values are aggregated lists JSON-encoded as a single string
 * (`["a.example.com","b.example.com"]`). Returns every element, falling back
 * to the raw string for non-JSON values.
 */
const metaValues = (list: LapiKeyValue[] | undefined | null, key: string): string[] => {
	const raw = kvValue(list, key);
	if (!raw) return [];
	if (!raw.startsWith('[')) return [raw];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [raw];
	} catch {
		return [raw];
	}
};

/** Merge all events' meta into one key list (first value wins per key). */
export function mergedEventMeta(alert: LapiAlert): LapiKeyValue[] {
	const out = new Map<string, string>();
	for (const ev of alert.events ?? []) {
		for (const m of ev.meta ?? []) {
			if (m.key && m.value !== undefined && !out.has(m.key)) out.set(m.key, m.value);
		}
	}
	return [...out.entries()].map(([key, value]) => ({ key, value }));
}

/** Hostnames a datasource path maps to (e.g. /var/log/nginx/site.access.log). */
export interface DatasourceMap {
	/** substring of datasource_path → hostname */
	pathPrefix: [path: string, hostname: string][];
}

/**
 * Attribute one alert to hostnames. Returns [] when nothing is attributable.
 * `knownHostnames` is only used to sanity-filter fqdn values; the datasource
 * fallback uses `map.pathPrefix` entries the administrator configured.
 */
export function attributeAlert(alert: LapiAlert, map: DatasourceMap): Attribution[] {
	const hostnames = new Map<string, Attribution>();

	for (const fqdn of metaValues(alert.meta, 'target_fqdn')) {
		const h = normalize(fqdn);
		if (!hostnames.has(h)) hostnames.set(h, { hostname: h, signal: 'context' });
	}
	const fromContext = kvValue(alert.context, 'target_fqdn');
	if (fromContext && !hostnames.has(normalize(fromContext)))
		hostnames.set(normalize(fromContext), { hostname: normalize(fromContext), signal: 'context' });

	const meta = mergedEventMeta(alert);
	const fromMeta = kvValue(meta, 'target_fqdn');
	if (fromMeta && !hostnames.has(normalize(fromMeta))) {
		hostnames.set(normalize(fromMeta), { hostname: normalize(fromMeta), signal: 'event_meta' });
	}

	if (hostnames.size === 0) {
		const ds = kvValue(meta, 'datasource_path') ?? kvValue(meta, 'datasource');
		if (ds) {
			for (const [prefix, hostname] of map.pathPrefix) {
				if (ds.startsWith(prefix)) {
					hostnames.set(hostname, { hostname, signal: 'datasource' });
					break;
				}
			}
		}
	}

	return [...hostnames.values()];
}

export function normalize(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '');
}
