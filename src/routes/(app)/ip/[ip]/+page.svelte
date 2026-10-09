<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';
	import Stamp from '#lib/components/Stamp.svelte';

	let { data }: PageProps = $props();
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
	const src = $derived(data.detail.source);
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
