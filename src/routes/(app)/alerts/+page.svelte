<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';
	import Pager from '#lib/components/Pager.svelte';
	import Button from '#lib/components/Button.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';

	let { data }: PageProps = $props();

	const siteOptions = $derived([
		{ value: '', label: 'All sites' },
		...data.sites.map((s) => ({ value: s.id, label: s.hostname }))
	]);

	const shortScenario = (s: string | null) => (s ?? '—').replace(/^crowdsecurity\//, '');
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
</script>

<svelte:head><title>Alerts · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header
		class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule-strong pb-4"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Alerts</h1>
			<p class="mt-1 text-sm text-ink-3">
				{data.list.total.toLocaleString()} alerts in the local projection · source LAPI
				{data.freshness.lastSuccessAt
					? `· synced ${new Date(data.freshness.lastSuccessAt).toLocaleString()}`
					: ''}
			</p>
		</div>
	</header>

	<SyncBanner connected={data.connected} freshness={data.freshness} />

	{#if data.connected}
		<form method="get" class="flex flex-wrap items-end gap-3" data-testid="alert-filters">
			<FilterSelect label="Site" value={data.filters.site} options={siteOptions} name="site" />
			<label class="flex flex-col gap-1 text-xs text-ink-3">
				Scenario
				<input
					name="scenario"
					value={data.filters.scenario}
					placeholder="ssh, http-probing…"
					class="w-44 rounded-[3px] border border-line bg-sheet px-2 py-1.5 font-mono text-sm text-ink"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-3">
				Source IP
				<input
					name="ip"
					value={data.filters.ip}
					placeholder="1.2.3.4"
					class="w-40 rounded-[3px] border border-line bg-sheet px-2 py-1.5 font-mono text-sm text-ink"
				/>
			</label>
			<Button type="submit">Filter</Button>
		</form>

		<Module title="Alert log">
			<div class="overflow-x-auto border border-rule bg-sheet">
				<table class="w-full border-collapse text-sm">
					<thead>
						<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
							<th class="px-3 py-2 font-medium">Started</th>
							<th class="px-3 py-2 font-medium">Source</th>
							<th class="px-3 py-2 font-medium">Scenario</th>
							<th class="px-3 py-2 font-medium">Site</th>
							<th class="px-3 py-2 text-right font-medium">Decisions</th>
						</tr>
					</thead>
					<tbody>
						{#each data.list.rows as row (row.upstreamId)}
							<tr class="border-b border-rule last:border-0">
								<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-2">
									{fmt(row.startedAt)}
								</td>
								<td class="px-3 py-2">
									{#if row.sourceIp}
										<a
											href={resolve('/(app)/ip/[ip]', { ip: row.sourceIp })}
											class="font-mono text-xs text-accent underline"
											data-testid="alert-ip">{row.sourceIp}</a
										>
										{#if row.sourceCn}
											<span class="ml-1 text-xs text-ink-3">{row.sourceCn}</span>
										{/if}
										{#if row.sourceAsName}
											<span class="block max-w-56 truncate text-xs text-ink-3"
												>{row.sourceAsName}</span
											>
										{/if}
									{:else}
										<span class="text-xs text-ink-3">{row.message ?? '—'}</span>
									{/if}
								</td>
								<td class="px-3 py-2 font-mono text-xs break-words text-ink-2">
									{shortScenario(row.scenario)}
								</td>
								<td class="px-3 py-2">
									{#if row.sites.length}
										{#each row.sites as s (s.id)}
											<a
												href={resolve(`alerts?site=${s.id}` as '')}
												class="mr-1 inline-flex items-center rounded-[3px] border border-line px-1.5 py-0.5 font-mono text-xs text-ink-2"
												title={`attributed via ${s.signal}`}>{s.hostname}</a
											>
										{/each}
									{:else}
										<span class="text-xs text-ink-3">unattributed</span>
									{/if}
								</td>
								<td class="px-3 py-2 text-right font-mono text-xs text-ink-2 tabular-nums">
									{row.activeDecisions}/{row.decisions}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="5" class="px-3 py-8 text-center text-sm text-ink-3">
									No alerts match. Local scenarios only — CAPI/list origins are excluded by design.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<div class="mt-3">
				<Pager
					page={data.list.page}
					pages={data.list.pages}
					total={data.list.total}
					perPage={data.list.perPage}
				/>
			</div>
		</Module>
	{/if}
</div>
