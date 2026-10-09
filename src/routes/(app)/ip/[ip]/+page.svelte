<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Button from '#lib/components/Button.svelte';

	let { data, form }: PageProps & { form: ActionData } = $props();
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
	const src = $derived(data.detail.source);
	let lookingUp = $state(false);
</script>

<svelte:head><title>{data.ip} · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<p class="text-xs text-ink-3">
			<a href={resolve('/(app)/alerts')} class="text-accent underline">Alerts</a> · IP record
		</p>
		<h1 class="mt-1 font-mono text-xl font-semibold tracking-tight">{data.ip}</h1>
		<p class="mt-1 text-sm text-ink-3">
			{#if src}
				{[src.cn, src.asName, src.asNumber && `AS${src.asNumber}`].filter(Boolean).join(' · ')}
			{:else}
				No geo/AS data in synced alerts.
			{/if}
		</p>
	</header>

	<SyncBanner connected={data.connected} freshness={data.freshness} />

	{#if data.connected}
		<div class="grid gap-4 lg:grid-cols-2">
			<Module title="Live lookup" class="lg:col-span-2">
				{#if !data.hasBouncerKey}
					<div class="border border-rule bg-sheet px-4 py-4">
						<p class="inline-flex items-center gap-2 text-sm text-ink-3">
							<Stamp state="not_configured" label="N/C" /> No observer bouncer key configured — per-IP
							lookups across all origins need one, added under
							<a href={resolve('/(app)/settings/crowdsec')} class="text-accent underline"
								>CrowdSec connection</a
							>. The projected rows below stay the source of truth.
						</p>
					</div>
				{:else if !data.canLookup}
					<p class="border border-rule bg-sheet px-4 py-4 text-sm text-ink-3">
						Live lookup needs operator permissions.
					</p>
				{:else}
					<div class="border border-rule bg-sheet px-4 py-3">
						<form
							method="post"
							action="?/lookup"
							use:enhance={() => {
								lookingUp = true;
								return async ({ update }) => {
									lookingUp = false;
									await update();
								};
							}}
							class="flex items-center gap-3"
						>
							<Button type="submit" loading={lookingUp} disabled={lookingUp}>
								Query LAPI decisions
							</Button>
							<span class="text-xs text-ink-3">
								Live observer-bouncer query — includes CAPI and other origins not in the local
								projection.
							</span>
						</form>
						{#if form?.lookupError}
							<p class="mt-2 text-sm text-failed" role="alert">{form.lookupError}</p>
						{/if}
						{#if form?.lookup && form.lookup.ip === data.ip}
							{@const lk = form.lookup}
							<p class="mt-3 text-sm font-medium text-ink">
								{lk.count} live decision{lk.count === 1 ? '' : 's'} for {lk.ip}
							</p>
							{#if lk.decisions.length}
								<table class="mt-2 w-full border-collapse text-sm">
									<thead>
										<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
											<th class="py-1.5 pr-3 font-medium">Origin</th>
											<th class="py-1.5 pr-3 font-medium">Type</th>
											<th class="py-1.5 pr-3 font-medium">Scenario</th>
											<th class="py-1.5 pr-3 font-medium">Duration</th>
											<th class="py-1.5 font-medium">Simulated</th>
										</tr>
									</thead>
									<tbody>
										{#each lk.decisions as d, i (i)}
											<tr class="border-b border-rule last:border-0">
												<td class="py-1.5 pr-3 font-mono text-xs text-ink-2">{d.origin ?? '—'}</td>
												<td class="py-1.5 pr-3 font-mono text-xs text-ink-2">{d.type ?? '—'}</td>
												<td class="py-1.5 pr-3 font-mono text-xs break-words text-ink-2"
													>{(d.scenario ?? '—').replace(/^crowdsecurity\//, '')}</td
												>
												<td class="py-1.5 pr-3 font-mono text-xs text-ink-2">{d.duration ?? '—'}</td
												>
												<td class="py-1.5 text-xs text-ink-2">{d.simulated ? 'yes' : '—'}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							{/if}
						{/if}
					</div>
				{/if}
			</Module>

			<Module title={`Decisions (${data.detail.decisions.length})`}>
				{#if data.detail.decisions.length}
					<div class="border border-rule bg-sheet">
						<table class="w-full border-collapse text-sm">
							<thead>
								<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
									<th class="px-3 py-2 font-medium">Type</th>
									<th class="px-3 py-2 font-medium">Origin</th>
									<th class="px-3 py-2 font-medium">Scenario</th>
									<th class="px-3 py-2 font-medium">Expires</th>
									<th class="px-3 py-2 font-medium">State</th>
								</tr>
							</thead>
							<tbody>
								{#each data.detail.decisions as d (d.upstreamId)}
									<tr class="border-b border-rule last:border-0">
										<td class="px-3 py-2 font-mono text-xs text-ink-2">{d.type ?? '—'}</td>
										<td class="px-3 py-2 font-mono text-xs text-ink-2">{d.origin ?? '—'}</td>
										<td class="px-3 py-2 font-mono text-xs break-words text-ink-2">
											{(d.scenario ?? '—').replace(/^crowdsecurity\//, '')}
										</td>
										<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-2"
											>{fmt(d.until)}</td
										>
										<td class="px-3 py-2">
											<Stamp
												state={d.expired ? 'stale' : 'verified'}
												label={d.expired ? 'Expired' : 'Active'}
											/>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="border border-rule bg-sheet px-4 py-6 text-center text-sm text-ink-3">
						No decisions recorded for this address.
					</p>
				{/if}
			</Module>

			<Module title={`Alerts (${data.detail.alerts.total})`}>
				{#if data.detail.alerts.rows.length}
					<div class="border border-rule bg-sheet">
						<table class="w-full border-collapse text-sm">
							<thead>
								<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
									<th class="px-3 py-2 font-medium">Started</th>
									<th class="px-3 py-2 font-medium">Scenario</th>
									<th class="px-3 py-2 font-medium">Site</th>
								</tr>
							</thead>
							<tbody>
								{#each data.detail.alerts.rows as row (row.upstreamId)}
									<tr class="border-b border-rule last:border-0">
										<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-2"
											>{fmt(row.startedAt)}</td
										>
										<td class="px-3 py-2 font-mono text-xs break-words text-ink-2">
											{(row.scenario ?? '—').replace(/^crowdsecurity\//, '')}
										</td>
										<td class="px-3 py-2 text-xs">
											{#if row.sites.length}
												{row.sites.map((s) => s.hostname).join(', ')}
											{:else}
												<span class="text-ink-3">unattributed</span>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<p class="border border-rule bg-sheet px-4 py-6 text-center text-sm text-ink-3">
						No alerts recorded for this address.
					</p>
				{/if}
			</Module>
		</div>
	{/if}
</div>
