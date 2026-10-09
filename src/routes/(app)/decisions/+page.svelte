<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';
	import Pager from '#lib/components/Pager.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';

	let { data }: PageProps = $props();
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
	const isIp = (v: string | null) => !!v && /^[0-9a-fA-F:./]+$/.test(v);
</script>

<svelte:head><title>Decisions · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header
		class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule-strong pb-4"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Decisions</h1>
			<p class="mt-1 text-sm text-ink-3">
				{data.list.total.toLocaleString()} decisions on synced alerts
				{data.freshness.lastSuccessAt
					? `· synced ${new Date(data.freshness.lastSuccessAt).toLocaleString()}`
					: ''}
			</p>
		</div>
	</header>

	<SyncBanner connected={data.connected} freshness={data.freshness} />

	{#if data.connected}
		<form method="get" class="flex flex-wrap items-end gap-3">
			<label class="flex flex-col gap-1 text-xs text-ink-3">
				Search
				<input
					name="q"
					value={data.filters.q}
					placeholder="IP, scenario, origin…"
					class="w-56 rounded-[3px] border border-line bg-sheet px-2 py-1.5 font-mono text-sm text-ink"
				/>
			</label>
			<label class="flex items-center gap-2 text-sm text-ink-2">
				<input type="checkbox" name="expired" value="1" checked={data.filters.expired} />
				Include expired
			</label>
			<Button type="submit">Filter</Button>
		</form>

		<Module title="Decision log">
			<div class="overflow-x-auto border border-rule bg-sheet">
				<table class="w-full border-collapse text-sm">
					<thead>
						<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
							<th class="px-3 py-2 font-medium">Value</th>
							<th class="px-3 py-2 font-medium">Type</th>
							<th class="px-3 py-2 font-medium">Origin</th>
							<th class="px-3 py-2 font-medium">Scenario</th>
							<th class="px-3 py-2 font-medium">Expires</th>
							<th class="px-3 py-2 font-medium">State</th>
						</tr>
					</thead>
					<tbody>
						{#each data.list.rows as row (row.upstreamId)}
							<tr class="border-b border-rule last:border-0">
								<td class="px-3 py-2">
									{#if row.value && isIp(row.value)}
										<a
											href={resolve('/(app)/ip/[ip]', { ip: row.value })}
											class="font-mono text-xs text-accent underline">{row.value}</a
										>
									{:else}
										<span class="font-mono text-xs text-ink-2">{row.value ?? '—'}</span>
									{/if}
									{#if row.scope}
										<span class="ml-1 text-xs text-ink-3">{row.scope}</span>
									{/if}
								</td>
								<td class="px-3 py-2 font-mono text-xs text-ink-2">{row.type ?? '—'}</td>
								<td class="px-3 py-2 font-mono text-xs text-ink-2">{row.origin ?? '—'}</td>
								<td class="px-3 py-2 font-mono text-xs break-words text-ink-2">
									{(row.scenario ?? '—').replace(/^crowdsecurity\//, '')}
								</td>
								<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-2">
									{fmt(row.until)}
								</td>
								<td class="px-3 py-2">
									<Stamp
										state={row.expired ? 'stale' : 'verified'}
										label={row.expired ? 'Expired' : 'Active'}
									/>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="px-3 py-8 text-center text-sm text-ink-3">
									No decisions match.
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
