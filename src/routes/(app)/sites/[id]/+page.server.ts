import { error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { site } from '#lib/server/db/app.schema.ts';
import { requirePermission, requireUser } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { hasPermission } from '#lib/roles.ts';
import { probeSite } from '#lib/server/protect/detect.ts';
import { listArtifacts, markArtifact, regeneratePlan } from '#lib/server/protect/plan.ts';
import { CHECKS, listChecks, markTestWindow, runSiteChecks } from '#lib/server/protect/checks.ts';
import { TEST_PATH } from '#lib/server/protect/templates.ts';

const PROXIES = ['caddy', 'traefik', 'nginx', 'other', 'unknown'] as const;
const RUNTIMES = ['native', 'docker', 'unknown'] as const;

async function loadSite(id: string) {
	const [s] = await db.select().from(site).where(eq(site.id, id)).limit(1);
	if (!s) error(404, 'Site not found.');
	return s;
}

export const load: PageServerLoad = async (event) => {
	const s = await loadSite(event.params.id);
	const [artifacts, checks] = await Promise.all([listArtifacts(db, s.id), listChecks(db, s.id)]);
	return {
		site: s,
		detection: s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : null,
		artifacts,
		checkDefs: CHECKS,
		checks: checks.map((c) => ({ ...c, evidence: c.evidence ? JSON.parse(c.evidence) : null })),
		testPath: TEST_PATH,
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate')
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

export const actions: Actions = {
	/** Update topology answers (proxy/runtime/cloudflare) and regenerate. */
	configure: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const formData = await event.request.formData();
		const proxy = text(formData, 'proxy');
		const runtime = text(formData, 'runtime');
		await db
			.update(site)
			.set({
				proxy: (PROXIES as readonly string[]).includes(proxy)
					? (proxy as (typeof PROXIES)[number])
					: s.proxy,
				runtime: (RUNTIMES as readonly string[]).includes(runtime)
					? (runtime as (typeof RUNTIMES)[number])
					: s.runtime,
				cloudflare: formData.get('cloudflare') === 'on'
			})
			.where(eq(site.id, s.id));
		await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.configured',
			detail: { hostname: s.hostname, proxy, runtime }
		});
		return { notice: 'Topology saved — artifacts regenerated.' };
	},

	/** Probe response headers (optionally a custom URL, e.g. an intranet vhost). */
	detect: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const formData = await event.request.formData();
		const d = await probeSite(s.hostname, text(formData, 'probeUrl') || undefined);
		await db
			.update(site)
			.set({
				proxy: d.proxy === 'unknown' ? s.proxy : d.proxy,
				cloudflare: d.cloudflare || s.cloudflare,
				detection: JSON.stringify(d)
			})
			.where(eq(site.id, s.id));
		if (d.proxy !== 'unknown') await regeneratePlan(db, s.id);
		await recordAudit({
			event,
			action: 'site.detected',
			detail: { hostname: s.hostname, proxy: d.proxy, cloudflare: d.cloudflare }
		});
		if (d.error) return { notice: `Probe failed: ${d.error}` };
		return {
			notice: `Probed ${d.probedUrl} — proxy: ${d.proxy}, cloudflare: ${d.cloudflare ? 'yes' : 'no'}.`
		};
	},

	/** Mark an artifact applied (guided mode — the admin did it by hand). */
	artifactState: async (event) => {
		requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const artifactId = text(formData, 'artifactId');
		const state = text(formData, 'state') === 'applied' ? 'applied' : 'not_applied';
		await markArtifact(db, artifactId, state);
		return { notice: state === 'applied' ? 'Marked applied.' : 'Marked not applied.' };
	},

	/** Open the test window, then the admin triggers the harmless test path. */
	markWindow: async (event) => {
		requireUser(event);
		const s = await loadSite(event.params.id);
		await markTestWindow(db, s.id);
		return { notice: `Test window opened — trigger the path below, then Run checks.` };
	},

	/** Run the automated checks for this site now. */
	runChecks: async (event) => {
		requireUser(event);
		const s = await loadSite(event.params.id);
		await runSiteChecks(db, s.id);
		return { notice: 'Checks re-run against the latest sync and metrics.' };
	},

	/** Manual confirmation for the real-IP check (guided, no automated probe). */
	confirmRealIp: async (event) => {
		requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const { protectionCheck } = await import('#lib/server/db/app.schema.ts');
		await db
			.insert(protectionCheck)
			.values({
				id: `${s.id}|real_ip`,
				siteId: s.id,
				checkId: 'real_ip',
				state: 'verified',
				evidence: JSON.stringify({ message: 'Confirmed manually by the administrator.' }),
				checkedAt: new Date(),
				updatedAt: new Date()
			})
			.onConflictDoUpdate({
				target: protectionCheck.id,
				set: {
					state: 'verified',
					evidence: JSON.stringify({ message: 'Confirmed manually by the administrator.' }),
					checkedAt: new Date(),
					updatedAt: new Date()
				}
			});
		return { notice: 'Real-IP check marked verified.' };
	}
};
