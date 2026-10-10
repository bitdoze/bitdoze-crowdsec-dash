<script lang="ts">
	import type { PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Pager from '#lib/components/Pager.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import ActivityChart from '#lib/components/ActivityChart.svelte';
	import { dayLabel } from '#lib/activity.ts';

	let { data }: PageProps = $props();
	const fmt = (d: Date) => new Date(d).toLocaleString();
	const sevState = { info: 'not_configured', warning: 'stale', critical: 'failed' } as const;
	const sevLabel = { info: 'Info', warning: 'Warning', critical: 'Critical' } as const;
</script>

<svelte:head><title>Notifications · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">Notifications</h1>
		<p class="mt-1 text-sm text-ink-3">
			{data.list.unread} unread · {data.list.total} total
		</p>
	</header>

	<div class="flex flex-wrap items-end gap-3">
		<form method="get" class="flex flex-wrap items-end gap-3">
			<label class="flex flex-col gap-1 text-xs text-ink-3">
				Class
				<select
					name="class"
					class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
				>
					<option value="" selected={!data.filters.class}>All</option>
					{#each ['outage', 'security', 'admin', 'job'] as c (c)}
						<option value={c} selected={data.filters.class === c}>{c}</option>
					{/each}
				</select>
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-3">
				Severity
				<select
					name="severity"
					class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
				>
					<option value="" selected={!data.filters.severity}>All</option>
					{#each ['info', 'warning', 'critical'] as s (s)}
						<option value={s} selected={data.filters.severity === s}>{s}</option>
					{/each}
				</select>
			</label>
			<label class="flex items-center gap-1.5 pb-1.5 text-sm text-ink-2">
				<input type="checkbox" name="unread" value="1" checked={data.filters.unread} />
				Unread only
			</label>
			<Button type="submit" size="sm">Filter</Button>
		</form>
		<form method="post" action="?/readAll" class="ml-auto">
			<Button type="submit" size="sm">Mark all read</Button>
		</form>
	</div>

	<Module title="Delivery trend — 14 days">
		<div class="grid gap-4 md:grid-cols-2">
			<div>
				<p class="mb-1 text-xs text-ink-3">Events per day</p>
				<ActivityChart data={data.eventTrend} xLabel={dayLabel} tickStride={3} />
			</div>
			<div>
				<p class="mb-1 text-xs text-ink-3">Failed deliveries per day</p>
				<ActivityChart data={data.failedTrend} xLabel={dayLabel} tickStride={3} />
			</div>
		</div>
	</Module>

	<div class="border border-rule bg-sheet">
		{#each data.list.rows as n (n.id)}
			{@const del = data.deliveries[n.id]}
			<div
				class="flex items-start gap-3 border-b border-rule px-4 py-3 last:border-0 {!n.readAt
					? 'bg-accent-tint/40'
					: ''}"
			>
				<div class="min-w-0 flex-1">
					<p class="text-sm {n.readAt ? 'text-ink-2' : 'font-medium text-ink'}">
						{n.title}
						{#if n.count > 1}
							<span class="text-xs text-ink-3">×{n.count}</span>
						{/if}
					</p>
					{#if n.body}
						<p class="mt-0.5 line-clamp-2 text-xs text-ink-3">{n.body}</p>
					{/if}
					<p class="mt-1 text-xs text-ink-3">
						{n.class}{n.site ? ` · ${data.siteNames[n.site] ?? n.site}` : ''} · {fmt(n.lastAt)}
						{#if del}
							· delivered: {del.delivered ?? 0} · pending: {del.pending ?? 0} · failed: {del.failed ??
								0}
						{/if}
					</p>
				</div>
				<div class="flex items-center gap-2">
					<Stamp state={sevState[n.severity] ?? 'not_configured'} label={sevLabel[n.severity]} />
					{#if n.href}
						<!-- href values are internal paths the server generates itself -->
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
						<a href={n.href} class="text-xs text-accent underline">Open</a>
					{/if}
					{#if !n.readAt}
						<form method="post" action="?/read">
							<input type="hidden" name="id" value={n.id} />
							<Button type="submit" size="sm">Mark read</Button>
						</form>
					{/if}
				</div>
			</div>
		{:else}
			<p class="px-4 py-10 text-center text-sm text-ink-3">
				No notifications{#if data.filters.unread}
					unread{/if}.
			</p>
		{/each}
	</div>

	<Pager
		page={data.filters.page}
		pages={Math.ceil(data.list.total / 50)}
		total={data.list.total}
		perPage={50}
	/>

	{#if data.failedDeliveries.length}
		<Module title="Failed deliveries">
			<div class="border border-rule bg-sheet">
				{#each data.failedDeliveries as f (f.id)}
					<div class="flex items-center gap-3 border-b border-rule px-4 py-2.5 last:border-0">
						<div class="min-w-0 flex-1">
							<p class="text-sm text-ink-2">{f.channel}</p>
							<p class="truncate text-xs text-failed">{f.lastError}</p>
						</div>
						{#if data.canOperate}
							<form method="post" action="?/retry">
								<input type="hidden" name="id" value={f.id} />
								<Button type="submit" size="sm">Retry</Button>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		</Module>
	{/if}
</div>
