/**
 * Outbox dispatcher — drains pending deliveries with bounded retries.
 *
 * Delivery rules from the spec:
 * - at-least-once: a row is only `delivered` after the destination answered 2xx
 * - bounded: MAX_ATTEMPTS tries, then `failed` (manual retry re-queues it)
 * - backoff: exponential with jitter
 * - SSRF: destinations are validated before every send — http/https only; no
 *   loopback, link-local, `0.0.0.0`, or cloud metadata endpoints; redirects are
 *   never followed (`redirect: 'manual'`). RFC1918/CGNAT destinations ARE
 *   allowed: a self-hosted dashboard legitimately notifies LAN services like
 *   ntfy/Gotify, and channel config is admin-only.
 * - secrets (tokens, passwords, webhook URLs) live in `secretEnc`, decrypted
 *   in-memory here and redacted from errors.
 */
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createTransport } from 'nodemailer';
import type { db } from '#lib/server/db/index.ts';
import {
	notification,
	notificationChannel,
	notificationOutbox
} from '#lib/server/db/app.schema.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { config } from '#lib/server/config.ts';
import { assertResolvesSafely, isBlockedAddress } from '#lib/server/net-guard.ts';

const encKey = () => resolveSecret('BETTER_AUTH_SECRET', { dataDir: config.dataDir });

export const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

function backoffMs(attempts: number): number {
	const base = Math.min(60_000 * 2 ** (attempts - 1), 30 * 60_000);
	return base + Math.floor(Math.random() * 15_000);
}

/** Redact anything secret-shaped from an error message. */
function redact(msg: string, secrets: string[]): string {
	let out = msg.slice(0, 300);
	for (const s of secrets) if (s) out = out.split(s).join('•••');
	return out;
}

export class UnsafeDestinationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UnsafeDestinationError';
	}
}

const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'metadata.google.internal',
	'instance-data',
	'instance-data.ec2.internal'
]);

/**
 * Validate a delivery URL. Blocks loopback, link-local (incl. the cloud
 * metadata address), unspecified, and non-http(s) destinations. Private LAN
 * ranges pass — a self-hosted dashboard legitimately talks to LAN ntfy/Gotify/
 * webhook receivers; the channel config being admin-only is the control.
 */
export function assertSafeHttpUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeDestinationError('Not a valid URL.');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new UnsafeDestinationError('Only http/https destinations are allowed.');
	const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (BLOCKED_HOSTNAMES.has(host))
		throw new UnsafeDestinationError(`Destination host "${host}" is not allowed.`);
	if (isBlockedAddress(host, 'webhook'))
		throw new UnsafeDestinationError(
			'Loopback, link-local, and metadata destinations are not allowed.'
		);
	return url;
}

/** Fetch wrapper: no redirects, bounded timeout. */
async function post(url: URL, init: { headers?: Record<string, string>; body: string }) {
	const res = await fetch(url, {
		method: 'POST',
		redirect: 'manual',
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: { 'content-type': 'application/json', ...init.headers },
		body: init.body
	});
	if (res.status >= 300 && res.status < 400)
		throw new Error(`Destination wants a redirect (${res.status}) — not followed.`);
	if (!res.ok) throw new Error(`Destination answered ${res.status}.`);
}

interface ChannelRow {
	id: string;
	type: (typeof notificationChannel.$inferSelect)['type'];
	config: string;
	secretEnc: string | null;
}

export type Sender = (channel: ChannelRow, payload: Payload) => Promise<void>;

interface Payload {
	title: string;
	body: string;
	severity: string;
	class: string;
	href: string | null;
	occurredAt: string;
}

/** What a channel would send — `url` absent means SMTP transport. */
interface Rendered {
	url?: URL;
	headers?: Record<string, string>;
	body?: string;
	smtp?: {
		host: string;
		port: number;
		secure: boolean;
		user?: string;
		from: string;
		to: string;
		subject: string;
		text: string;
	};
}

