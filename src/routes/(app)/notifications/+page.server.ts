import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { notificationOutbox, notificationChannel } from '#lib/server/db/app.schema.ts';
import { listNotifications, markAllRead, markRead } from '#lib/server/notify/core.ts';
import { retryOutboxRow, dispatchOutbox } from '#lib/server/notify/deliver.ts';
import { requirePermission, requireUser } from '#lib/server/roles.ts';
import { hasPermission } from '#lib/roles.ts';

export const load: PageServerLoad = async (event) => {
	requireUser(event);
	const severityParam = event.url.searchParams.get('severity');
	const severity =
		severityParam === 'info' || severityParam === 'warning' || severityParam === 'critical'
			? severityParam
			: undefined;
	const list = await listNotifications(db, {
		unreadOnly: event.url.searchParams.get('unread') === '1',
		class: event.url.searchParams.get('class') ?? undefined,
		severity,
		limit: 50,
		offset: (Math.max(1, Number(event.url.searchParams.get('page') ?? 1)) - 1) * 50
	});
	// Per-notification delivery rollups for the visible page.
	const ids = list.rows.map((r) => r.id);
	const deliveries = ids.length
		? await db
				.select({
					notificationId: notificationOutbox.notificationId,
					state: notificationOutbox.state,
					n: sql<number>`count(*)`
				})
				.from(notificationOutbox)
				.where(inArray(notificationOutbox.notificationId, ids))
				.groupBy(notificationOutbox.notificationId, notificationOutbox.state)
		: [];
	const byNotification = new Map<string, Record<string, number>>();
	for (const d of deliveries) {
		const m = byNotification.get(d.notificationId) ?? {};
		m[d.state] = d.n;
		byNotification.set(d.notificationId, m);
	}
	const failed = await db
		.select({ row: notificationOutbox, channel: notificationChannel.name })
		.from(notificationOutbox)
		.innerJoin(notificationChannel, eq(notificationOutbox.channelId, notificationChannel.id))
		.where(sql`${notificationOutbox.state} = 'failed'`)
		.limit(20);
	return {
		list,
		deliveries: Object.fromEntries(byNotification),
		failedDeliveries: failed.map((f) => ({
			id: f.row.id,
			channel: f.channel,
			lastError: f.row.lastError,
			attempts: f.row.attempts
		})),
		canOperate: !!event.locals.user && hasPermission(event.locals.user.role, 'operate'),
		filters: {
			unread: event.url.searchParams.get('unread') === '1',
			class: event.url.searchParams.get('class') ?? '',
			severity: event.url.searchParams.get('severity') ?? '',
			page: Math.max(1, Number(event.url.searchParams.get('page') ?? 1))
		}
	};
};

export const actions: Actions = {
	read: async (event) => {
		requireUser(event);
		const id = (await event.request.formData()).get('id')?.toString();
		if (!id) return fail(400, { message: 'Missing notification id.' });
		await markRead(db, id);
		return { ok: true };
	},
	readAll: async (event) => {
		requireUser(event);
		await markAllRead(db);
		return { ok: true };
	},
	retry: async (event) => {
		requirePermission(event, 'operate');
		const id = (await event.request.formData()).get('id')?.toString();
		if (!id) return fail(400, { message: 'Missing delivery id.' });
		await retryOutboxRow(db, id);
		await dispatchOutbox(db);
		return { notice: 'Delivery retried.' };
	}
};
