import { count, eq } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { CHECKS, protectionMatrix } from '#lib/server/protect/checks.ts';
import { getServer } from '#lib/server/crowdsec/connection.ts';
import { projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { configArtifact, notificationChannel } from '#lib/server/db/app.schema.ts';
import { requireUser } from '#lib/server/roles.ts';

export type WizardTarget = 'users' | 'crowdsec' | 'sites' | 'site' | 'notifications';
export type WizardStep = {
	id: string;
	title: string;
	detail: string;
	state: 'done' | 'current' | 'todo';
	target: WizardTarget | null;
	siteId?: string;
	hint?: string;
};

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const [srv, freshness, matrix, plannedRows, channelRows] = await Promise.all([
		getServer(db),
		projectionFreshness(db),
		protectionMatrix(db),
		db
			.select({ siteId: configArtifact.siteId })
			.from(configArtifact)
			.groupBy(configArtifact.siteId),
		db.select({ n: count() }).from(notificationChannel).where(eq(notificationChannel.enabled, true))
	]);

	const sites = matrix.map((r) => r.site);
	const siteCount = sites.length;
	// Detection is "answered" when a probe stored evidence or the admin set a
	// concrete proxy — a learned row with proxy 'unknown' is not topology data.
	const topologyKnown = matrix.some(
		(r) => r.site.detection !== null || (r.site.proxy !== 'unknown' && r.site.proxy !== null)
	);
	const plannedSiteIds = new Set(plannedRows.map((r) => r.siteId));
	const plannedCount = plannedSiteIds.size;

	// Step 6 passes when every site that has a plan has every check row
	// verified or not_applicable (real_ip included — manual confirm counts).
	const verifiedSites = matrix.filter((row) => {
		if (!plannedSiteIds.has(row.site.id)) return false;
		const byId = new Map(row.checks.map((c) => [c.checkId, c.state]));
		return CHECKS.every(
			(def) => byId.get(def.id) === 'verified' || byId.get(def.id) === 'not_applicable'
		);
	});
	const verifyDone =
		plannedCount > 0 &&
		verifiedSites.length === sites.filter((s) => plannedSiteIds.has(s.id)).length;
	const firstUnplanned = sites.find((s) => !plannedSiteIds.has(s.id));
	const firstPlanned = sites.find((s) => plannedSiteIds.has(s.id));

	const connected = srv.connected && !!freshness.lastSuccessAt;
	const notified = (channelRows[0]?.n ?? 0) > 0;

	// Spec 5.8 first-run wizard — resumable: every state derives from live
	// data, so leaving and returning resumes where things stand.
	const raw: Array<Omit<WizardStep, 'state'>> = [
		{
			id: 'admin',
			title: 'Create the administrator',
			detail: 'Done — you are signed in with a bootstrap-created account.',
			target: 'users'
		},
		{
			id: 'connect',
			title: 'Connect CrowdSec',
			detail: connected
				? 'LAPI watcher credential works and the projection is syncing.'
				: 'Register a read-only watcher, then save the URL and credentials.',
			target: 'crowdsec',
			hint: connected
				? undefined
				: 'cscli machines add bitdoze-dash --auto --url http://127.0.0.1:8080'
		},
		{
			id: 'topology',
			title: 'Detect topology',
			detail: topologyKnown
				? 'Proxy, runtime, and Cloudflare evidence recorded for at least one site.'
				: 'Probe each site’s public headers — or answer manually — to learn the proxy, runtime, and whether Cloudflare is in front.',
			target: 'sites'
		},
		{
			id: 'sites',
			title: 'Add sites',
			detail: siteCount
				? `${siteCount} site${siteCount === 1 ? '' : 's'} in the inventory.`
				: 'Add sites manually, or let alert context teach the inventory once CrowdSec is connected.',
			target: 'sites'
		},
		{
			id: 'plan',
			title: 'Build the protection plan',
			detail: plannedCount
				? `${plannedCount} site${plannedCount === 1 ? '' : 's'} have generated artifacts.`
				: 'Per-site artifacts: logging, acquisition, real-IP, bouncer, AppSec, and remediation presets.',
			target: firstUnplanned ? 'site' : 'sites',
			siteId: firstUnplanned?.id
		},
		{
			id: 'verify',
			title: 'Apply and verify',
			detail:
				plannedCount === 0
					? 'Generate a plan first — artifacts stay “not applied” until checks pass.'
					: verifyDone
						? 'Every planned site passes its checks.'
						: 'Apply the artifacts on the host, open the test window, then run the checks.',
			target: firstPlanned ? 'site' : 'sites',
			siteId: firstPlanned?.id
		},
		{
			id: 'notify',
			title: 'Configure notifications',
			detail: notified
				? 'At least one delivery channel is enabled.'
				: 'Add a channel so detections, outages, and admin actions reach you.',
			target: 'notifications'
		}
	];

	const doneById: Record<string, boolean> = {
		admin: true,
		connect: connected,
		topology: topologyKnown,
		sites: siteCount > 0,
		plan: plannedCount > 0,
		verify: verifyDone,
		notify: notified
	};
	let sawGap = false;
	const steps: WizardStep[] = raw.map((step) => {
		const done = doneById[step.id];
		const state = done ? 'done' : sawGap ? 'todo' : 'current';
		if (!done) sawGap = true;
		return { ...step, state };
	});

	return {
		connected: srv.connected,
		freshness,
		checkDefs: CHECKS,
		matrix,
		steps,
		progress: { done: steps.filter((s) => s.state === 'done').length, total: steps.length }
	};
};
