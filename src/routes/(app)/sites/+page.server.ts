import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { alert, alertSite, protectionCheck, site } from '#lib/server/db/app.schema.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { hasPermission } from '#lib/roles.ts';
import { probeSite } from '#lib/server/protect/detect.ts';
import { regeneratePlan } from '#lib/server/protect/plan.ts';
import { CHECKS } from '#lib/server/protect/checks.ts';

const PROXIES = ['caddy', 'traefik', 'nginx', 'other', 'unknown'] as const;
const RUNTIMES = ['native', 'docker', 'unknown'] as const;

function validHostname(h: string): boolean {
	return (
		/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(h) &&
		h.length <= 253 &&
		!h.includes('..') &&
		h.includes('.')
	);
}

export const load: PageServerLoad = async (event) => {
	const sites = await db.select().from(site).orderBy(site.hostname);
	// Per-site: latest attributed alert + verified-check count for the row.
	const lastAlerts = await db
		.select({ siteId: alertSite.siteId, lastAt: sql<number>`max(${alert.startedAt})` })
		.from(alertSite)
		.innerJoin(alert, eq(alert.upstreamId, alertSite.alertUpstreamId))
		.groupBy(alertSite.siteId);
	const lastAlertBySite = new Map(lastAlerts.map((r) => [r.siteId, r.lastAt]));
	const checks = await db.select().from(protectionCheck);
	const checkBySite = new Map<string, { verified: number; total: number }>();
	for (const c of checks) {
		const cur = checkBySite.get(c.siteId) ?? { verified: 0, total: 0 };
		cur.total += 1;
		if (c.state === 'verified') cur.verified += 1;
		checkBySite.set(c.siteId, cur);
	}
	return {
		checkIds: CHECKS.map((c) => ({ id: c.id, title: c.title })),
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate'),
		sites: sites.map((s) => ({
			...s,
			lastAlertAt: lastAlertBySite.get(s.id) ?? null,
			checks: checkBySite.get(s.id) ?? { verified: 0, total: 0 }
		}))
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

export const actions: Actions = {
	/** Add a site manually; learned sites appear automatically. */
	add: async (event) => {
		requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const hostname = text(formData, 'hostname').toLowerCase();
		if (!validHostname(hostname))
			return fail(400, { message: 'Enter a valid hostname (e.g. blog.example.com).' });
		const proxy = text(formData, 'proxy');
		const runtime = text(formData, 'runtime');
		const cloudflare = formData.get('cloudflare') === 'on';
		const id = crypto.randomUUID();
		try {
			await db.insert(site).values({
				id,
				hostname,
				source: 'manual',
				proxy: (PROXIES as readonly string[]).includes(proxy)
					? (proxy as (typeof PROXIES)[number])
					: 'unknown',
				runtime: (RUNTIMES as readonly string[]).includes(runtime)
					? (runtime as (typeof RUNTIMES)[number])
					: 'unknown',
				cloudflare
			});
		} catch {
			return fail(400, { message: `${hostname} is already known.` });
		}
		await regeneratePlan(db, id);
		await recordAudit({ event, action: 'site.added', detail: { hostname } });
		return { notice: `${hostname} added — artifacts generated on the site page.` };
	},

	/** Probe the site's public headers and store the inferred topology. */
	detect: async (event) => {
		requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const siteId = text(formData, 'siteId');
		const [s] = await db.select().from(site).where(eq(site.id, siteId)).limit(1);
		if (!s) return fail(404, { message: 'Site not found.' });
		const probeUrl = text(formData, 'probeUrl') || undefined;
		const d = await probeSite(s.hostname, probeUrl);
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

	remove: async (event) => {
		requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const siteId = text(formData, 'siteId');
		const [s] = await db.select().from(site).where(eq(site.id, siteId)).limit(1);
		if (!s) return fail(404, { message: 'Site not found.' });
		await db.delete(site).where(eq(site.id, siteId));
		await recordAudit({ event, action: 'site.removed', detail: { hostname: s.hostname } });
		return { notice: `${s.hostname} removed.` };
	}
};
