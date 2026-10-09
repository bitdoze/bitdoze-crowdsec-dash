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
	const oct = host.split('.').map(Number);
	const isV4 = oct.length === 4 && oct.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
	if (
		host === '0.0.0.0' ||
		host === '::1' ||
		host === '::' ||
		['fe8', 'fe9', 'fea', 'feb'].includes(host.slice(0, 3)) ||
		(isV4 && (oct[0] === 127 || (oct[0] === 169 && oct[1] === 254) || oct[0] === 0))
	)
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

async function send(channel: ChannelRow, payload: Payload): Promise<void> {
	const cfg = JSON.parse(channel.config) as Record<string, string>;
	const secret = channel.secretEnc
		? (JSON.parse(await symmetricDecrypt({ key: encKey(), data: channel.secretEnc })) as Record<
				string,
				string
			>)
		: {};

	switch (channel.type) {
		case 'webhook': {
			const url = assertSafeHttpUrl(secret.webhookUrl ?? cfg.url);
			await post(url, {
				headers: secret.token ? { authorization: `Bearer ${secret.token}` } : {},
				body: JSON.stringify({ source: 'crowdsec-dash', ...payload })
			});
			return;
		}
		case 'ntfy': {
			const url = assertSafeHttpUrl(cfg.url); // includes the topic path
			const priority = { info: '2', warning: '3', critical: '5' }[payload.severity] ?? '3';
			await post(url, {
				headers: {
					'content-type': 'text/plain',
					title: payload.title,
					priority,
					tags: payload.class,
					...(secret.token ? { authorization: `Bearer ${secret.token}` } : {})
				},
				body: payload.body || payload.title
			});
			return;
		}
		case 'gotify': {
			const url = assertSafeHttpUrl(`${cfg.url.replace(/\/$/, '')}/message`);
			await post(url, {
				headers: { 'x-gotify-key': secret.token ?? '' },
				body: JSON.stringify({
					title: payload.title,
					message: payload.body || payload.title,
					priority: { info: 2, warning: 5, critical: 8 }[payload.severity] ?? 5
				})
			});
			return;
		}
		case 'discord': {
			const url = assertSafeHttpUrl(secret.webhookUrl ?? '');
			await post(url, {
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
			});
			return;
		}
		case 'slack': {
			const url = assertSafeHttpUrl(secret.webhookUrl ?? '');
			await post(url, {
				body: JSON.stringify({
					text: `*${payload.title}*${payload.body ? `\n${payload.body}` : ''}`
				})
			});
			return;
		}
		case 'telegram': {
			const base = cfg.apiBase
				? assertSafeHttpUrl(cfg.apiBase)
				: new URL('https://api.telegram.org');
			const url = new URL(`/bot${secret.token}/sendMessage`, base);
			await post(url, {
				body: JSON.stringify({
					chat_id: cfg.chatId,
					text: `${payload.title}${payload.body ? `\n\n${payload.body}` : ''}`,
					disable_web_page_preview: true
				})
			});
			return;
		}
		case 'smtp': {
			const transport = createTransport({
				host: cfg.host,
				port: Number(cfg.port ?? 587),
				secure: cfg.secure === 'true',
				auth: secret.password ? { user: cfg.user, pass: secret.password } : undefined,
				connectionTimeout: TIMEOUT_MS
			});
			await transport.sendMail({
				from: cfg.from,
				to: cfg.to,
				subject: `[${payload.severity.toUpperCase()}] ${payload.title}`,
				text: `${payload.body || payload.title}${payload.href ? `\n\n${payload.href}` : ''}`
			});
			return;
		}
	}
}

/**
 * Drain due outbox rows. Returns counts for tests/observability.
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
		const attempts = row.attempts + 1;
		const payload: Payload = {
			title: notif.title,
			body: notif.body ?? '',
			severity: notif.severity,
			class: notif.class,
			href: notif.href ? new URL(notif.href, config.origin).href : null,
			occurredAt: notif.lastAt.toISOString()
		};
		let secretValues: string[] = [];
		try {
			if (channel.secretEnc) {
				const dec = JSON.parse(
					await symmetricDecrypt({ key: encKey(), data: channel.secretEnc })
				) as Record<string, string>;
				secretValues = Object.values(dec).filter(Boolean);
			}
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
	}
	return { sent, failed, retried };
}

/** Re-queue a failed delivery (manual retry). */
export async function retryOutboxRow(database: typeof db, id: string) {
	await database
		.update(notificationOutbox)
		.set({ state: 'pending', attempts: 0, nextRetryAt: null, lastError: null })
		.where(eq(notificationOutbox.id, id));
}
