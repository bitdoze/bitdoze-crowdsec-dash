/**
 * CrowdSec LAPI shapes (watcher API, `GET /v1/alerts` et al).
 * Only the fields the dashboard uses are declared; unknown fields pass
 * through untouched. Validation is deliberately lenient — a projection
 * must not crash on an unfamiliar upstream field.
 */

export interface LapiKeyValue {
	key?: string;
	value?: string;
}

export interface LapiSource {
	scope?: string;
	value?: string;
	ip?: string;
	range?: string;
	as_number?: string;
	as_name?: string;
	cn?: string;
	/** LAPI sends geo fields as strings; sync coerces with `num()`. */
	latitude?: number | string;
	longitude?: number | string;
}

export interface LapiDecision {
	id?: number;
	origin?: string;
	type?: string;
	scope?: string;
	value?: string;
	duration?: string;
	scenario?: string;
	until?: string;
	simulated?: boolean;
}

export interface LapiAlert {
	id?: number;
	uuid?: string;
	machine_id?: string;
	scenario?: string;
	scenario_version?: string;
	scenario_hash?: string;
	message?: string;
	events_count?: number;
	capacity?: number;
	leakspeed?: string;
	simulated?: boolean;
	remediation?: boolean;
	started_at?: string;
	stopped_at?: string;
	created_at?: string;
	source?: LapiSource;
	events?: { timestamp?: string; meta?: LapiKeyValue[] }[];
	decisions?: LapiDecision[];
	context?: LapiKeyValue[];
	labels?: LapiKeyValue[] | null;
}

export interface WatchersLoginResponse {
	code?: number;
	token?: string;
	expire?: string;
}

/** Decision origins that come from central/community feeds, not the host. */
export const CENTRAL_ORIGINS = new Set(['CAPI', 'lists', 'list']);

/**
 * Origins excluded from alert sync by default (spec phase 3): community
 * blocklist traffic dwarfs real detections and is better shown as a volume
 * number from metrics than as alert rows.
 */
export function isCentralOrigin(origin: string | null | undefined): boolean {
	return origin != null && CENTRAL_ORIGINS.has(origin);
}
