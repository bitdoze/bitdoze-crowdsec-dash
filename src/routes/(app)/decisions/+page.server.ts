import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { desc, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { decisionRequest } from '#lib/server/db/app.schema.ts';
import { listDecisions, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { buildClient, getServer } from '#lib/server/crowdsec/connection.ts';
import { reconcile, requestDecision, requestRemoval } from '#lib/server/crowdsec/decisions.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import { hasPermission } from '#lib/roles.ts';
import { isPrivateIp, normalizeTarget, parseDuration } from '#lib/ipaddr.ts';

export const load: PageServerLoad = async (event) => {
	const srv = await getServer(db);
	const freshness = await projectionFreshness(db);
	const list = await listDecisions(db, {
		q: event.url.searchParams.get('q') ?? undefined,
		includeExpired: event.url.searchParams.get('expired') === '1',
		page: Number(event.url.searchParams.get('page') ?? 1) || 1
	});
	// Reconcile pending requests against the freshest projection on load —
	// cheap (indexed lookups) and keeps the status column live.
	if (srv.connected) await reconcile(db).catch(() => undefined);
	const requests = await db
		.select()
		.from(decisionRequest)
		.where(
			sql`${decisionRequest.state} != 'removed' OR ${decisionRequest.updatedAt} > ${Date.now() - 86_400_000}`
		)
		.orderBy(desc(decisionRequest.createdAt))
		.limit(25);
	const clientIp = event.getClientAddress();
	return {
		connected: srv.connected,
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate'),
		freshness,
		list,
		requests,
		clientIp: { value: clientIp, private: isPrivateIp(clientIp) },
		filters: {
			q: event.url.searchParams.get('q') ?? '',
			expired: event.url.searchParams.get('expired') === '1'
		}
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

export const actions: Actions = {
	/** Manual ban/captcha — pushed upstream via POST /v1/alerts. */
	ban: async (event) => {
		const user = requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const target = normalizeTarget(text(formData, 'target'));
		if (!target) return fail(400, { message: 'Enter a valid IPv4/IPv6 address or CIDR range.' });
		const type = text(formData, 'type');
		if (type !== 'ban' && type !== 'captcha')
			return fail(400, { message: 'Decision type must be ban or captcha.' });
		const durationS = parseDuration(text(formData, 'duration'));
		if (!durationS)
			return fail(400, { message: 'Duration must be like 4h, 4h30m, 90m, or 2d (max 30d).' });
		const reason = text(formData, 'reason') || undefined;

		const client = await buildClient(db);
		if (!client) return fail(400, { message: 'Not connected to a LAPI.' });
		const res = await requestDecision(db, client, {
			...target,
			type,
			durationS,
			reason,
			userId: user.id
		});
		if (!res.ok) return fail(400, { message: `Decision rejected: ${res.error}` });
		await recordAudit({
			event,
			action: 'decision.create',
			detail: { scope: target.scope, value: target.value, type, durationS }
		});
		return {
			notice: `${type === 'ban' ? 'Ban' : 'Captcha'} requested for ${target.value} — pending upstream confirmation.`
		};
	},

	/** Remove an active upstream decision by id. */
	unban: async (event) => {
		const user = requirePermission(event, 'operate');
		const formData = await event.request.formData();
		const upstreamId = Number(formData.get('upstreamId'));
		const value = text(formData, 'value');
		if (!Number.isInteger(upstreamId) || !value)
			return fail(400, { message: 'Missing decision id.' });
		const client = await buildClient(db);
		if (!client) return fail(400, { message: 'Not connected to a LAPI.' });
		const res = await requestRemoval(db, client, upstreamId, value, user.id);
		if (!res.ok) return fail(400, { message: `Unban failed: ${res.error}` });
		await recordAudit({
			event,
			action: 'decision.remove',
			detail: { upstreamId, value }
		});
		return { notice: `Removal requested for ${value} — reconciles on the next sync.` };
	},

	/**
	 * Allowlist writes need cscli on the host (tier D) — until the agent
	 * exists this returns the exact command to run, then Verify.
	 */
	allowlistMe: async (event) => {
		requirePermission(event, 'operate');
		const ip = event.getClientAddress();
		return {
			guide: {
				title: `Allowlist ${ip} on the server`,
				steps: [
					'Run the command on the CrowdSec host — allowlists are managed by cscli, not the LAPI.',
					'Reload or restart CrowdSec, then use the allowlist check on the IP page to verify.'
				],
				code: `sudo cscli allowlists create dashboard-admin --description "dashboard admin ip"\nsudo cscli allowlists add dashboard-admin ${ip}\nsudo systemctl reload crowdsec`
			}
		};
	}
};