/** Render the delivery for a channel without sending it. Pure. */
export function renderPayload(
	channel: Pick<ChannelRow, 'type' | 'config'>,
	secrets: Record<string, string>,
	payload: Payload
): Rendered {
	const cfg = JSON.parse(channel.config) as Record<string, string>;
	switch (channel.type) {
		case 'webhook':
			return {
				url: assertSafeHttpUrl(secrets.webhookUrl ?? cfg.url),
				headers: secrets.token ? { authorization: `Bearer ${secrets.token}` } : {},
				body: JSON.stringify({ source: 'crowdsec-dash', ...payload })
			};
		case 'ntfy': {
			const priority = { info: '2', warning: '3', critical: '5' }[payload.severity] ?? '3';
			return {
				url: assertSafeHttpUrl(cfg.url), // includes the topic path
				headers: {
					'content-type': 'text/plain',
					title: payload.title,
					priority,
					tags: payload.class,
					...(secrets.token ? { authorization: `Bearer ${secrets.token}` } : {})
				},
				body: payload.body || payload.title
			};
		}
		case 'gotify':
			return {
				url: assertSafeHttpUrl(`${cfg.url.replace(/\/$/, '')}/message`),
				headers: { 'x-gotify-key': secrets.token ?? '' },
				body: JSON.stringify({
					title: payload.title,
					message: payload.body || payload.title,
					priority: { info: 2, warning: 5, critical: 8 }[payload.severity] ?? 5
				})
			};
		case 'discord':
			return {
				url: assertSafeHttpUrl(secrets.webhookUrl ?? ''),
				body: JSON.stringify({
					embeds: [
						{
							title: payload.title,
							description: payload.body || undefined,
							color:
								{ info: 0x6b7f8a, warning: 0xc07f00, critical: 0xb3261e }[payload.severity] ??
								0x6b7f8a,
							footer: { text: `CrowdSec Dash · ${payload.class}` }
						}
					]
				})
			};
		case 'slack':
			return {
				url: assertSafeHttpUrl(secrets.webhookUrl ?? ''),
				body: JSON.stringify({
					text: `*${payload.title}*${payload.body ? `\n${payload.body}` : ''}`
				})
			};
		case 'telegram': {
			const base = cfg.apiBase
				? assertSafeHttpUrl(cfg.apiBase)
				: new URL('https://api.telegram.org');
			return {
				url: new URL(`/bot${secrets.token}/sendMessage`, base),
				body: JSON.stringify({
					chat_id: cfg.chatId,
					text: `${payload.title}${payload.body ? `\n\n${payload.body}` : ''}`,
					disable_web_page_preview: true
				})
			};
		}
		case 'smtp':
			return {
				smtp: {
					host: cfg.host,
					port: Number(cfg.port ?? 587),
					secure: cfg.secure === 'true',
					user: cfg.user,
					from: cfg.from,
					to: cfg.to,
					subject: `[${payload.severity.toUpperCase()}] ${payload.title}`,
					text: `${payload.body || payload.title}${payload.href ? `\n\n${payload.href}` : ''}`
				}
			};
	}
}

async function send(channel: ChannelRow, payload: Payload): Promise<void> {
	const secrets = channel.secretEnc
		? (JSON.parse(await symmetricDecrypt({ key: encKey(), data: channel.secretEnc })) as Record<
				string,
				string
			>)
		: {};
	const r = renderPayload(channel, secrets, payload);
	if (r.smtp) {
		const transport = createTransport({
			host: r.smtp.host,
			port: r.smtp.port,
			secure: r.smtp.secure,
			auth: secrets.password ? { user: r.smtp.user, pass: secrets.password } : undefined,
			connectionTimeout: TIMEOUT_MS
		});
		await transport.sendMail({
			from: r.smtp.from,
			to: r.smtp.to,
			subject: r.smtp.subject,
			text: r.smtp.text
		});
		return;
	}
	// Re-resolve at send time: the save-time check can't see what the
	// hostname points at now (DNS rebinding). SMTP is exempt — a local
	// MTA on loopback/LAN is a legitimate destination.
	await assertResolvesSafely(r.url!.hostname, 'webhook');
	await post(r.url!, { headers: r.headers ?? {}, body: r.body ?? '' });
}

const DIGEST_CAP = 25;

/**
 * Quiet-hours check. `start`/`end` are `HH:MM` UTC; a window may wrap
 * midnight (22:00 → 06:00). Returns the window's end instant when `now`
 * is inside it, else null. Malformed input disables quiet hours.
 */
export function quietUntil(now: Date, start?: string | null, end?: string | null): Date | null {
	if (!start || !end) return null;
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/;
	const s = m.exec(start);
	const e = m.exec(end);
	if (!s || !e) return null;
	const smin = Number(s[1]) * 60 + Number(s[2]);
	const emin = Number(e[1]) * 60 + Number(e[2]);
	const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
	const inside = smin <= emin ? cur >= smin && cur < emin : cur >= smin || cur < emin;
	if (!inside) return null;
	const until = new Date(now);
	until.setUTCHours(Math.floor(emin / 60), emin % 60, 0, 0);
	if (emin <= cur) until.setUTCDate(until.getUTCDate() + 1);
	return until;
}

