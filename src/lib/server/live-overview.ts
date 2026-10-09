/**
 * Live overview: maps the CrowdSec projection (alerts, decisions, sync
 * state, metric samples) into the Inspection Record shape. Read-only mode
 * cannot run the per-site protection tests, so the schedule reports N/C
 * with the phase-5 checks named as next steps — honest, never fabricated.
 */
import { desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import {
	activityRollup,
	alert,
	decision,
	metricSample,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import type { ServerRecord } from '#lib/server/crowdsec/connection.ts';
import type {
	ActivityPoint,
	CheckResult,
	Measurement,
	Observation,
	OverviewData,
	ScenarioCount,
	ServerCheck,
	SiteRow
} from '#lib/overview/types.ts';
import { TESTS } from '#lib/overview/types.ts';

type Db = typeof db;

const notMeasured = (name: string): CheckResult => ({
	state: 'not_configured',
	measuredAt: null,
	method: null,
	summary: 'Not measured in read-only monitoring.',
	evidence: [],
	nextStep: `${name} is verified by the guided checks (per-site inspection).`,
	fix: null
});

const ncChecks = () =>
	Object.fromEntries(TESTS.map((t) => [t.id, notMeasured(t.name)])) as SiteRow['checks'];

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

export async function liveOverview(
	database: Db,
	srv: ServerRecord,
	rangeHours = 24
): Promise<OverviewData> {
	const now = new Date();
	const windowStart = new Date(now.getTime() - rangeHours * 3_600_000);

	const sync = await database.select().from(syncState);
	const alertsSync = sync.find((s) => s.source === 'alerts');
	const metricsSync = sync.find((s) => s.source === 'metrics');
	const alertsStale =
		!alertsSync?.lastSuccessAt || now.getTime() - alertsSync.lastSuccessAt.getTime() > 120_000;
	const metricsStale =
		!metricsSync?.lastSuccessAt || now.getTime() - metricsSync.lastSuccessAt.getTime() > 300_000;

	const serverChecks: ServerCheck[] = [
		{
			id: 'lapi',
			label: 'LAPI connection',
			state: alertsSync?.lastError ? 'failed' : alertsStale ? 'stale' : 'verified',
			detail: alertsSync?.lastError
				? `Sync failing: ${alertsSync.lastError}`
				: `Last sync ${alertsSync?.lastSuccessAt ? 'ok' : 'pending'}`,
			measuredAt: iso(alertsSync?.lastSuccessAt)
		},
		{
			id: 'metrics',
			label: 'Metrics endpoint',
			state: !srv.metricsUrl
				? 'not_configured'
				: metricsSync?.lastError
					? 'failed'
					: metricsStale
						? 'stale'
						: 'verified',
			detail: !srv.metricsUrl
				? 'Not configured — counters and version unavailable'
				: (metricsSync?.lastError ?? 'Scraping'),
			measuredAt: iso(metricsSync?.lastSuccessAt)
		},
		{
			id: 'sync',
			label: 'Alert projection',
			state: alertsSync?.partial ? 'stale' : alertsStale ? 'stale' : 'verified',
			detail: alertsSync?.partial
				? 'Historical import still catching up — counts are partial'
				: 'Projection follows the LAPI cursor',
			measuredAt: iso(alertsSync?.lastSuccessAt)
		}
	];

	const sites = await database.select().from(site).orderBy(site.hostname);
	const siteRows: SiteRow[] = sites.map((s) => ({
		id: s.id,
		hostname: s.hostname,
		proxy: 'unknown — discovery arrives with the guided setup',
		checks: ncChecks()
	}));

	// Measurements
	const [alerts24] = await database
		.select({ n: sql<number>`count(*)` })
		.from(alert)
		.where(gte(alert.startedAt, windowStart));
	const [activeDecisions] = await database
		.select({ n: sql<number>`count(*)` })
		.from(decision)
		.where(eq(decision.expired, false));
	const [unattributed] = await database
		.select({ n: sql<number>`count(*)` })
		.from(alert)
		.where(
			sql`${alert.startedAt} >= ${windowStart} AND NOT EXISTS (SELECT 1 FROM alert_site WHERE alert_site.alert_upstream_id = ${alert.upstreamId})`
		);

	// Community blocklist volume from the freshest active-decisions samples.
	const capiSamples = await database
		.select({ labels: metricSample.labels, value: metricSample.value, at: metricSample.at })
		.from(metricSample)
		.where(eq(metricSample.name, 'cs_active_decisions'))
		.orderBy(desc(metricSample.at))
		.limit(40);
	const latestAt = capiSamples[0]?.at?.getTime() ?? 0;
	const byOrigin: Record<string, number> = {};
	for (const s of capiSamples.filter((x) => x.at.getTime() === latestAt)) {
		const labels = s.labels ? (JSON.parse(s.labels) as Record<string, string>) : {};
		const origin = labels.origin ?? 'unknown';
		byOrigin[origin] = (byOrigin[origin] ?? 0) + s.value;
	}
	const capiCount = byOrigin['CAPI'] ?? 0;

	const measurements: Measurement[] = [
		{ label: `Alerts (${rangeHours}h)`, value: alerts24.n },
		{
			label: 'Active decisions (local)',
			value: activeDecisions.n,
			note: capiCount
				? `${capiCount.toLocaleString()} more from the community blocklist`
				: undefined
		},
		{
			label: 'Community blocklist',
			value: srv.metricsUrl ? capiCount : null,
			unavailableReason: srv.metricsUrl ? undefined : 'metrics endpoint not configured'
		},
		{
			label: `Unattributed alerts (${rangeHours}h)`,
			value: unattributed.n,
			note: unattributed.n ? 'site signal missing — see observations' : 'all alerts attributed'
		}
	];

	// Activity + scenarios from rollups in the window.
	const rollups = await database
		.select({
			hour: activityRollup.hour,
			count: sql<number>`sum(${activityRollup.count})`,
			scenario: activityRollup.scenario
		})
		.from(activityRollup)
		.where(gte(activityRollup.hour, new Date(now.getTime() - 24 * 3_600_000)))
		.groupBy(activityRollup.hour, activityRollup.scenario)
		.orderBy(activityRollup.hour);

	const byHour = new Map<number, ActivityPoint>();
	for (const r of rollups) {
		const key = r.hour.getTime();
		const p = byHour.get(key) ?? { at: new Date(key).toISOString(), alerts: 0, decisions: 0 };
		p.alerts += r.count;
		byHour.set(key, p);
	}
	// Decisions-per-hour: count decisions whose alert was created that hour is
	// overkill for v0.1 — decisions mirror alert volume, shown separately below.
	const activity = [...byHour.values()].sort((a, b) => a.at.localeCompare(b.at));

	const scenarioRows = await database
		.select({ scenario: alert.scenario, n: sql<number>`count(*)` })
		.from(alert)
		.where(gte(alert.startedAt, windowStart))
		.groupBy(alert.scenario)
		.orderBy(sql`count(*) desc`)
		.limit(8);
	const topScenarios: ScenarioCount[] = scenarioRows.map((r) => ({
		name: (r.scenario ?? 'unknown').replace(/^crowdsecurity\//, ''),
		count: r.n
	}));

	const observations: Observation[] = [];
	if (alertsSync?.lastError) {
		observations.push({
			code: 'C2',
			title: 'Alert sync is failing',
			detail: `The dashboard cannot reach the LAPI: ${alertsSync.lastError}. Cached data is shown; the age column marks staleness.`,
			fix: {
				title: 'Restore LAPI reachability',
				steps: [
					'Check that CrowdSec is running: systemctl status crowdsec',
					'Confirm the LAPI listens on the configured address (lapi_url in settings).',
					'Re-test credentials on the CrowdSec connection page.'
				],
				code: 'sudo systemctl status crowdsec\nsudo cscli lapi status'
			}
		});
	}
	if (unattributed.n > 0) {
		observations.push({
			code: 'C2',
			title: `${unattributed.n} alert${unattributed.n === 1 ? '' : 's'} could not be attributed to a site`,
			detail:
				'CrowdSec does not label alerts with a website by default. Install the http_extended context and make the proxy log format carry the hostname.',
			fix: {
				title: 'Enable per-site attribution',
				steps: [
					'Install the extended HTTP context so alerts carry target_fqdn.',
					'Log the hostname: Caddy JSON logs already include request.host; for Traefik use JSON access logs; for Nginx add $host to the log format.',
					'Reload CrowdSec; new alerts attribute automatically.'
				],
				code: 'sudo cscli contexts install crowdsecurity/http_extended\nsudo systemctl reload crowdsec'
			}
		});
	}
	if (alertsSync?.partial) {
		observations.push({
			code: 'FI',
			title: 'Historical import in progress',
			detail:
				'The first sync is paging through the last 30 days of alerts. Counts and charts fill in as it catches up.',
			fix: {
				title: 'Nothing to do',
				steps: ['The import finishes on its own; this notice clears when it does.']
			}
		});
	}
	observations.push({
		code: 'FI',
		title: 'Monitoring is read-only',
		detail:
			'The watcher credential cannot change CrowdSec configuration. Per-site protection checks (logs, parsing, bouncer, WAF) need the guided setup.',
		fix: {
			title: 'What unlocks the protection tests',
			steps: [
				'Connect mode measures only what LAPI exposes: alerts, decisions, metrics.',
				'Guided setup (coming in v0.3) generates the log and bouncer configuration per site.',
				'Until then the schedule columns read N/C — not "failing".'
			]
		}
	});

	const overall = alertsSync?.lastError ? 'degraded' : alertsStale ? 'stale' : 'verified';
	return {
		source: 'live',
		server: {
			name: srv.name,
			crowdsecVersion: srv.crowdsecVersion,
			lapi: srv.lapiUrl
		},
		verdict: {
			state: overall,
			label:
				overall === 'verified'
					? `Monitoring — ${alerts24.n} alerts in ${rangeHours}h`
					: overall === 'degraded'
						? 'Sync failing — showing cached data'
						: 'Sync stale — data may be behind'
		},
		inspectedAt: iso(alertsSync?.lastSuccessAt ?? metricsSync?.lastSuccessAt),
		serverChecks,
		sites: siteRows,
		observations,
		measurements,
		activity,
		topScenarios
	};
}
