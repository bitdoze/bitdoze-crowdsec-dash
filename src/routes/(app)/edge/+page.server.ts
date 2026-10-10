import type { Actions, PageServerLoad } from './$types';
import { db } from '#lib/server/db/index.ts';
import { cloudflareAccount, cloudflareZone } from '#lib/server/db/app.schema.ts';
import { enqueue } from '#lib/server/jobs/queue.ts';
import { requirePermission, requireUser } from '#lib/server/roles.ts';
import { hasPermission } from '#lib/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';
import {
	connectAccount,
	reverifyAccount,
	ensureList,
	setZoneSelection,
	uninstallEdge,
	disconnectAccount,
	EdgeError,
	parseHostnames,
	parsePaths
} from '#lib/server/cloudflare/accounts.ts';

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const accounts = await db.select().from(cloudflareAccount);
	const zones = await db.select().from(cloudflareZone);
	const now = Date.now();
	return {
		accounts: accounts.map((a) => ({
			id: a.id,
			name: a.name,
			cfAccountId: a.cfAccountId,
			tokenStatus: a.tokenStatus,
			permissions: (() => {
				try {
					return JSON.parse(a.permissions ?? '[]') as string[];
				} catch {
					return [] as string[];
				}
			})(),
			verifiedAt: a.verifiedAt,
			lastError: a.lastError,
			listId: a.listId,
			listName: a.listName,
			listOwned: a.listOwned,
			listItemCount: a.listItemCount,
			listDropped: a.listDropped,
			lastSyncAt: a.lastSyncAt,
			lastSyncState: a.lastSyncState,
			lastSyncError: a.lastSyncError,
			// Stale = list still holds items but sync hasn't run recently.
			stale: !!a.listItemCount && (!a.lastSyncAt || now - a.lastSyncAt.getTime() > 15 * 60_000),
			zones: zones
				.filter((z) => z.accountId === a.id)
				.map((z) => ({
					id: z.id,
					name: z.name,
					plan: z.plan,
					selected: z.selected,
					hostnames: (() => {
						try {
							return JSON.parse(z.hostnames) as string[];
						} catch {
							return [] as string[];
						}
					})(),
					paths: (() => {
						try {
							return JSON.parse(z.paths) as string[];
						} catch {
							return [] as string[];
						}
					})(),
					action: z.action,
					ruleId: z.ruleId,
					rulesInUse: z.rulesInUse
				}))
		})),
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate')
	};
};

function toNotice(e: unknown): string {
	if (e instanceof EdgeError) return e.message;
	return e instanceof Error ? e.message : String(e);
}

export const actions: Actions = {
	connect: async (event) => {
		requirePermission(event, 'operate');
		const fd = await event.request.formData();
		const name = fd.get('name')?.toString() ?? '';
		const token = fd.get('token')?.toString() ?? '';
		if (!token.trim()) return { notice: 'An API token is required.' };
		try {
			const r = await connectAccount(name, token);
			await recordAudit({
				event,
				action: 'cloudflare.connected',
				detail: { accountId: r.id, zones: r.zones }
			});
			return { notice: `Connected — verified token, discovered ${r.zones} zone(s).` };
		} catch (e) {
			return { notice: toNotice(e) };
		}
	},

	reverify: async (event) => {
		requirePermission(event, 'operate');
		const accountId = (await event.request.formData()).get('accountId')?.toString() ?? '';
		try {
			const r = await reverifyAccount(accountId);
			return { notice: `Token verified — ${r.zones} zone(s) discovered.` };
		} catch (e) {
			return { notice: toNotice(e) };
		}
	},

	createList: async (event) => {
		requirePermission(event, 'operate');
		const accountId = (await event.request.formData()).get('accountId')?.toString() ?? '';
		try {
			const list = await ensureList(accountId);
			await recordAudit({
				event,
				action: 'cloudflare.listReady',
				detail: { accountId, listId: list.id, listName: list.name }
			});
			return { notice: `Edge list ready: ${list.name}.` };
		} catch (e) {
			return { notice: toNotice(e) };
		}
	},

	zone: async (event) => {
		const user = requirePermission(event, 'operate');
		const fd = await event.request.formData();
		const zoneId = fd.get('zoneId')?.toString() ?? '';
		const selected = fd.get('selected') === '1';
		const rawAction = fd.get('action')?.toString() ?? 'block';
		const action =
			rawAction === 'challenge' || rawAction === 'log' ? rawAction : ('block' as const);
		const hostnames = parseHostnames(fd.get('hostnames')?.toString() ?? '');
		const paths = parsePaths(fd.get('paths')?.toString() ?? '');
		try {
			await setZoneSelection(zoneId, { selected, hostnames, paths, action });
			await recordAudit({
				event,
				action: 'cloudflare.zoneSelection',
				detail: { zoneId, selected, hostnames, paths, ruleAction: action, by: user.id }
			});
			return {
				notice: selected
					? 'Zone selected — managed rule installed.'
					: 'Zone deselected — managed rule removed.'
			};
		} catch (e) {
			return { notice: toNotice(e) };
		}
	},

	syncNow: async (event) => {
		const user = requirePermission(event, 'operate');
		const accountId = (await event.request.formData()).get('accountId')?.toString() ?? '';
		const { created, job } = await enqueue(db, {
			kind: 'cloudflare.sync',
			params: { accountId },
			idempotencyKey: `edge-sync:${accountId}`,
			lockKey: `cloudflare:${accountId}`,
			createdBy: user.id
		});
		await recordAudit({
			event,
			action: 'job.enqueued',
			detail: { kind: 'cloudflare.sync', accountId, jobId: job.id }
		});
		return { notice: created ? 'Edge sync queued.' : 'An edge sync is already queued.' };
	},

	uninstall: async (event) => {
		requirePermission(event, 'operate');
		const accountId = (await event.request.formData()).get('accountId')?.toString() ?? '';
		try {
			const r = await uninstallEdge(accountId);
			await recordAudit({
				event,
				action: 'cloudflare.uninstalled',
				detail: { accountId, rulesRemoved: r.rulesRemoved }
			});
			return {
				notice: `Removed ${r.rulesRemoved} managed rule(s); list deleted only if we created it.`
			};
		} catch (e) {
			return { notice: toNotice(e) };
		}
	},

	disconnect: async (event) => {
		requirePermission(event, 'operate');
		const accountId = (await event.request.formData()).get('accountId')?.toString() ?? '';
		try {
			await disconnectAccount(accountId);
			await recordAudit({ event, action: 'cloudflare.disconnected', detail: { accountId } });
			return { notice: 'Cloudflare account disconnected.' };
		} catch (e) {
			return { notice: toNotice(e) };
		}
	}
};
