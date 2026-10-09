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
import { agentHello } from '#lib/server/agent/client.ts';
import { enqueue } from '#lib/server/jobs/queue.ts';

const PROXIES = ['caddy', 'traefik', 'nginx', 'other', 'unknown'] as const;
const RUNTIMES = ['native', 'docker', 'unknown'] as const;

async function loadSite(id: string) {
	const [s] = await db.select().from(site).where(eq(site.id, id)).limit(1);
	if (!s) error(404, 'Site not found.');
	return s;
}

export const load: PageServerLoad = async (event) => {
	const s = await loadSite(event.params.id);
	const [artifacts, checks, hello] = await Promise.all([
		listArtifacts(db, s.id),
		listChecks(db, s.id),
		agentHello()
	]);
	// Managed apply is offered only for complete-file artifacts that declare
	// a `# /path` target line — fragments (Caddyfile snippets, compose
	// blocks) stay guided because merging is a per-host decision.
	const MANAGED_KINDS = new Set(['acquisition']);
	return {
		site: s,
		detection: s.detection ? (JSON.parse(s.detection) as Record<string, unknown>) : null,
		artifacts: artifacts.map((a) => ({
			...a,
			target: a.content.match(/^# (\/\S+)$/m)?.[1] ?? null,
			managed: !!hello?.caps.files && MANAGED_KINDS.has(a.kind)
		})),
		agent: hello,
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
	},

	/** Tier D: install the plan's hub items through the agent as a job. */
	installCollections: async (event) => {
		const user = requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.cscli) return { notice: 'Agent with a cscli bridge is not connected.' };
		const [collections] = (await listArtifacts(db, s.id)).filter((a) => a.kind === 'collections');
		if (!collections) return { notice: 'No collections artifact for this site.' };
		const items = [
			...collections.content.matchAll(
				/cscli (collections|parsers|scenarios|contexts|appsec-rules) install (\S+)/g
			)
		].map((m) => `${m[1]}:${m[2]}`);
		if (!items.length) return { notice: 'No installable items found in the artifact.' };
		const { created } = await enqueue(db, {
			kind: 'hub.install',
			params: { items },
			idempotencyKey: `hub.install:${collections.id}:${collections.contentHash}`,
			lockKey: 'hub',
			siteId: s.id,
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'hub.install', hostname: s.hostname, items: items.length }
		});
		return {
			notice: created
				? `Queued install of ${items.length} hub items — watch System → Jobs.`
				: 'That install is already queued for this artifact version.'
		};
	},

	/** Tier D: managed apply of a complete-file artifact (backup → write → reload). */
	applyArtifact: async (event) => {
		const user = requirePermission(event, 'operate');
		const s = await loadSite(event.params.id);
		const hello = await agentHello(true);
		if (!hello?.caps.files) return { notice: 'Agent file access is not configured.' };
		const formData = await event.request.formData();
		const artifactId = text(formData, 'artifactId');
		const [a] = (await listArtifacts(db, s.id)).filter((x) => x.id === artifactId);
		const target = a?.content.match(/^# (\/\S+)$/m)?.[1];
		if (!a || a.kind !== 'acquisition' || !target)
			return { notice: 'Only complete-file artifacts with a declared target can be applied.' };
		const { created, job: j } = await enqueue(db, {
			kind: 'config.apply',
			// artifactId lets the job mark the artifact applied only on success.
			params: { path: target, content: a.content, artifactId: a.id },
			idempotencyKey: `apply:${a.id}:${a.contentHash}`,
			lockKey: `file:${target}`,
			siteId: s.id,
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'config.apply', hostname: s.hostname, path: target, jobId: j.id }
		});
		return {
			notice: created
				? `Queued managed apply to ${target} — backup + write via the agent.`
				: 'That artifact version is already applied or queued.'
		};
	}
};
