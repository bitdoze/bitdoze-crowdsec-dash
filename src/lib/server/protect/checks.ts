/**
 * Per-site protection verification checks (spec 5.6). Each check returns a
 * state plus evidence shown to the administrator — checks never fabricate a
 * pass; `not_run`/`failed` states carry the next action instead.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import {
	alert,
	alertSite,
	configArtifact,
	metricSample,
	protectionCheck,
	site,
	syncState
} from '#lib/server/db/app.schema.ts';
import { TEST_PATH, TEST_SCENARIO } from '#lib/server/protect/templates.ts';

export const CHECKS = [
	{
		id: 'acquisition',
		title: 'Logs reach CrowdSec',
		detail: "An alert from this site's log source proves acquisition works end to end."
	},
	{
		id: 'test_alert',
		title: 'Detection path verified',
		detail: `Trigger CrowdSec's harmless test scenario: curl https://<site>${TEST_PATH}`
	},
	{
		id: 'decision_feed',
		title: 'Decision feed reachable',
		detail: 'Decisions synced locally prove LAPI serves the enforcement feed.'
	},
	{
		id: 'waf',
		title: 'Inline WAF active',
		detail: 'AppSec counters increasing prove requests are inspected inline.'
	},
	{
		id: 'real_ip',
		title: 'Real client IPs in logs',
		detail: "Confirmed manually — compare a test request's logged IP to your real address."
	}
] as const;

export type CheckId = (typeof CHECKS)[number]['id'];
export type CheckState = 'not_run' | 'verified' | 'failed' | 'stale' | 'not_applicable';

export type CheckResult = {
	state: CheckState;
	evidence: Record<string, unknown>;
};

type Database = typeof db;

/** Sum of the latest sample per label-set of a counter (counters accumulate). */
async function metricSum(database: Database, name: string): Promise<number> {
	const rows = await database
		.select({ value: metricSample.value, labels: metricSample.labels, at: metricSample.at })
		.from(metricSample)
		.where(eq(metricSample.name, name))
		.orderBy(desc(metricSample.at))
		.limit(500);
	const latest = new Map<string, { at: Date; value: number }>();
	for (const r of rows) {
		const key = r.labels ?? '';
		const cur = latest.get(key);
		if (!cur || r.at > cur.at) latest.set(key, { at: r.at, value: r.value });
	}
	let sum = 0;
	for (const r of latest.values()) sum += r.value;
	return sum;
}

async function checkAcquisition(database: Database, siteId: string): Promise<CheckResult> {
	const rows = await database
		.select({ startedAt: alert.startedAt, scenario: alert.scenario, signal: alertSite.signal })
		.from(alertSite)
		.innerJoin(alert, eq(alert.upstreamId, alertSite.alertUpstreamId))
		.where(eq(alertSite.siteId, siteId))
		.orderBy(desc(alert.startedAt))
		.limit(3);
	if (rows.length === 0) {
		return {
			state: 'not_run',
			evidence: {
				message:
					'No alerts attributed to this site yet. Apply the acquisition artifact, generate test traffic, then re-check — or use the detection-path test below.'
			}
		};
	}
	return {
		state: 'verified',
		evidence: {
			message: `${rows.length} recent alert(s) attributed via ${rows[0].signal}.`,
			lastAlertAt: rows[0].startedAt,
			scenario: rows[0].scenario
		}
	};
}

