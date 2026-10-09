<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';

	let { data, form }: PageProps = $props();
	const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');
</script>

<svelte:head><title>Sites · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">Sites</h1>
		<p class="mt-1 text-sm text-ink-3">
			{data.sites.length} known — manual entries plus hostnames learned from alert context.
		</p>
	</header>

	{#if form?.message}
		<div role="alert" class="border border-rule bg-sheet px-4 py-3 text-sm text-red-700">
			{form.message}
		</div>
	{:else if form?.notice}
		<div role="status" class="border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
			{form.notice}
		</div>
	{/if}

	<Module title="Inventory">
		{#if data.sites.length === 0}
			<p class="text-sm text-ink-3">
				No sites yet. Add one below, or connect CrowdSec — alert context teaches the inventory
				automatically.
			</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead>
						<tr class="border-b border-rule text-xs text-ink-3">
							<th class="py-2 pr-3 font-medium">Hostname</th>
							<th class="px-3 py-2 font-medium">Proxy</th>
							<th class="px-3 py-2 font-medium">Runtime</th>
							<th class="px-3 py-2 font-medium">Cloudflare</th>
							<th class="px-3 py-2 font-medium">Last alert</th>
							<th class="px-3 py-2 font-medium">Checks</th>
							<th class="px-3 py-2 font-medium">Source</th>
							{#if data.canOperate}<th class="py-2 pl-3 font-medium"></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each data.sites as s (s.id)}
							<tr class="border-b border-rule last:border-0">
								<td class="py-2 pr-3">
									<a
										href={resolve('/(app)/sites/[id]', { id: s.id })}
										class="font-mono text-accent underline">{s.hostname}</a
									>
								</td>
								<td class="px-3 py-2">{s.proxy}</td>
								<td class="px-3 py-2">{s.runtime}</td>
								<td class="px-3 py-2">{s.cloudflare ? 'yes' : '—'}</td>
								<td class="px-3 py-2 text-ink-3">{fmt(s.lastAlertAt)}</td>
								<td class="px-3 py-2">
									{#if s.checks.total === 0}
										<Stamp state="not_configured" label="Not checked" />
									{:else if s.checks.verified === s.checks.total}
										<Stamp state="verified" label="{s.checks.verified}/{s.checks.total}" />
									{:else}
										<Stamp state="stale" label="{s.checks.verified}/{s.checks.total}" />
									{/if}
								</td>
								<td class="px-3 py-2 text-xs text-ink-3">{s.source}</td>
								{#if data.canOperate}
									<td class="py-2 pl-3">
										<form method="post" action="?/detect" class="inline">
											<input type="hidden" name="siteId" value={s.id} />
											<Button variant="secondary" size="sm" type="submit">Detect</Button>
										</form>
										<form method="post" action="?/remove" class="inline">
											<input type="hidden" name="siteId" value={s.id} />
											<Button variant="secondary" size="sm" type="submit">Remove</Button>
										</form>
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Module>

	{#if data.canOperate}
		<Module title="Add site">
			<form method="post" action="?/add" class="flex flex-wrap items-end gap-3">
				<Field label="Hostname" name="hostname" placeholder="blog.example.com" required />
				<FilterSelect
					label="Proxy"
					name="proxy"
					value="unknown"
					options={[
						{ value: 'unknown', label: 'detect later' },
						{ value: 'caddy', label: 'Caddy' },
						{ value: 'traefik', label: 'Traefik' },
						{ value: 'nginx', label: 'Nginx' },
						{ value: 'other', label: 'Other' }
					]}
				/>
				<FilterSelect
					label="Runs"
					name="runtime"
					value="unknown"
					options={[
						{ value: 'unknown', label: 'unknown' },
						{ value: 'native', label: 'native' },
						{ value: 'docker', label: 'Docker' }
					]}
				/>
				<label class="flex items-center gap-2 pb-2 text-sm text-ink-2">
					<input type="checkbox" name="cloudflare" class="accent-accent" /> behind Cloudflare
				</label>
				<Button variant="primary" type="submit">Add site</Button>
			</form>
		</Module>
	{/if}
</div>
