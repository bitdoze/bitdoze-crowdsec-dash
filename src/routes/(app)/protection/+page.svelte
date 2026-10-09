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

	const stepStamp = {
		done: 'verified',
		current: 'stale',
		todo: 'not_configured'
	} as const;
	const stepLabel = { done: 'done', current: 'current', todo: 'pending' } as const;

	function stepHref(step: (typeof data.steps)[number]) {
		switch (step.target) {
			case 'users':
				return resolve('/(app)/settings/users');
			case 'crowdsec':
				return resolve('/(app)/settings/crowdsec');
			case 'sites':
				return resolve('/(app)/sites');
			case 'site':
				return step.siteId ? resolve('/(app)/sites/[id]', { id: step.siteId }) : null;
			case 'notifications':
				return resolve('/(app)/settings/notifications');
			default:
				return null;
		}
	}
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

	<Module title="Setup">
		<p class="mb-3 text-xs text-ink-3">
			{data.progress.done} of {data.progress.total} steps complete — resumable; every step stays revisitable
			below and on the site checklists.
		</p>
		<ol class="space-y-2">
			{#each data.steps as step, i (step.id)}
				{@const href = stepHref(step)}
				<li
					class="flex items-start gap-3 rounded-sm border border-rule px-3 py-2.5 {step.state ===
					'current'
						? 'bg-paper-2'
						: ''}"
				>
					<span class="mt-0.5 w-5 shrink-0 text-center font-mono text-xs text-ink-3 tabular-nums"
						>{i + 1}</span
					>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							{#if href}
								<a {href} class="text-sm font-medium text-accent underline">{step.title}</a>
							{:else}
								<span class="text-sm font-medium">{step.title}</span>
							{/if}
							<Stamp state={stepStamp[step.state]} label={stepLabel[step.state]} />
						</div>
						<p class="mt-0.5 text-xs text-ink-3">{step.detail}</p>
						{#if step.hint}
							<code
								class="bg-paper-2 mt-1.5 block w-fit rounded-sm border border-rule px-2 py-1 font-mono text-xs text-ink-2"
								>{step.hint}</code
							>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	</Module>

	<Module title="Site checks">
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