function toPayload(notif: typeof notification.$inferSelect): Payload {
	return {
		title: notif.title,
		body: notif.body ?? '',
		severity: notif.severity,
		class: notif.class,
		href: notif.href ? new URL(notif.href, config.origin).href : null,
		occurredAt: notif.lastAt.toISOString()
	};
}

async function channelSecretsForRedaction(channel: ChannelRow): Promise<string[]> {
	if (!channel.secretEnc) return [];
	const dec = JSON.parse(
		await symmetricDecrypt({ key: encKey(), data: channel.secretEnc })
	) as Record<string, string>;
	return Object.values(dec).filter(Boolean);
}

/**
 * Drain due outbox rows. Returns counts for tests/observability.
 *
 * Channel rules applied at send time:
 * - quiet hours defer non-critical rows to the window's end;
 * - `digestMinutes > 0` channels batch pending rows into one payload once
 *   the oldest row is older than the interval (or DIGEST_CAP is reached —
 *   a flood shouldn't wait out the window).
 */
export async function dispatchOutbox(
	database: typeof db,
	{
		limit = 20,
		now = new Date(),
		sendImpl = send
	}: { limit?: number; now?: Date; sendImpl?: Sender } = {}
): Promise<{ sent: number; failed: number; retried: number }> {
	const due = await database
		.select({ outbox: notificationOutbox, channel: notificationChannel })
		.from(notificationOutbox)
		.innerJoin(notificationChannel, eq(notificationOutbox.channelId, notificationChannel.id))
		.where(
			and(
				eq(notificationOutbox.state, 'pending'),
				or(sql`${notificationOutbox.nextRetryAt} IS NULL`, lt(notificationOutbox.nextRetryAt, now))
			)
		)
		.orderBy(notificationOutbox.createdAt)
		.limit(limit);

	let sent = 0;
	let failed = 0;
	let retried = 0;

	// Digest channels are handled as batches; everything else per row.
	const digestBatches = new Map<
		string,
		{
			channel: typeof notificationChannel.$inferSelect;
			items: {
				row: typeof notificationOutbox.$inferSelect;
				notif: typeof notification.$inferSelect;
			}[];
		}
	>();

	const markOutcome = async (
		row: typeof notificationOutbox.$inferSelect,
		channel: ChannelRow,
		payload: Payload
	) => {
		const attempts = row.attempts + 1;
		const secretValues = await channelSecretsForRedaction(channel);
		try {
			await sendImpl(channel, payload);
			await database
				.update(notificationOutbox)
				.set({ state: 'delivered', attempts, deliveredAt: now, lastError: null })
				.where(eq(notificationOutbox.id, row.id));
			sent++;
		} catch (e) {
			const msg = redact(e instanceof Error ? e.message : String(e), secretValues);
			const exhausted = attempts >= MAX_ATTEMPTS;
			await database
				.update(notificationOutbox)
				.set({
					state: exhausted ? 'failed' : 'pending',
					attempts,
					lastError: msg,
					nextRetryAt: exhausted ? null : new Date(now.getTime() + backoffMs(attempts))
				})
				.where(eq(notificationOutbox.id, row.id));
			if (exhausted) failed++;
			else retried++;
		}
	};

	for (const { outbox: row, channel } of due) {
		const notif = await database
			.select()
			.from(notification)
			.where(eq(notification.id, row.notificationId))
			.get();
		if (!notif || !channel.enabled) {
			await database
				.update(notificationOutbox)
				.set({ state: 'failed', lastError: 'notification or channel removed' })
				.where(eq(notificationOutbox.id, row.id));
			failed++;
			continue;
		}
		const quiet = quietUntil(now, channel.quietStart, channel.quietEnd);
		if (quiet && notif.severity !== 'critical') {
			await database
				.update(notificationOutbox)
				.set({ nextRetryAt: quiet })
				.where(eq(notificationOutbox.id, row.id));
			continue;
		}
		if (channel.digestMinutes > 0) {
			const batch = digestBatches.get(channel.id) ?? { channel, items: [] };
			batch.items.push({ row, notif });
			digestBatches.set(channel.id, batch);
			continue;
		}
		await markOutcome(row, channel, toPayload(notif));
	}

	for (const { channel, items } of digestBatches.values()) {
		// Collect every due pending row for this channel so the digest is
		// complete — quiet-deferred and backing-off rows keep their timers.
		const pending = await database
			.select({ outbox: notificationOutbox })
			.from(notificationOutbox)
			.where(
				and(
					eq(notificationOutbox.channelId, channel.id),
					eq(notificationOutbox.state, 'pending'),
					or(
						sql`${notificationOutbox.nextRetryAt} IS NULL`,
						lt(notificationOutbox.nextRetryAt, now)
					)
				)
			)
			.orderBy(notificationOutbox.createdAt)
			.limit(DIGEST_CAP);
		const oldest = pending[0]?.outbox.createdAt;
		const ready =
			oldest !== undefined &&
			(now.getTime() - oldest.getTime() >= channel.digestMinutes * 60_000 ||
				pending.length >= DIGEST_CAP);
		if (!ready) continue;

		const rows = pending.map((p) => p.outbox);
		const notifs = items
			.map((i) => i.notif)
			.filter((n) => rows.some((r) => r.notificationId === n.id));
		// pending may include rows beyond the `due` slice — fetch those too.
		for (const r of rows) {
			if (!notifs.some((n) => n.id === r.notificationId)) {
				const n = await database
					.select()
					.from(notification)
					.where(eq(notification.id, r.notificationId))
					.get();
				if (n) notifs.push(n);
			}
		}
		if (!notifs.length) continue;
		const maxSev = notifs.some((n) => n.severity === 'critical')
			? 'critical'
			: notifs.some((n) => n.severity === 'warning')
				? 'warning'
				: 'info';
		const lines = notifs.map(
			(n) => `[${n.severity}] ${n.title}${n.count > 1 ? ` (×${n.count})` : ''}`
		);
		const digest: Payload = {
			title: `${notifs.length} notification${notifs.length === 1 ? '' : 's'} — CrowdSec Dash digest`,
			body: lines.join('\n'),
			severity: maxSev,
			class: 'digest',
			href: new URL('/notifications', config.origin).href,
			occurredAt: now.toISOString()
		};
		let secretValues: string[] = [];
		try {
			secretValues = await channelSecretsForRedaction(channel);
			await sendImpl(channel, digest);
			for (const r of rows) {
				await database
					.update(notificationOutbox)
					.set({
						state: 'delivered',
						attempts: r.attempts + 1,
						deliveredAt: now,
						lastError: null
					})
					.where(eq(notificationOutbox.id, r.id));
			}
			sent += rows.length;
		} catch (e) {
			const msg = redact(e instanceof Error ? e.message : String(e), secretValues);
			for (const r of rows) {
				const attempts = r.attempts + 1;
				const exhausted = attempts >= MAX_ATTEMPTS;
				await database
					.update(notificationOutbox)
					.set({
						state: exhausted ? 'failed' : 'pending',
						attempts,
						lastError: msg,
						nextRetryAt: exhausted ? null : new Date(now.getTime() + backoffMs(attempts))
					})
					.where(eq(notificationOutbox.id, r.id));
				if (exhausted) failed++;
				else retried++;
			}
		}
	}
	return { sent, failed, retried };
}