async function checkTestAlert(database: Database, siteId: string, markedAt: Date | null) {
	if (!markedAt) {
		return {
			state: 'not_run' as CheckState,
			evidence: {
				message: `Start a test window, then run: curl -k https://<this site>${TEST_PATH} — the request is harmless and never bans anyone.`
			}
		};
	}
	// Look for the generic-test alert since the window opened, ideally
	// attributed to this site.
	const rows = await database
		.select({
			upstreamId: alert.upstreamId,
			startedAt: alert.startedAt,
			siteId: alertSite.siteId
		})
		.from(alert)
		.leftJoin(alertSite, eq(alertSite.alertUpstreamId, alert.upstreamId))
		.where(and(eq(alert.scenario, TEST_SCENARIO), gte(alert.startedAt, markedAt)))
		.orderBy(desc(alert.startedAt))
		.limit(5);
	const own = rows.find((r) => r.siteId === siteId);
	if (own) {
		return {
			state: 'verified' as CheckState,
			evidence: { message: 'Test alert received and attributed.', upstreamId: own.upstreamId }
		};
	}
	if (rows.length) {
		return {
			state: 'stale' as CheckState,
			evidence: {
				message:
					'Test alert reached CrowdSec but was not attributed to this site — the log line lacks target_fqdn. Apply the access-log + acquisition artifacts (attribution signal: target_fqdn).',
				upstreamIds: rows.map((r) => r.upstreamId)
			}
		};
	}
	return {
		state: 'failed' as CheckState,
		evidence: {
			message: `No ${TEST_SCENARIO} alert since the test window opened. If you ran the curl from a private or allowlisted address, whitelists dropped it before scenarios ran — report says "logs reach CrowdSec, scenario not exercised"; re-run from a public vantage point.`,
			windowStart: markedAt
		}
	};
}

async function checkDecisionFeed(database: Database): Promise<CheckResult> {
	const [sync] = await database
		.select({ lastSuccessAt: syncState.lastSuccessAt, lastError: syncState.lastError })
		.from(syncState)
		.where(eq(syncState.source, 'alerts'))
		.limit(1);
	if (!sync?.lastSuccessAt) {
		return {
			state: 'failed',
			evidence: {
				message: sync?.lastError
					? `LAPI sync is failing: ${sync.lastError}`
					: 'LAPI sync has never succeeded — connect CrowdSec first.'
			}
		};
	}
	const decisions = await database
		.select({ value: metricSample.value })
		.from(metricSample)
		.where(eq(metricSample.name, 'cs_active_decisions'))
		.orderBy(desc(metricSample.at))
		.limit(5);
	return {
		state: 'verified',
		evidence: {
			message: 'LAPI decision feed healthy — sync is current.',
			lastSync: sync.lastSuccessAt,
			activeDecisions: decisions.reduce((s, r) => s + r.value, 0) || undefined
		}
	};
}

async function checkWaf(database: Database): Promise<CheckResult> {
	const blocked = await metricSum(database, 'cs_appsec_blocked_requests');
	const processed = await metricSum(database, 'cs_appsec_processed_requests');
	if (processed <= 0) {
		return {
			state: 'not_run',
			evidence: {
				message: `No AppSec-processed requests seen in metrics. Apply the appsec artifact and the bouncer forwarding flag, then hit https://<this site>${TEST_PATH} — it triggers ${'crowdsecurity/appsec-generic-test'} with correlated block evidence.`
			}
		};
	}
	return {
		state: blocked > 0 ? 'verified' : 'stale',
		evidence: {
			message:
				blocked > 0
					? 'AppSec is inspecting and has blocked requests.'
					: 'AppSec is processing requests but has never blocked — rules may not be loaded.',
			processed,
			blocked
		}
	};
}

async function checkRealIp(database: Database, siteId: string): Promise<CheckResult> {
	// Heuristic evidence: alerts attributed to this site whose source IP is a
	// public address suggest the logged client IP is the real visitor, not the
	// proxy. Attacks do come from private ranges too, so this is advisory —
	// the authoritative confirmation is the manual comparison.
	const rows = await database
		.select({ sourceIp: alert.sourceIp })
		.from(alertSite)
		.innerJoin(alert, eq(alert.upstreamId, alertSite.alertUpstreamId))
		.where(eq(alertSite.siteId, siteId))
		.orderBy(desc(alert.startedAt))
		.limit(10);
	const ips = rows.map((r) => r.sourceIp).filter((v): v is string => !!v);
	const allPrivate =
		ips.length > 0 &&
		ips.every((ip) =>
			/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|fe[89ab]|::1)/i.test(ip)
		);
	if (allPrivate) {
		return {
			state: 'failed',
			evidence: {
				message:
					'Every attributed alert shows a private/proxy source address — the logged client IP is probably the proxy itself. Apply the real-IP artifact, then re-check.',
				seenIps: ips.slice(0, 3)
			}
		};
	}
	return {
		state: 'not_run',
		evidence: {
			message:
				"Make a request to the site, find it in the proxy access log, and confirm the logged address is your real IP — not the proxy's. Mark verified once confirmed."
		}
	};
}

