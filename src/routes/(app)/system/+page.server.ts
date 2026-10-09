import type { Actions, PageServerLoad } from './$types';
import { desc } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { audit } from '#lib/server/db/app.schema.ts';
import { agentConfigured, agentHello, callAgent } from '#lib/server/agent/client.ts';
import { enqueue, jobDetail, listJobs, requestCancel } from '#lib/server/jobs/queue.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { hasPermission } from '#lib/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';

export const load: PageServerLoad = async (event) => {
	const [hello, jobs, recentAudit] = await Promise.all([
		agentHello(),
		listJobs(db, 50),
		db.select().from(audit).orderBy(desc(audit.at)).limit(30)
	]);

	let machines: unknown[] = [];
	let bouncers: unknown[] = [];
	let hubItems: unknown[] = [];
	const simulation: { global: boolean | null; items: Record<string, boolean> } = {
		global: null,
		items: {}
	};
	let tierDError: string | null = null;
	if (hello?.caps.cscli) {
		const [m, b, h, sim] = await Promise.all([
			callAgent<unknown[]>('machines.list'),
			callAgent<unknown[]>('bouncers.list'),
			callAgent<unknown[]>('hub.list'),
			callAgent<Record<string, unknown>>('simulation.status')
		]);
		if (m.ok && Array.isArray(m.result)) machines = m.result;
		if (b.ok && Array.isArray(b.result)) bouncers = b.result;
		// `cscli hub list -o json` is an object keyed by item type; flatten.
		if (h.ok) {
			const raw = h.result;
			hubItems = Array.isArray(raw)
				? raw
				: raw && typeof raw === 'object'
					? Object.entries(raw as Record<string, unknown[]>).flatMap(([type, items]) =>
							Array.isArray(items)
								? items.map((i) =>
										i && typeof i === 'object' ? { type, ...i } : { type, name: i }
									)
								: []
						)
					: [];
		}
		// cscli versions differ on this payload — normalize defensively.
		if (sim.ok && sim.result && typeof sim.result === 'object') {
			const r = sim.result as Record<string, unknown>;
			const g = r.simulation_mode ?? r.simulation ?? r.global;
			simulation.global = typeof g === 'boolean' ? g : g === 'enabled' ? true : null;
			const items = r.items ?? r.scenarios;
			if (Array.isArray(items)) {
				for (const i of items) if (typeof i === 'string') simulation.items[i] = true;
			} else if (items && typeof items === 'object') {
				for (const [k, v] of Object.entries(items)) simulation.items[k] = !!v;
			}
		}
		if (!m.ok) tierDError = m.error.message;
		else if (!b.ok) tierDError = b.error.message;
		else if (!h.ok) tierDError = h.error.message;
	}

	return {
		agent: hello,
		agentConfigured: agentConfigured(),
		machines,
		bouncers,
		hubItems: hubItems.slice(0, 40),
		hubCount: hubItems.length,
		simulation,
		tierDError,
		jobs,
		recentAudit,
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate')
	};
};

export const actions: Actions = {
	/** Cancel a queued/running job at the next step boundary. */
	cancelJob: async (event) => {
		requirePermission(event, 'operate');
		const jobId = (await event.request.formData()).get('jobId')?.toString() ?? '';
		const ok = await requestCancel(db, jobId);
		if (ok) await recordAudit({ event, action: 'job.cancelled', detail: { jobId } });
		return { notice: ok ? 'Cancel requested.' : 'Job already finished.' };
	},

	/** Re-submit a finished job under a fresh idempotency key. */
	runAgain: async (event) => {
		const user = requirePermission(event, 'operate');
		const jobId = (await event.request.formData()).get('jobId')?.toString() ?? '';
		const d = await jobDetail(db, jobId);
		if (!d) return { notice: 'Job not found.' };
		await enqueue(db, {
			kind: d.job.kind,
			params: JSON.parse(d.job.params),
			lockKey: d.job.lockKey ?? undefined,
			siteId: d.job.siteId ?? undefined,
			createdBy: user.id
		});
		await recordAudit({ event, action: 'job.resubmitted', detail: { jobId, kind: d.job.kind } });
		return { notice: 'Job re-queued.' };
	},

	/**
	 * Per-scenario or global simulation toggle (spec §5.7) — runs as a
	 * durable job so the change is audited and resumable.
	 */
	simulate: async (event) => {
		const user = requirePermission(event, 'operate');
		const hello = await agentHello(true);
		if (!hello?.caps.cscli) return { notice: 'Agent with a cscli bridge is not connected.' };
		const formData = await event.request.formData();
		const scope = formData.get('scope')?.toString().trim() || undefined;
		const enabled = formData.get('enabled') === '1';
		const { created, job } = await enqueue(db, {
			kind: 'simulation.set',
			params: { enabled, scope },
			idempotencyKey: `sim:${scope ?? '*'}:${enabled}`,
			lockKey: 'simulation',
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'simulation.set', scope: scope ?? 'global', enabled, jobId: job.id }
		});
		return {
			notice: created
				? `Queued simulation ${enabled ? 'enable' : 'disable'}${scope ? ` for ${scope}` : ''}.`
				: 'That simulation change is already queued.'
		};
	}
};
