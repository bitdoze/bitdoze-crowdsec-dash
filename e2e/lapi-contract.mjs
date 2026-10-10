/**
 * The real CrowdSec LAPI /v1 contract as the dashboard's client uses it —
 * shared between e2e/mock-lapi.mjs and unit-test fakes so the code under
 * test sees upstream semantics, not convenient assumptions.
 *
 * Verified against crowdsec pkg/database/alertfilter.go + controllers/v1:
 * - since/until/created_before are Go DURATIONS (now - d), not timestamps
 * - unknown filter params and bad durations → HTTP 500 {"message": ...}
 * - results order by created_at DESC, id DESC (sort=ASC flips)
 * - limit defaults to 100, no offset
 * - include_capi=false drops alerts carrying CAPI/lists decisions
 * - has_active_decision=true keeps alerts with a decision until >= now
 * - POST /v1/alerts validates required fields (→500) and requires labels
 *   to be []string (object labels → 400)
 */

const CENTRAL = new Set(['CAPI', 'lists', 'list']);

/** "90s", "4h30m", "30d", "1h30m" → seconds. Throws on anything else. */
export function parseGoDuration(s) {
	if (typeof s !== 'string' || !s) throw new Error(`while parsing duration "${s}"`);
	const re = /(\d+)([smhd])/g;
	let total = 0;
	let matched = '';
	let m;
	while ((m = re.exec(s)) !== null) {
		matched += m[0];
		const n = Number(m[1]);
		const unit = { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
		total += n * unit;
	}
	if (matched !== s) throw new Error(`while parsing duration "${s}"`);
	return total;
}

// The exact parameter set the real filter accepts (alertfilter.go).
const KNOWN_PARAMS = new Set([
	'contains',
	'scope',
	'value',
	'scenario',
	'ip',
	'range',
	'since',
	'created_before',
	'until',
	'decision_type',
	'origin',
	'include_capi',
	'has_active_decision',
	'kind',
	'limit',
	'sort',
	'simulated',
	'with_decisions'
]);

const ts = (iso) => {
	const t = Date.parse(iso ?? '');
	return Number.isNaN(t) ? null : t;
};

const hasCapiDecision = (a) => (a.decisions ?? []).some((d) => CENTRAL.has(d.origin));

/**
 * Apply GET /v1/alerts filtering. Returns { error: {status, message} } on
 * contract violations, else { alerts } ordered and limited like upstream.
 */
export function filterAlerts(alerts, searchParams, now = Date.now()) {
	const err = (message) => ({ error: { status: 500, message } });
	for (const key of searchParams.keys()) {
		if (!KNOWN_PARAMS.has(key)) return err(`filter parameter '${key}' is unknown`);
	}
	let sinceS, untilS, createdBeforeS;
	try {
		if (searchParams.has('since')) sinceS = parseGoDuration(searchParams.get('since'));
		if (searchParams.has('until')) untilS = parseGoDuration(searchParams.get('until'));
		if (searchParams.has('created_before'))
			createdBeforeS = parseGoDuration(searchParams.get('created_before'));
	} catch (e) {
		return err(e.message);
	}
	// limit=0 means "no limit"; negative or non-integer → 500.
	let limit = 100;
	if (searchParams.has('limit')) {
		limit = Number(searchParams.get('limit'));
		if (!Number.isInteger(limit) || limit < 0) return err('limit must be a positive integer');
	}
	const asc = searchParams.get('sort') === 'ASC';

	let out = [...alerts];
	if (sinceS !== undefined) {
		const floor = now - sinceS * 1000;
		out = out.filter((a) => (ts(a.started_at) ?? ts(a.created_at) ?? 0) >= floor);
	}
	if (untilS !== undefined) {
		const ceil = now - untilS * 1000;
		out = out.filter((a) => (ts(a.started_at) ?? ts(a.created_at) ?? 0) <= ceil);
	}
	if (createdBeforeS !== undefined) {
		const ceil = now - createdBeforeS * 1000;
		out = out.filter((a) => (ts(a.created_at) ?? 0) <= ceil);
	}
	if (searchParams.get('include_capi') === 'false') {
		out = out.filter((a) => !hasCapiDecision(a));
	}
	if (searchParams.get('has_active_decision') === 'true') {
		out = out.filter((a) =>
			(a.decisions ?? []).some((d) => {
				const u = ts(d.until);
				return u !== null && u >= now;
			})
		);
	}
	if (searchParams.has('scenario')) {
		const s = searchParams.get('scenario');
		out = out.filter((a) => (a.scenario ?? '').includes(s));
	}
	if (searchParams.has('ip')) {
		const ip = searchParams.get('ip');
		out = out.filter((a) => a.source?.value === ip || a.source?.ip === ip);
	}
	if (searchParams.has('origin')) {
		const o = searchParams.get('origin');
		out = out.filter((a) => (a.decisions ?? []).some((d) => d.origin === o));
	}
	// Simulated alerts are INCLUDED by default — only simulated=false drops them.
	if (searchParams.get('simulated') === 'false') {
		out = out.filter((a) => !a.simulated);
	}
	out.sort((a, b) => {
		const da = ts(a.created_at) ?? 0;
		const db = ts(b.created_at) ?? 0;
		if (da !== db) return asc ? da - db : db - da;
		return asc ? (a.id ?? 0) - (b.id ?? 0) : (b.id ?? 0) - (a.id ?? 0);
	});
	return { alerts: limit === 0 ? out : out.slice(0, limit) };
}

const ALERT_REQUIRED = [
	'capacity',
	'decisions',
	'events',
	'events_count',
	'leakspeed',
	'message',
	'scenario',
	'scenario_hash',
	'scenario_version',
	'simulated',
	'source',
	'start_at',
	'stop_at'
];
const DECISION_REQUIRED = ['duration', 'origin', 'scenario', 'scope', 'type', 'value'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate a POST /v1/alerts body the way the real handler does:
 * malformed payloads (labels not []string) → 400 bind error; missing
 * required fields → 500 validation error. Returns {status, message}|null.
 */
export function validateAddAlerts(body) {
	if (!Array.isArray(body)) return { status: 400, message: 'body must be an array of alerts' };
	for (const a of body) {
		if (!isObj(a)) return { status: 400, message: 'each alert must be an object' };
		for (const f of ALERT_REQUIRED) {
			if (a[f] === undefined || a[f] === null)
				return { status: 500, message: `missing required field '${f}'` };
		}
		if (typeof a.capacity !== 'number') return { status: 500, message: 'capacity must be an int' };
		if (!Array.isArray(a.decisions)) return { status: 500, message: 'decisions must be an array' };
		if (!Array.isArray(a.events)) return { status: 500, message: 'events must be an array' };
		if (typeof a.events_count !== 'number')
			return { status: 500, message: 'events_count must be an int' };
		if (!isObj(a.source) || a.source.scope === undefined || a.source.value === undefined)
			return { status: 500, message: 'source requires scope and value' };
		if (a.labels !== undefined && a.labels !== null) {
			if (!Array.isArray(a.labels) || a.labels.some((l) => typeof l !== 'string'))
				return { status: 400, message: 'labels must be an array of strings' };
		}
		for (const d of a.decisions) {
			if (!isObj(d)) return { status: 500, message: 'decisions must be objects' };
			for (const f of DECISION_REQUIRED) {
				if (d[f] === undefined || d[f] === null)
					return { status: 500, message: `decision missing required field '${f}'` };
			}
		}
	}
	return null;
}
