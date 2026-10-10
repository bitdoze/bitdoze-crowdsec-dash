<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import type { ChannelType } from '#lib/notify-channels.ts';

	let { data, form }: PageProps & { form: ActionData } = $props();

	// Editing keeps stored secrets when fields are left blank (server-side rule).
	const editing = $derived(data.edit);
	let selectedType = $state<ChannelType>('webhook');
	const spec = $derived(data.fields[editing ? editing.type : selectedType]);
</script>

<svelte:head><title>Notification channels · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">Notification channels</h1>
		<p class="mt-1 text-sm text-ink-3">
			{data.channels.length} configured · outbox: {data.outbox.pending} pending, {data.outbox
				.failed} failed
		</p>
	</header>

	{#if form?.notice}
		<p
			class="border border-verified bg-verified-tint px-3 py-2 text-sm text-verified"
			role="status"
		>
			{form.notice}
		</p>
	{/if}
	{#if form?.message}
		<p class="border border-failed bg-failed-tint px-3 py-2 text-sm text-failed" role="alert">
			{form.message}
		</p>
	{/if}
	{#if form?.preview}
		<div class="border border-rule bg-sheet p-3">
			<p class="text-xs font-medium tracking-wide text-ink-3 uppercase">
				Delivery preview — destination {form.preview.destination}
			</p>
			{#if Object.keys(form.preview.headers).length}
				<pre class="mt-2 overflow-x-auto font-mono text-xs text-ink-2">{JSON.stringify(
						form.preview.headers,
						null,
						2
					)}</pre>
			{/if}
			<pre
				class="bg-base mt-2 overflow-x-auto rounded-[3px] border border-line p-2 font-mono text-xs whitespace-pre-wrap text-ink-2">{form
					.preview.body}</pre>
		</div>
	{/if}

	<Module title="Channels">
		{#if data.channels.length}
			<div class="border border-rule bg-sheet">
				{#each data.channels as c (c.id)}
					<div
						class="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3 last:border-0"
						data-channel={c.id}
					>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium text-ink">
								{c.name}
								<span class="ml-1 font-mono text-xs text-ink-3">{c.type}</span>
							</p>
							<p class="text-xs text-ink-3">
								{Object.values(c.config).filter(Boolean).join(' · ') || 'secrets only'} · min severity
								{c.minSeverity}{c.hasSecrets ? ' · credentials stored' : ''}
							</p>
							<p class="text-xs text-ink-3">
								{c.classes.length ? c.classes.join(', ') : 'all classes'} ·
								{c.siteIds.length
									? c.siteIds
											.map((id) => data.sites.find((s) => s.id === id)?.hostname ?? id)
											.join(', ')
									: 'all sites'}
								{c.quietStart ? ` · quiet ${c.quietStart}–${c.quietEnd} UTC` : ''}
								{c.digestMinutes > 0 ? ` · digest every ${c.digestMinutes}m` : ''}
							</p>
						</div>
						<Stamp
							state={c.enabled ? 'verified' : 'not_configured'}
							label={c.enabled ? 'On' : 'Off'}
						/>
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={resolve('/(app)/settings/notifications') + `?edit=${c.id}`}
							class="inline-flex items-center justify-center gap-1.5 rounded-[3px] border border-line bg-sheet px-2 py-1 text-xs font-semibold text-ink hover:bg-panel"
							>Edit</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<form method="post" action="?/preview">
							<input type="hidden" name="id" value={c.id} />
							<Button type="submit" size="sm" variant="secondary">Preview</Button>
						</form>
						<form method="post" action="?/test">
							<input type="hidden" name="id" value={c.id} />
							<Button type="submit" size="sm">Send test</Button>
						</form>
						<form method="post" action="?/remove">
							<input type="hidden" name="id" value={c.id} />
							<Button type="submit" size="sm" variant="secondary">Remove</Button>
						</form>
					</div>
				{/each}
			</div>
		{:else}
			<p class="border border-rule bg-sheet px-4 py-6 text-center text-sm text-ink-3">
				No channels yet — events still land in the <a
					href={resolve('/(app)/notifications')}
					class="text-accent underline">inbox</a
				>.
			</p>
		{/if}
		{#if data.outbox.failed > 0}
			<form method="post" action="?/retryFailed" class="mt-3">
				<Button type="submit" size="sm">Retry {data.outbox.failed} failed deliveries</Button>
			</form>
		{/if}
	</Module>

	<Module title={editing ? `Edit channel — ${editing.name}` : 'Add channel'}>
		<form method="post" action="?/save" class="space-y-3">
			{#if editing}
				<input type="hidden" name="id" value={editing.id} />
			{/if}
			<div class="flex flex-wrap items-end gap-3">
				<Field
					label="Name"
					name="name"
					required
					class="w-56"
					placeholder="ops webhook"
					value={editing?.name ?? ''}
				/>
				<label class="flex flex-col gap-1 text-xs text-ink-3">
					Type
					{#if editing}
						<input type="hidden" name="type" value={editing.type} />
						<span
							class="bg-base rounded-[3px] border border-line px-2 py-1.5 font-mono text-sm text-ink-2"
							>{editing.type}</span
						>
					{:else}
						<select
							name="type"
							bind:value={selectedType}
							class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
						>
							{#each data.types as t (t)}
								<option value={t}>{t}</option>
							{/each}
						</select>
					{/if}
				</label>
				<label class="flex flex-col gap-1 text-xs text-ink-3">
					Minimum severity
					<select
						name="minSeverity"
						class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
					>
						{#each ['info', 'warning', 'critical'] as sev (sev)}
							<option value={sev} selected={(editing?.minSeverity ?? 'info') === sev}>{sev}</option>
						{/each}
					</select>
				</label>
				<label class="flex items-center gap-1.5 pb-1.5 text-sm text-ink-2">
					<input type="checkbox" name="enabled" checked={editing?.enabled ?? true} />
					Enabled
				</label>
			</div>

			<div class="flex flex-wrap gap-3">
				{#each spec.config as f (f.key)}
					<Field
						label={f.label}
						name="cfg_{f.key}"
						required={f.required ?? false}
						class="w-64"
						value={editing?.config[f.key] ?? ''}
					/>
				{/each}
				{#each spec.secrets as f (f.key)}
					<Field
						label={f.label}
						name="sec_{f.key}"
						type="password"
						required={!editing && (f.required ?? false)}
						placeholder={editing ? 'unchanged when blank' : ''}
						autocomplete="off"
						class="w-64"
					/>
				{/each}
			</div>

			<fieldset class="border border-rule p-3">
				<legend class="px-1 text-xs font-medium tracking-wide text-ink-3 uppercase"> Rules </legend>
				<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
					<span class="text-xs text-ink-3">Classes</span>
					{#each ['outage', 'security', 'admin', 'job'] as c (c)}
						<label class="flex items-center gap-1.5">
							<input
								type="checkbox"
								name="classes"
								value={c}
								checked={!editing || editing.classes.length === 0 || editing.classes.includes(c)}
							/>
							{c}
						</label>
					{/each}
					{#if data.sites.length}
						<span class="text-xs text-ink-3">Sites</span>
						{#each data.sites as s (s.id)}
							<label class="flex items-center gap-1.5">
								<input
									type="checkbox"
									name="siteIds"
									value={s.id}
									checked={!editing ||
										editing.siteIds.length === 0 ||
										editing.siteIds.includes(s.id)}
								/>
								{s.hostname}
							</label>
						{/each}
					{/if}
				</div>
				<div class="mt-3 flex flex-wrap items-end gap-3">
					<Field
						label="Quiet from (UTC)"
						name="quietStart"
						placeholder="22:00"
						class="w-32"
						value={editing?.quietStart ?? ''}
					/>
					<Field
						label="Quiet until (UTC)"
						name="quietEnd"
						placeholder="06:00"
						class="w-32"
						value={editing?.quietEnd ?? ''}
					/>
					<label class="flex flex-col gap-1 text-xs text-ink-3">
						Digest
						<select
							name="digestMinutes"
							class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
						>
							{#each [['0', 'Immediate'], ['15', 'Every 15 min'], ['60', 'Hourly'], ['360', 'Every 6 hours'], ['1440', 'Daily']] as [v, lbl] (v)}
								<option value={v} selected={String(editing?.digestMinutes ?? 0) === v}>{lbl}</option
								>
							{/each}
						</select>
					</label>
				</div>
				<p class="mt-2 text-xs text-ink-3">
					Unticked classes/sites are excluded — untick all to mean "everything". During quiet hours
					only critical events deliver; the rest arrive when the window ends. Digest batches events
					into one message per interval.
				</p>
			</fieldset>
			<div class="flex items-center gap-3">
				<Button variant="primary" type="submit">{editing ? 'Save changes' : 'Save channel'}</Button>
				{#if editing}
					<a
						href={resolve('/(app)/settings/notifications')}
						class="inline-flex items-center justify-center rounded-[3px] border border-line bg-sheet px-3 py-1.5 text-sm font-semibold text-ink hover:bg-panel"
						>Cancel</a
					>
				{/if}
			</div>
		</form>
		<p class="mt-3 text-xs text-ink-3">
			Secrets are stored encrypted and never shown again. Destinations must be http(s) — loopback,
			link-local, and cloud metadata endpoints are rejected (LAN receivers like a private ntfy are
			allowed), and redirects are never followed.
		</p>
	</Module>
</div>
