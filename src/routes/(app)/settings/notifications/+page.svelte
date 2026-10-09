<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import type { ChannelType } from '#lib/notify-channels.ts';

	let { data, form }: PageProps & { form: ActionData } = $props();

	let selectedType = $state<ChannelType>('webhook');
	const spec = $derived(data.fields[selectedType]);
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
						</div>
						<Stamp
							state={c.enabled ? 'verified' : 'not_configured'}
							label={c.enabled ? 'On' : 'Off'}
						/>
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

	<Module title="Add channel">
		<form method="post" action="?/save" class="space-y-3">
			<div class="flex flex-wrap items-end gap-3">
				<Field label="Name" name="name" required class="w-56" placeholder="ops webhook" />
				<label class="flex flex-col gap-1 text-xs text-ink-3">
					Type
					<select
						name="type"
						bind:value={selectedType}
						class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
					>
						{#each data.types as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1 text-xs text-ink-3">
					Minimum severity
					<select
						name="minSeverity"
						class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
					>
						<option value="info">info</option>
						<option value="warning">warning</option>
						<option value="critical">critical</option>
					</select>
				</label>
				<label class="flex items-center gap-1.5 pb-1.5 text-sm text-ink-2">
					<input type="checkbox" name="enabled" checked />
					Enabled
				</label>
			</div>

			<div class="flex flex-wrap gap-3">
				{#each spec.config as f (f.key)}
					<Field label={f.label} name="cfg_{f.key}" required={f.required ?? false} class="w-64" />
				{/each}
				{#each spec.secrets as f (f.key)}
					<Field
						label={f.label}
						name="sec_{f.key}"
						type="password"
						required={f.required ?? false}
						autocomplete="off"
						class="w-64"
					/>
				{/each}
			</div>
			<Button variant="primary" type="submit">Save channel</Button>
		</form>
		<p class="mt-3 text-xs text-ink-3">
			Secrets are stored encrypted and never shown again. Destinations must be http(s) — loopback,
			link-local, and cloud metadata endpoints are rejected (LAN receivers like a private ntfy are
			allowed), and redirects are never followed.
		</p>
	</Module>
</div>
