/**
 * Channel save/delete/test. `config` holds non-secret fields (hostnames,
 * ports, chat ids); `secretEnc` holds tokens, passwords, and webhook URLs —
 * encrypted with the resolved Better Auth secret and never returned to pages.
 *
 * Webhook-class destinations are SSRF-checked here (at save time) and again in
 * deliver.ts (at send time), since config can change between the two. SMTP is
 * deliberately exempt: mail relays are routinely private-addressed.
 */
import { eq } from 'drizzle-orm';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { db } from '#lib/server/db/index.ts';
import { notificationChannel } from '#lib/server/db/app.schema.ts';
import { resolveSecret } from '#lib/server/secrets.ts';
import { config } from '#lib/server/config.ts';
import { assertSafeHttpUrl } from './deliver.ts';
import { CHANNEL_FIELDS, type ChannelType } from '#lib/notify-channels.ts';

export { CHANNEL_TYPES, CHANNEL_FIELDS, type ChannelType } from '#lib/notify-channels.ts';

const encKey = () => resolveSecret('BETTER_AUTH_SECRET', { dataDir: config.dataDir });

export interface ChannelInput {
	name: string;
	type: ChannelType;
	config: Record<string, string>;
	secrets: Record<string, string>;
	enabled: boolean;
	minSeverity: 'info' | 'warning' | 'critical';
}

/**
 * Validate channel input. Returns an error string or the normalized fields.
 * URL-bearing fields (including webhook URLs stored as secrets) are
 * SSRF-checked now so bad config fails fast at save time.
 */
export function validateChannel(input: ChannelInput): string | null {
	if (!input.name.trim()) return 'Name is required.';
	const spec = CHANNEL_FIELDS[input.type];
	if (!spec) return 'Unknown channel type.';
	for (const f of spec.config) {
		if (f.required && !input.config[f.key]?.trim()) return `${f.label} is required.`;
	}
	for (const f of spec.secrets) {
		if (f.required && !input.secrets[f.key]?.trim()) return `${f.label} is required.`;
	}
	const urlFields: (string | undefined)[] = [
		input.config.url,
		input.config.apiBase,
		input.secrets.webhookUrl
	];
	for (const raw of urlFields) {
		if (!raw?.trim()) continue;
		try {
			assertSafeHttpUrl(raw.trim());
		} catch (e) {
			return e instanceof Error ? e.message : 'Unsafe destination.';
		}
	}
	if (input.type === 'smtp') {
		const port = Number(input.config.port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Invalid SMTP port.';
	}
	return null;
}

export async function saveChannel(
	database: typeof db,
	input: ChannelInput & { id?: string }
): Promise<string> {
	const secretJson = Object.fromEntries(Object.entries(input.secrets).filter(([, v]) => v?.trim()));
	const hasSecrets = Object.keys(secretJson).length > 0;
	const configJson = Object.fromEntries(Object.entries(input.config).filter(([, v]) => v?.trim()));
	const secretEnc = hasSecrets
		? await symmetricEncrypt({ key: encKey(), data: JSON.stringify(secretJson) })
		: null;

	if (input.id) {
		await database
			.update(notificationChannel)
			.set({
				name: input.name.trim(),
				type: input.type,
				config: JSON.stringify(configJson),
				// Only overwrite secrets when new ones were submitted — an edit
				// that leaves token fields blank keeps the stored secret.
				...(hasSecrets ? { secretEnc } : {}),
				enabled: input.enabled,
				minSeverity: input.minSeverity
			})
			.where(eq(notificationChannel.id, input.id));
		return input.id;
	}
	const id = crypto.randomUUID();
	await database.insert(notificationChannel).values({
		id,
		name: input.name.trim(),
		type: input.type,
		config: JSON.stringify(configJson),
		secretEnc,
		enabled: input.enabled,
		minSeverity: input.minSeverity
	});
	return id;
}

export async function deleteChannel(database: typeof db, id: string) {
	await database.delete(notificationChannel).where(eq(notificationChannel.id, id));
}

/** Page-safe channel rows — config included, secrets never. */
export async function listChannels(database: typeof db) {
	const rows = await database.select().from(notificationChannel).orderBy(notificationChannel.name);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		type: r.type,
		config: JSON.parse(r.config) as Record<string, string>,
		hasSecrets: Boolean(r.secretEnc),
		enabled: r.enabled,
		minSeverity: r.minSeverity
	}));
}

/** Decrypt a channel's secrets — delivery paths only. */
export async function channelSecrets(channel: {
	secretEnc: string | null;
}): Promise<Record<string, string>> {
	if (!channel.secretEnc) return {};
	return JSON.parse(await symmetricDecrypt({ key: encKey(), data: channel.secretEnc }));
}
