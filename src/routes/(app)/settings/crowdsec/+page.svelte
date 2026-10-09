<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import Button from '#lib/components/Button.svelte';

	let { data, form }: PageProps & { form: ActionData } = $props();

	const fmt = (iso: string | null) =>
		iso
			? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
			: '—';

	const alertsSync = $derived(data.sync['alerts']);
	const metricsSync = $derived(data.sync['metrics']);
</script>

<svelte:head><title>CrowdSec connection — CrowdSec Dash</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
	<header
		class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule-strong pb-4"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">CrowdSec connection</h1>
			<p class="mt-1 text-sm text-ink-3">
				Read-only monitoring via the LAPI watcher credentials and the metrics endpoint.
			</p>
		</div>
		<nav class="flex gap-4 text-xs text-ink-3">
			<a href={resolve('/(app)/settings')} class="text-accent underline">Account settings</a>
			<a href={resolve('/(app)/settings/users')} class="text-accent underline">Users</a>
		</nav>
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

	<Module title="Connection">
		{#if data.server.connected}
			<div class="space-y-3">
				<div class="flex items-center gap-3">
					<Stamp state="verified" label="Connected" />
					<span class="font-mono text-sm text-ink">{data.server.lapiUrl}</span>
				</div>
				<dl class="grid grid-cols-[10rem_1fr] gap-y-1.5 text-sm">
					<dt class="text-ink-3">Machine</dt>
					<dd class="font-mono text-ink-2">{data.server.machineId}</dd>
					<dt class="text-ink-3">Metrics</dt>
					<dd class="font-mono text-ink-2">{data.server.metricsUrl ?? 'not configured'}</dd>
					<dt class="text-ink-3">CrowdSec version</dt>
					<dd class="text-ink-2">{data.server.crowdsecVersion ?? 'unknown until first scrape'}</dd>
					<dt class="text-ink-3">Connected since</dt>
					<dd class="text-ink-2">{fmt(data.server.connectedAt?.toISOString() ?? null)}</dd>
				</dl>
				<div class="flex gap-3 pt-1">
					<form method="post" action="?/syncNow"><Button type="submit">Sync now</Button></form>
					<form method="post" action="?/disconnect">
						<Button type="submit" class="border-failed text-failed hover:bg-failed-tint"
							>Disconnect</Button
						>
					</form>
				</div>
				<p class="text-xs text-ink-3">
					Read-only: the dashboard never changes CrowdSec configuration through the watcher
					credential.
				</p>
			</div>
		{:else}
			<form method="post" class="space-y-4">
				<div class="grid gap-4 sm:grid-cols-2">
					<Field label="Server name" name="name" placeholder="reference-host" class="w-full" />
					<Field
						label="LAPI URL"
						name="lapiUrl"
						required
						placeholder="http://127.0.0.1:8080"
						hint="Where CrowdSec's local API listens."
						class="w-full"
					/>
					<Field
						label="Machine ID"
						name="machineId"
						required
						hint="From: cscli machines add dash --password …"
						class="w-full"
					/>
					<Field
						label="Machine password"
						name="password"
						type="password"
						required
						autocomplete="off"
						class="w-full"
					/>
					<Field
						label="Metrics URL"
						name="metricsUrl"
						placeholder="http://127.0.0.1:6060/metrics"
						hint="Optional — unlocks counters and the CrowdSec version."
						class="w-full"
					/>
					<Field
						label="Observer bouncer key"
						name="bouncerKey"
						type="password"
						autocomplete="off"
						hint="Optional — per-IP decision lookups across all origins."
						class="w-full"
					/>
				</div>
				<label class="flex items-center gap-2 text-sm text-ink-2">
					<input type="checkbox" name="insecureTls" class="size-4" />
					Skip TLS verification (self-signed certificate on a trusted network)
				</label>
				<div class="flex gap-3">
					<Button variant="primary" type="submit" formaction="?/connect">Connect</Button>
					<Button type="submit" formaction="?/test" formnovalidate>Test credentials</Button>
				</div>
			</form>
		{/if}
	</Module>

	<Module title="Capability tiers">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-rule-strong text-left">
						<th
							class="w-12 py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Tier</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Capability</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>State</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Unlocks</th
						>
						<th class="py-1.5 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Detail</th
						>
					</tr>
				</thead>
				<tbody>
					{#each data.capabilities as cap (cap.tier)}
						<tr class="border-b border-rule last:border-0">
							<td class="py-2 pr-3 font-mono text-xs font-semibold text-ink">{cap.tier}</td>
							<td class="py-2 pr-3 font-medium text-ink">{cap.label}</td>
							<td class="py-2 pr-3">
								<Stamp state={cap.state} />
							</td>
							<td class="py-2 pr-3 text-xs text-ink-3">{cap.unlocks}</td>
							<td class="py-2 text-xs text-ink-3">{cap.detail}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-3 text-xs text-ink-3">
			Each tier unlocks more of the dashboard. Unavailable tiers read N/C — never a fabricated
			state.
		</p>
	</Module>

	{#if data.server.connected}
		<Module title="Sync status">
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-rule-strong text-left">
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>Source</th
							>
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>State</th
							>
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>Last success</th
							>
							<th class="py-1.5 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>Detail</th
							>
						</tr>
					</thead>
					<tbody>
						<tr class="border-b border-rule">
							<td class="py-2 pr-3 font-medium text-ink">Alerts &amp; decisions</td>
							<td class="py-2 pr-3">
								{#if alertsSync?.lastError}
									<Stamp state="failed" label="Failing" />
								{:else if alertsSync?.partial}
									<Stamp state="stale" label="Importing" />
								{:else if alertsSync?.lastSuccessAt}
									<Stamp state="verified" label="In sync" />
								{:else}
									<Stamp state="not_configured" label="Pending" />
								{/if}
							</td>
							<td class="py-2 pr-3 text-ink-2">{fmt(alertsSync?.lastSuccessAt ?? null)}</td>
							<td class="py-2 text-xs text-ink-3">
								{#if alertsSync?.lastError}
									<span class="text-failed">{alertsSync.lastError}</span>
								{:else if alertsSync?.partial}
									Historical import in progress
								{:else}
									{data.counts.alerts} alerts · {data.counts.decisions} active decisions
								{/if}
							</td>
						</tr>
						<tr>
							<td class="py-2 pr-3 font-medium text-ink">Metrics</td>
							<td class="py-2 pr-3">
								{#if !data.server.metricsUrl}
									<Stamp state="not_configured" label="N/C" />
								{:else if metricsSync?.lastError}
									<Stamp state="failed" label="Failing" />
								{:else if metricsSync?.lastSuccessAt}
									<Stamp state="verified" label="Scraping" />
								{:else}
									<Stamp state="not_configured" label="Pending" />
								{/if}
							</td>
							<td class="py-2 pr-3 text-ink-2">{fmt(metricsSync?.lastSuccessAt ?? null)}</td>
							<td class="py-2 text-xs text-ink-3">
								{metricsSync?.lastError ?? 'Prometheus counters'}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
			<p class="mt-3 text-xs text-ink-3">
				{data.counts.sites} known site{data.counts.sites === 1 ? '' : 's'} — sites appear as alerts attribute
				them, or add them under a future Sites page.
			</p>
		</Module>
	{/if}
</div>