/**
 * Redacted render of what a channel would send for a sample event —
 * destination host and body, secrets stripped. For the settings UI.
 */
export async function previewDelivery(
	channel: typeof notificationChannel.$inferSelect
): Promise<{ destination: string; headers: Record<string, string>; body: string }> {
	const secretMap = channel.secretEnc
		? (JSON.parse(await symmetricDecrypt({ key: encKey(), data: channel.secretEnc })) as Record<
				string,
				string
			>)
		: {};
	const secretValues = Object.values(secretMap).filter(Boolean);
	const rendered = renderPayload(channel, secretMap, {
		title: 'Sample event',
		body: 'This is how a notification will look on this channel.',
		severity: 'warning',
		class: 'security',
		href: new URL('/alerts', config.origin).href,
		occurredAt: new Date().toISOString()
	});
	const hide = (s: string) => {
		let out = s;
		for (const v of secretValues) if (v) out = out.split(v).join('•••');
		return out;
	};
	if (rendered.smtp) {
		const { smtp } = rendered;
		return {
			destination: hide(`smtp://${smtp.host}:${smtp.port} → ${smtp.to}`),
			headers: { from: smtp.from, subject: smtp.subject },
			body: hide(smtp.text)
		};
	}
	const url = rendered.url ?? new URL('https://unknown');
	const headers = Object.fromEntries(
		Object.entries(rendered.headers ?? {}).map(([k, v]) => [
			k,
			/authorization|key|token/i.test(k) ? '•••' : hide(v)
		])
	);
	return { destination: hide(url.host + url.pathname), headers, body: hide(rendered.body ?? '') };
}

/** Re-queue a failed delivery (manual retry). */
export async function retryOutboxRow(database: typeof db, id: string) {
	await database
		.update(notificationOutbox)
		.set({ state: 'pending', attempts: 0, nextRetryAt: null, lastError: null })
		.where(eq(notificationOutbox.id, id));
}