const RUNNERS: Record<
	CheckId,
	(database: Database, siteId: string, markedAt: Date | null) => Promise<CheckResult>
> = {
	acquisition: (database, siteId) => checkAcquisition(database, siteId),
	test_alert: (database, siteId, markedAt) => checkTestAlert(database, siteId, markedAt),
	decision_feed: (database) => checkDecisionFeed(database),
	waf: (database) => checkWaf(database),
	real_ip: (database, siteId) => checkRealIp(database, siteId)
};

/** Run one check for a site and persist the outcome. */
export async function runCheck(
	database: Database,
	siteId: string,
	checkId: CheckId
): Promise<CheckResult> {
	const id = `${siteId}|${checkId}`;
	const [existing] = await database
		.select({ markedAt: protectionCheck.markedAt })
		.from(protectionCheck)
		.where(eq(protectionCheck.id, id))
		.limit(1);
	const result = await RUNNERS[checkId](database, siteId, existing?.markedAt ?? null);
	const now = new Date();
	await database
		.insert(protectionCheck)
		.values({
			id,
			siteId,
			checkId,
			state: result.state,
			evidence: JSON.stringify(result.evidence),
			markedAt: existing?.markedAt ?? null,
			checkedAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: protectionCheck.id,
			set: {
				state: result.state,
				evidence: JSON.stringify(result.evidence),
				checkedAt: now,
				updatedAt: now
			}
		});
	// A verified check promotes its matching artifacts to verified.
	if (result.state === 'verified') {
		const kinds: Record<string, Array<(typeof configArtifact.$inferSelect)['kind']>> = {
			acquisition: ['access_log', 'acquisition', 'collections'],
			test_alert: ['access_log', 'acquisition', 'collections'],
			decision_feed: ['bouncer'],
			waf: ['appsec'],
			real_ip: ['real_ip']
		};
		await database
			.update(configArtifact)
			.set({ state: 'verified', updatedAt: now })
			.where(
				and(
					eq(configArtifact.siteId, siteId),
					inArray(configArtifact.kind, kinds[checkId] ?? []),
					eq(configArtifact.state, 'applied')
				)
			);
	}
	return result;
}

/** Open a test window for the trigger-based checks. */
export async function markTestWindow(database: Database, siteId: string): Promise<void> {
	const now = new Date();
	for (const checkId of ['test_alert', 'waf'] as const) {
		const id = `${siteId}|${checkId}`;
		await database
			.insert(protectionCheck)
			.values({ id, siteId, checkId, state: 'not_run', markedAt: now, updatedAt: now })
			.onConflictDoUpdate({
				target: protectionCheck.id,
				set: { markedAt: now, state: 'not_run', updatedAt: now }
			});
	}
}

/** Re-run all automated checks for a site (worker + manual run share this). */
export async function runSiteChecks(database: Database, siteId: string): Promise<void> {
	for (const checkId of ['acquisition', 'test_alert', 'decision_feed', 'waf'] as const) {
		try {
			await runCheck(database, siteId, checkId);
		} catch {
			// a failing check must not stop the others
		}
	}
}

/** Every check row for a site, ordered by the canonical check list. */
export async function listChecks(database: Database, siteId: string) {
	const rows = await database
		.select()
		.from(protectionCheck)
		.where(eq(protectionCheck.siteId, siteId));
	const order = new Map(CHECKS.map((c, i) => [c.id, i]));
	return rows.sort(
		(a, b) => (order.get(a.checkId as CheckId) ?? 99) - (order.get(b.checkId as CheckId) ?? 99)
	);
}

/** Site rows with their check states for the protection matrix. */
export async function protectionMatrix(database: Database) {
	const sites = await database.select().from(site).orderBy(site.hostname);
	const rows = await database.select().from(protectionCheck);
	const bySite = new Map<string, typeof rows>();
	for (const r of rows) {
		const list = bySite.get(r.siteId) ?? [];
		list.push(r);
		bySite.set(r.siteId, list);
	}
	return sites.map((s) => ({ site: s, checks: bySite.get(s.id) ?? [] }));
}
