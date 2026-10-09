/**
 * Notification core — persistent inbox + transactional outbox.
 *
 * `recordEvent` is the single entry point: it upserts an inbox row keyed by a
 * stable `eventKey` (repeat occurrences bump `count`/`lastAt` and re-mark the
 * row unread) and enqueues one outbox row per matching enabled channel. Outbox
 * rows are only created on first occurrence — a repeated event is reflected in
 * the inbox count, not re-emailed, so floods can't fan out.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { db } from '#lib/server/db/index.ts';
import {
	notification,
	notificationChannel,
	notificationOutbox
} from '#lib/server/db/app.schema.ts';

export type NotifyClass = 'outage' | 'security' | 'admin' | 'job';
export type NotifySeverity = 'info' | 'warning' | 'critical';

const SEVERITY_ORDER: Record<NotifySeverity, number> = { info: 0, warning: 1, critical: 2 };

export interface NotifyInput {
	/** Stable dedupe key, e.g. 'lapi.down' or 'security.alerts.2025-01-01T14'. */
	eventKey: string;
	class: NotifyClass;
	severity: NotifySeverity;
	title: string;
	body?: string;
	href?: string;
}

/** Record an event into the inbox and fan out to channels on first occurrence. */
export async function recordEvent(database: typeof db, input: NotifyInput): Promise<string> {
	const now = new Date();
	const existing = await database
		.select({ id: notification.id })
		.from(notification)
		.where(eq(notification.eventKey, input.eventKey))
		.get();

	if (existing) {
		await database
			.update(notification)
			.set({
				lastAt: now,
				readAt: null,
				title: input.title,
				body: input.body ?? null,
				href: input.href ?? null,
				count: sql`${notification.count} + 1`
			})
			.where(eq(notification.id, existing.id));
		return existing.id;
	}

	const id = crypto.randomUUID();
	await database.insert(notification).values({
		id,
		eventKey: input.eventKey,
		class: input.class,
		severity: input.severity,
		title: input.title,
		body: input.body ?? null,
		href: input.href ?? null,
		count: 1,
		createdAt: now,
		lastAt: now
	});
	await enqueueOutbox(database, id, input.severity);
	return id;
}

/** One outbox row per enabled channel whose severity filter passes. */
async function enqueueOutbox(
	database: typeof db,
	notificationId: string,
	severity: NotifySeverity
) {
	const channels = await database
		.select()
		.from(notificationChannel)
		.where(eq(notificationChannel.enabled, true));
	const rows = channels
		.filter((c) => SEVERITY_ORDER[severity] >= SEVERITY_ORDER[c.minSeverity as NotifySeverity])
		.map((c) => ({
			id: crypto.randomUUID(),
			notificationId,
			channelId: c.id,
			state: 'pending' as const,
			attempts: 0,
			createdAt: new Date()
		}));
	if (rows.length) await database.insert(notificationOutbox).values(rows);
}

/** List inbox rows, newest activity first. */
export async function listNotifications(
	database: typeof db,
	opts: {
		unreadOnly?: boolean;
		class?: string;
		severity?: NotifySeverity;
		limit?: number;
		offset?: number;
	} = {}
) {
	const clauses: SQL[] = [];
	if (opts.unreadOnly) clauses.push(sql`${notification.readAt} IS NULL`);
	if (opts.class) clauses.push(eq(notification.class, opts.class) as SQL);
	if (opts.severity) clauses.push(eq(notification.severity, opts.severity));
	const where = clauses.length ? and(...clauses) : undefined;
	const rows = await database
		.select()
		.from(notification)
		.where(where)
		.orderBy(desc(notification.lastAt))
		.limit(opts.limit ?? 50)
		.offset(opts.offset ?? 0);
	const unread = await database
		.select({ n: sql<number>`count(*)` })
		.from(notification)
		.where(sql`${notification.readAt} IS NULL`)
		.get();
	const total = await database
		.select({ n: sql<number>`count(*)` })
		.from(notification)
		.where(where)
		.get();
	return { rows, unread: unread?.n ?? 0, total: total?.n ?? 0 };
}

export async function markRead(database: typeof db, id: string) {
	await database.update(notification).set({ readAt: new Date() }).where(eq(notification.id, id));
}

export async function markAllRead(database: typeof db) {
	await database
		.update(notification)
		.set({ readAt: new Date() })
		.where(sql`${notification.readAt} IS NULL`);
}
