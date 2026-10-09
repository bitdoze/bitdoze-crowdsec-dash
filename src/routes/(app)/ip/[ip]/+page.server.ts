import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { ipDetail, projectionFreshness } from '#lib/server/crowdsec/lists.ts';
import { buildClient, getBouncerKey, getServer } from '#lib/server/crowdsec/connection.ts';
import { LapiError } from '#lib/server/crowdsec/client.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { isPrivateIp } from '#lib/ipaddr.ts';
import { hasPermission } from '#lib/roles.ts';

export const load: PageServerLoad = async (event) => {
	const srv = await getServer(db);
	const freshness = await projectionFreshness(db);
	const detail = await ipDetail(db, event.params.ip);
	const canLookup = !!event.locals.user && hasPermission(event.locals.user.role, 'operate');
	return {
		connected: srv.connected,
		hasBouncerKey: srv.hasBouncerKey,
		canLookup,
		isPrivate: isPrivateIp(event.params.ip),
		freshness,
		ip: event.params.ip,
		detail
	};
};

interface BouncerDecision {
	id?: number;
	origin?: string;
	type?: string;
	scope?: string;
	value?: string;
	duration?: string;
	until?: string;
	scenario?: string;
	simulated?: boolean;
}

export const actions: Actions = {
	/** Live per-IP decision check through the observer bouncer key. */
	lookup: async (event) => {
		requirePermission(event, 'operate');
		const srv = await getServer(db);
		if (!srv.connected) return fail(400, { lookupError: 'Not connected to a LAPI.' });
		if (!srv.hasBouncerKey)
			return fail(400, {
				lookupError:
					'No observer bouncer key configured — add one under CrowdSec connection settings.'
			});
		const [client, key] = await Promise.all([buildClient(db), getBouncerKey(db)]);
		if (!client || !key) return fail(400, { lookupError: 'Connection credentials unavailable.' });
		try {
			const raw = await client.decisionsByIp(event.params.ip, key);
			const list = (Array.isArray(raw) ? raw : []).filter(
				(d): d is BouncerDecision => typeof d === 'object' && d !== null
			);
			return {
				lookup: {
					ip: event.params.ip,
					count: list.length,
					decisions: list.map((d) => ({
						origin: d.origin ?? null,
						type: d.type ?? null,
						scope: d.scope ?? null,
						duration: d.duration ?? null,
						scenario: d.scenario ?? null,
						simulated: Boolean(d.simulated)
					}))
				}
			};
		} catch (e) {
			const msg =
				e instanceof LapiError
					? e.kind === 'auth'
						? 'The observer bouncer key was rejected (401). Re-issue it with cscli bouncers add.'
						: e.kind === 'unreachable'
							? `Could not reach the LAPI — ${e.message}`
							: `LAPI answered ${e.status ?? 'unexpectedly'}.`
					: e instanceof Error
						? e.message
						: String(e);
			return fail(400, { lookupError: msg });
		}
	},

	/**
	 * Centralized allowlist check (tier A, CrowdSec ≥1.7). Reads only — no
	 * write path exists over LAPI, so changes stay guided commands.
	 */
	allowlistCheck: async (event) => {
		requirePermission(event, 'operate');
		const client = await buildClient(db);
		if (!client) return fail(400, { lookupError: 'Not connected to a LAPI.' });
		try {
			const raw = (await client.allowlistCheck(event.params.ip)) as {
				allowlists?: Array<{ name?: string; id?: string | number; description?: string }>;
			} | null;
			return { allowlist: { ip: event.params.ip, raw } };
		} catch (e) {
			const msg =
				e instanceof LapiError && e.status === 404
					? 'This CrowdSec version does not expose /v1/allowlists/check (needs ≥1.7).'
					: e instanceof Error
						? e.message
						: String(e);
			return fail(400, { lookupError: msg });
		}
	}
};
