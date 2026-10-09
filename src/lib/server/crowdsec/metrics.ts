/**
 * Minimal Prometheus text-format parser + the whitelist of CrowdSec
 * counters the dashboard samples. We only read low-cardinality series
 * (acquisition/parser/scenario/AppSec/LAPI/decision totals) — no per-bucket
 * or per-request histograms.
 */

export interface MetricPoint {
	name: string;
	labels: Record<string, string>;
	value: number;
}

/** Parse `name{label="v",…} value [ts]` and `# HELP/TYPE` are ignored. */
export function parsePrometheus(text: string): MetricPoint[] {
	const points: MetricPoint[] = [];
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?[\d.eE+NaInfy]+)/.exec(line);
		if (!match) continue;
		const labels: Record<string, string> = {};
		if (match[3]) {
			for (const lm of match[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
				labels[lm[1]] = lm[2].replace(/\\(.)/g, '$1');
			}
		}
		const value = Number(match[4]);
		if (Number.isFinite(value)) points.push({ name: match[1], labels, value });
	}
	return points;
}

/**
 * Series worth persisting. Keys are the labels we keep; a series passes only
 * when its label set contains no extra high-cardinality keys.
 */
const WHITELIST: Record<string, readonly string[]> = {
	cs_parser_hits_total: ['source'],
	cs_parser_hits_ok_total: ['source'],
	cs_parser_hits_ko_total: ['source'],
	cs_bucket_created_total: ['name', 'instantiation'],
	cs_lapi_requests_total: ['method', 'endpoint'],
	cs_lapi_response_codes_total: ['code', 'endpoint'],
	cs_active_decisions: ['origin', 'action', 'scenario'],
	cs_alerts: ['reason'],
	cs_info: ['version'],
	cs_appsec_processed_requests_total: ['appsec_engine', 'appsec_rule'],
	cs_appsec_block_hits_total: ['appsec_engine'],
	cs_appsec_rule_hits_total: ['appsec_engine', 'rule_name']
};

export function whitelisted(point: MetricPoint): boolean {
	const keep = WHITELIST[point.name];
	if (!keep) return false;
	return Object.keys(point.labels).every((k) => keep.includes(k));
}

export interface MetricsSummary {
	/** cs_info version label. */
	version: string | null;
	/** Active decisions by origin label, e.g. { CAPI: 21286, crowdsec: 4 }. */
	activeDecisionsByOrigin: Record<string, number>;
	/** Acquisition lines read/parsed/failed per datasource. */
	acquisition: { source: string; read: number; parsed: number; failed: number }[];
	/** AppSec processed/blocked counters (0 when AppSec is absent). */
	appsec: { processed: number; blocked: number };
	/** Total LAPI requests observed. */
	lapiRequests: number;
}

export function summarizeMetrics(points: MetricPoint[]): MetricsSummary {
	const out: MetricsSummary = {
		version: null,
		activeDecisionsByOrigin: {},
		acquisition: [],
		appsec: { processed: 0, blocked: 0 },
		lapiRequests: 0
	};
	const acq = new Map<string, { read: number; parsed: number; failed: number }>();
	for (const p of points) {
		switch (p.name) {
			case 'cs_info':
				out.version ??= p.labels.version ?? null;
				break;
			case 'cs_active_decisions':
				out.activeDecisionsByOrigin[p.labels.origin ?? 'unknown'] =
					(out.activeDecisionsByOrigin[p.labels.origin ?? 'unknown'] ?? 0) + p.value;
				break;
			case 'cs_parser_hits_total':
			case 'cs_parser_hits_ok_total':
			case 'cs_parser_hits_ko_total': {
				const src = p.labels.source ?? 'unknown';
				const row = acq.get(src) ?? { read: 0, parsed: 0, failed: 0 };
				if (p.name.endsWith('_ok_total')) row.parsed += p.value;
				else if (p.name.endsWith('_ko_total')) row.failed += p.value;
				else row.read += p.value;
				acq.set(src, row);
				break;
			}
			case 'cs_appsec_processed_requests_total':
				out.appsec.processed += p.value;
				break;
			case 'cs_appsec_block_hits_total':
				out.appsec.blocked += p.value;
				break;
			case 'cs_lapi_requests_total':
				out.lapiRequests += p.value;
				break;
		}
	}
	out.acquisition = [...acq.entries()].map(([source, v]) => ({ source, ...v }));
	return out;
}
