import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { eq, sql } from 'drizzle-orm';
import { db } from '#lib/server/db/index.ts';
import { notificationChannel, notificationOutbox } from '#lib/server/db/app.schema.ts';
import {
	CHANNEL_FIELDS,
	CHANNEL_TYPES,
	listChannels,
	saveChannel,
	deleteChannel,
	validateChannel,
	type ChannelInput,
	type ChannelType
} from '#lib/server/notify/channels.ts';
import { dispatchOutbox, retryOutboxRow } from '#lib/server/notify/deliver.ts';
import { recordEvent } from '#lib/server/notify/core.ts';
import { requirePermission } from '#lib/server/roles.ts';
import { recordAudit } from '#lib/server/audit.ts';

export const load: PageServerLoad = async (event) => {
	requirePermission(event, 'configure');
	const channels = await listChannels(db);
	const pending = await db
		.select({ n: sql<number>`count(*)` })
		.from(notificationOutbox)
		.where(eq(notificationOutbox.state, 'pending'))
		.get();
	const failed = await db
		.select({ n: sql<number>`count(*)` })
		.from(notificationOutbox)
		.where(eq(notificationOutbox.state, 'failed'))
		.get();
	return {
		channels,
		fields: CHANNEL_FIELDS,
		types: CHANNEL_TYPES,
		outbox: { pending: pending?.n ?? 0, failed: failed?.n ?? 0 }
	};
};

const text = (f: FormData, name: string) => f.get(name)?.toString().trim() ?? '';

function readChannelInput(formData: FormData, type: ChannelType): ChannelInput {
	const spec = CHANNEL_FIELDS[type];
	const config: Record<string, string> = {};
	const secrets: Record<string, string> = {};
	for (const f of spec.config) config[f.key] = text(formData, `cfg_${f.key}`);
	for (const f of spec.secrets) secrets[f.key] = text(formData, `sec_${f.key}`);
	const minSeverity = text(formData, 'minSeverity');
	return {
		name: text(formData, 'name'),
		type,
		config,
		secrets,
		enabled: formData.get('enabled') === 'on',
		minSeverity:
			minSeverity === 'warning' || minSeverity === 'critical' ? minSeverity : ('info' as const)
	};
}

export const actions: Actions = {
	save: async (event) => {
		requirePermission(event, 'configure');
		const formData = await event.request.formData();
		const type = text(formData, 'type') as ChannelType;
		const id = text(formData, 'id') || undefined;
		if (!CHANNEL_TYPES.includes(type)) return fail(400, { message: 'Unknown channel type.' });
		const input = readChannelInput(formData, type);
		// validateChannel enforces required secret fields — but on edit, blank
		// secrets mean "keep existing". Only enforce required-secret presence
		// on create.
		const err = validateForSave(input, id);
		if (err) return fail(400, { message: err });
		const savedId = await saveChannel(db, { ...input, id });
		await recordAudit({
			event,
			action: 'settings.notifications.channel',
			detail: { channelId: savedId, type, created: !id }
		});
		return { notice: `Channel "${input.name}" saved.` };
	},

	remove: async (event) => {
		requirePermission(event, 'configure');
		const id = text(await event.request.formData(), 'id');
		if (!id) return fail(400, { message: 'Missing channel id.' });
		await deleteChannel(db, id);
		await recordAudit({
			event,
			action: 'settings.notifications.channel',
			detail: { channelId: id, deleted: true }
		});
		return { notice: 'Channel removed.' };
	},

	/**
	 * Test delivery goes through the real pipeline — an inbox row, an outbox
	 * row, and one synchronous dispatch attempt — so a green test proves the
	 * full path, not a bespoke shortcut.
	 */
	test: async (event) => {
		requirePermission(event, 'configure');
		const channelId = text(await event.request.formData(), 'id');
		const channel = await db
			.select()
			.from(notificationChannel)
			.where(eq(notificationChannel.id, channelId))
			.get();
		if (!channel) return fail(404, { message: 'Channel not found.' });
		const notifId = await recordEvent(db, {
			eventKey: `test.${channelId}.${Date.now()}`,
			class: 'job',
			severity: 'info',
			title: `Test delivery to ${channel.name}`,
			body: 'If you received this, the channel is configured correctly.'
		});
		await dispatchOutbox(db);
		const row = await db
			.select()
			.from(notificationOutbox)
			.where(eq(notificationOutbox.notificationId, notifId))
			.get();
		if (row?.state === 'delivered') return { notice: `Test delivered to "${channel.name}".` };
		return fail(400, { message: `Test failed: ${row?.lastError ?? 'delivery not attempted'}` });
	},

	retryFailed: async (event) => {
		requirePermission(event, 'configure');
		const rows = await db
			.select({ id: notificationOutbox.id })
			.from(notificationOutbox)
			.where(eq(notificationOutbox.state, 'failed'));
		for (const r of rows) await retryOutboxRow(db, r.id);
		await dispatchOutbox(db);
		return { notice: `${rows.length} failed deliver${rows.length === 1 ? 'y' : 'ies'} retried.` };
	}
};

function validateForSave(input: ChannelInput, editingId?: string): string | null {
	if (!editingId) return validateChannel(input);
	// On edit, blank secret fields are allowed (they keep existing values).
	const spec = CHANNEL_FIELDS[input.type];
	const relaxedSecrets = { ...input.secrets };
	if (input.type === 'smtp' && !input.secrets.password) relaxedSecrets.password = 'x';
	for (const f of spec.secrets) {
		if (f.required && !relaxedSecrets[f.key]) relaxedSecrets[f.key] = 'x';
	}
	return validateChannel({ ...input, secrets: relaxedSecrets });
}
