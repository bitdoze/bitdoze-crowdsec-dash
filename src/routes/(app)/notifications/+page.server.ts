import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq, inArray, sql, type Column } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import {
	notification,
	notificationOutbox,
	notificationChannel
} from '#lib/server/db/app.schema.ts';
import { site } from '#lib/server/db/app.schema.ts';
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

	// 14-day trends — same bucket/label convention as the site activity chart.
	const since = new Date(Date.now() - 14 * 86_400_000);
	const day = (col: Column) => sql`date(${col} / 1000, 'unixepoch')`;
	const eventsByDay = await db
		.select({ d: day(notification.lastAt), n: sql<number>`count(*)` })
		.from(notification)
		.where(sql`${notification.lastAt} >= ${since}`)
		.groupBy(day(notification.lastAt));
	const deliveriesByDay = await db
		.select({
			d: day(notificationOutbox.createdAt),
			state: notificationOutbox.state,
			n: sql<number>`count(*)`
		})
		.from(notificationOutbox)
		.where(sql`${notificationOutbox.createdAt} >= ${since}`)
		.groupBy(day(notificationOutbox.createdAt), notificationOutbox.state);
	const toSeries = (rows: { d: unknown; n: number }[]) => {
		const byDay = new Map<string, number>();
		for (const r of rows) byDay.set(String(r.d), r.n);
		const out: { at: string; alerts: number; decisions: number }[] = [];
		for (let i = 13; i >= 0; i--) {
			const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
			out.push({ at: d, alerts: byDay.get(d) ?? 0, decisions: 0 });
		}
		return out;
	};
	const failedByDay = deliveriesByDay.filter((r) => r.state === 'failed');
	return {
		list,
		deliveries: Object.fromEntries(byNotification),
		failedDeliveries: failed.map((f) => ({
			id: f.row.id,
			channel: f.channel,
			lastError: f.row.lastError,
			attempts: f.row.attempts,
			at: f.row.createdAt
		})),
		eventTrend: toSeries(eventsByDay),
		failedTrend: toSeries(failedByDay),
		siteNames: Object.fromEntries(
			(await db.select({ id: site.id, hostname: site.hostname }).from(site)).map((s) => [
				s.id,
				s.hostname
			])
		),
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
