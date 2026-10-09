<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import SyncBanner from '#lib/components/SyncBanner.svelte';
	import Pager from '#lib/components/Pager.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';

	let { data, form }: PageProps & { form: ActionData } = $props();
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');
	const isIp = (v: string | null) => !!v && /^[0-9a-fA-F:./]+$/.test(v);
	const reqState = {
		pushed: 'stale',
		confirmed: 'verified',
		failed: 'failed',
		removing: 'stale',
		removed: 'not_configured'
	} as const;
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
	{#if form?.guide}
		<div class="border border-rule bg-sheet p-3">
			<p class="text-sm font-medium text-ink">{form.guide.title}</p>
			<ol class="mt-1 list-decimal space-y-1 pl-4 text-sm text-ink-2">
				{#each form.guide.steps as step, i (i)}
					<li>{step}</li>
				{/each}
			</ol>
			{#if form.guide.code}
				<div class="mt-2"><CodeBlock code={form.guide.code} /></div>
			{/if}
		</div>
	{/if}

	{#if data.connected}
		{#if data.canOperate}
			<Module title="New decision">
				<form method="post" action="?/ban" class="flex flex-wrap items-end gap-3">
					<Field
						label="IP or CIDR"
						name="target"
						required
						placeholder="203.0.113.7 or 203.0.113.0/24"
						hint="Applies server-wide across every configured entry point."
						class="w-64"
					/>
					<label class="flex flex-col gap-1 text-xs text-ink-3">
						Type
						<select
							name="type"
							class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
						>
							<option value="ban">ban</option>
							<option value="captcha">captcha</option>
						</select>
						<span class="max-w-44 text-[11px] leading-snug text-ink-3">
							captcha only works where a supporting bouncer fronts the site
						</span>
					</label>
					<Field
						label="Duration"
						name="duration"
						required
						placeholder="4h"
						hint="e.g. 4h, 4h30m, 2d — max 30d."
						class="w-28"
					/>
					<Field label="Reason" name="reason" placeholder="optional" class="w-56" />
					<Button variant="primary" type="submit">Add decision</Button>
				</form>
				<div class="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
					<span>
						Your address: <span class="font-mono text-ink-2">{data.clientIp.value}</span>
						{#if data.clientIp.private}
							— looks like a private/proxy address; check real client IP handling before banning.
						{/if}
					</span>
					<form method="post" action="?/allowlistMe">
						<Button type="submit" size="sm">Allowlist my current IP</Button>
					</form>
				</div>
			</Module>

			{#if data.requests.length}
				<Module title="Decision requests">
					<div class="overflow-x-auto border border-rule bg-sheet">
						<table class="w-full border-collapse text-sm">
							<thead>
								<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
									<th class="px-3 py-2 font-medium">Value</th>
									<th class="px-3 py-2 font-medium">Request</th>
									<th class="px-3 py-2 font-medium">State</th>
									<th class="px-3 py-2 font-medium">Detail</th>
								</tr>
							</thead>
							<tbody>
								{#each data.requests as r (r.id)}
									<tr class="border-b border-rule last:border-0">
										<td class="px-3 py-2 font-mono text-xs text-ink-2">{r.value}</td>
										<td class="px-3 py-2 text-xs text-ink-2">
											{r.type} · {r.state === 'removing' || r.state === 'removed'
												? 'remove'
												: `${r.durationS}s`}
											{#if r.reason}<span class="text-ink-3"> — {r.reason}</span>{/if}
										</td>
										<td class="px-3 py-2">
											<Stamp
												state={reqState[r.state] ?? 'not_configured'}
												label={{
													pushed: 'Pushed',
													confirmed: 'Confirmed',
													failed: 'Failed',
													removing: 'Removing',
													removed: 'Removed'
												}[r.state]}
											/>
										</td>
										<td class="px-3 py-2 text-xs text-ink-3">
											{#if r.state === 'pushed'}
												awaiting next sync to confirm
											{:else if r.state === 'failed'}
												<span class="text-failed">{r.error}</span>
											{:else}
												{r.upstreamId ? `upstream id ${r.upstreamId}` : ''}
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</Module>
			{/if}
		{/if}

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
							{#if data.canOperate}<th class="px-3 py-2 font-medium"></th>{/if}
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
								{#if data.canOperate}
									<td class="px-3 py-2">
										{#if !row.expired}
											<form method="post" action="?/unban">
												<input type="hidden" name="upstreamId" value={row.upstreamId} />
												<input type="hidden" name="value" value={row.value} />
												<Button type="submit" size="sm">Remove</Button>
											</form>
										{/if}
									</td>
								{/if}
							</tr>
						{:else}
							<tr>
								<td
									colspan={data.canOperate ? 7 : 6}
									class="px-3 py-8 text-center text-sm text-ink-3"
								>
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
