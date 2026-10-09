/**
 * Overview ("inspection record") data model.
 *
 * These types describe what the dashboard knows after an inspection pass over
 * one server: which sites exist, how each protection test went, what the
 * server-wide layers look like, and the coded observations an operator should
 * act on. Real data arrives with the CrowdSec connection in phase 3; until
 * then only clearly labeled fixtures populate it (see ../server/overview.ts).
 */

export type CheckState = 'verified' | 'degraded' | 'failed' | 'stale' | 'not_configured';

export type TestId = 'logs_read' | 'logs_parsed' | 'client_ip' | 'bouncer' | 'waf' | 'edge';

export interface TestMeta {
	id: TestId;
	/** Column code, e.g. "T1". */
	code: string;
	/** Short column heading. */
	column: string;
	/** Full name, used in evidence and labels. */
	name: string;
	/** What passing this test means. */
	description: string;
}

/** Schedule columns in order — do not reorder without renumbering codes. */
export const TESTS: readonly TestMeta[] = [
	{
		id: 'logs_read',
		code: 'T1',
		column: 'Logs read',
		name: 'Access logs acquired',
		description: 'The proxy writes access logs for this site and CrowdSec acquires them.'
	},
	{
		id: 'logs_parsed',
		code: 'T2',
		column: 'Parsed',
		name: 'Logs parsed',
		description: 'Acquired lines parse into events instead of falling to the unparsed bucket.'
	},
	{
		id: 'client_ip',
		code: 'T3',
		column: 'Client IP',
		name: 'Real client IP',
		description:
			'The proxy resolves the visitor address from forwarded headers only for trusted proxies.'
	},
	{
		id: 'bouncer',
		code: 'T4',
		column: 'Bouncer',
		name: 'Bouncer enforcement',
		description: 'A remediation component applies active CrowdSec decisions to this site.'
	},
	{
		id: 'waf',
		code: 'T5',
		column: 'WAF',
		name: 'AppSec WAF',
		description: 'CrowdSec AppSec inspects matching requests inline before they reach the app.'
	},
	{
		id: 'edge',
		code: 'T6',
		column: 'Edge',
		name: 'Edge enforcement',
		description: 'Decisions are enforced at the CDN edge (e.g. Cloudflare) for this site.'
	}
];

export interface EvidenceItem {
	label: string;
	value: string;
}

export interface Fix {
	/** One-line title, e.g. "Enable JSON access logs in Caddy". */
	title: string;
	steps: string[];
	/** Optional config/command block shown verbatim. */
	code?: string;
}

export interface CheckResult {
	state: CheckState;
	/** ISO timestamp of the last measurement; null when never measured. */
	measuredAt: string | null;
	/** How the evidence was obtained, e.g. "CrowdSec metrics: parsers". */
	method: string | null;
	/** One-line finding. */
	summary: string;
	evidence: EvidenceItem[];
	/** What would move this check toward verified. */
	nextStep: string | null;
	fix: Fix | null;
}

export interface SiteRow {
	id: string;
	hostname: string;
	/** Proxy/runtime serving the site, e.g. "Caddy (Docker)". */
	proxy: string;
	checks: Record<TestId, CheckResult>;
}

/** Server-wide layer: engine, firewall, blocklist, LAPI. Applies to every site. */
export interface ServerCheck {
	id: string;
	label: string;
	state: CheckState;
	detail: string;
	measuredAt: string | null;
}

export type ObservationCode = 'C1' | 'C2' | 'FI' | 'C3';

/** Ordered as in inspection reports: C1 worst, C3 a recommendation. */
export const OBSERVATION_ORDER: readonly ObservationCode[] = ['C1', 'C2', 'FI', 'C3'];

export interface Observation {
	code: ObservationCode;
	title: string;
	detail: string;
	fix: Fix;
}

export interface Measurement {
	label: string;
	/** Exact value; null when the metric cannot be measured. */
	value: number | null;
	/** Why value is null — always set when value is null. Never report 0 for unmeasured. */
	unavailableReason?: string;
	/** Secondary annotation, e.g. "of which 21,286 from the community blocklist". */
	note?: string;
}

export interface ActivityPoint {
	/** ISO timestamp of the bucket start. */
	at: string;
	alerts: number;
	decisions: number;
}

export interface ScenarioCount {
	name: string;
	count: number;
}

/** Aggregated attack-origin point in map coordinates (equirectangular viewBox). */
export interface OverviewMapPoint {
	x: number;
	y: number;
	count: number;
}

export interface Verdict {
	state: CheckState;
	/** One-line overall finding, e.g. "Websites not protected". */
	label: string;
}

export interface OverviewData {
	/** Where the numbers came from. 'fixture' is always labeled in the UI. */
	source: 'fixture' | 'none' | 'live';
	server: {
		name: string | null;
		crowdsecVersion: string | null;
		lapi: string | null;
	};
	verdict: Verdict | null;
	/** ISO timestamp of the last completed inspection. */
	inspectedAt: string | null;
	serverChecks: ServerCheck[];
	sites: SiteRow[];
	observations: Observation[];
	measurements: Measurement[];
	activity: ActivityPoint[];
	topScenarios: ScenarioCount[];
	/** Attack origins from stored alert geo fields; empty when none carry lat/lon. */
	mapPoints: OverviewMapPoint[];
}
