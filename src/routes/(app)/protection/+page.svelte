<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';

	let { data }: PageProps = $props();

	const cellState = {
		not_run: 'not_configured',
		verified: 'verified',
		failed: 'failed',
		stale: 'stale',
		not_applicable: 'not_configured'
	} as const;
	const cellLabel = {
		not_run: '—',
		verified: '✓',
		failed: '✗',
		stale: '~',
		not_applicable: 'N/A'
	} as const;
</script>

<svelte:head><title>Protection · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">Protection</h1>
		<p class="mt-1 text-sm text-ink-3">
			Sites × verification checks. Click a site for its guided setup artifacts.
		</p>
	</header>

	<SyncBanner connected={data.connected} freshness={data.freshness} />

	<Module title="Checklist">
		{#if data.matrix.length === 0}
			<p class="text-sm text-ink-3">
				No sites yet — <a href={resolve('/(app)/sites')} class="text-accent underline">add one</a>
				or connect CrowdSec and let alert context teach the inventory.
			</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead>
						<tr class="border-b border-rule text-xs text-ink-3">
							<th class="py-2 pr-3 font-medium">Site</th>
							{#each data.checkDefs as def (def.id)}
								<th class="px-2 py-2 font-medium" title={def.detail}>{def.title}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each data.matrix as row (row.site.id)}
							<tr class="border-b border-rule last:border-0">
								<td class="py-2 pr-3">
									<a
										href={resolve('/(app)/sites/[id]', { id: row.site.id })}
										class="font-mono text-accent underline">{row.site.hostname}</a
									>
									<span class="ml-1 text-xs text-ink-3">{row.site.proxy}/{row.site.runtime}</span>
								</td>
								{#each data.checkDefs as def (def.id)}
									{@const c = row.checks.find((r) => r.checkId === def.id)}
									{@const st = c?.state ?? 'not_run'}
									<td class="px-2 py-2">
										<Stamp state={cellState[st]} label="{cellLabel[st]} {st.replace('_', ' ')}" />
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Module>
</div>
