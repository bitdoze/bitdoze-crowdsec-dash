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
	const isIp = (v: string | null) => !!v && /^[0-9a-fA-F:.]+$/.test(v);
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
					{#if data.agentCscli}
						<form method="post" action="?/allowlistMeAgent">
							<Button type="submit" size="sm">Allowlist via agent</Button>
						</form>
					{/if}
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

		<Module title="Enforced decisions — live">
			<p class="mb-3 text-xs text-ink-3">
				Live <span class="font-mono">/v1/decisions</span> feed — everything this LAPI enforces right
				now, including the community blocklist (CAPI/lists origins are centrally managed; unban via
				allowlist).
				{#if data.enforced.approxTotal !== null}
					<span class="font-mono text-ink-2">
						~{data.enforced.approxTotal.toLocaleString()} enforced (per metrics)
					</span>
				{/if}
			</p>

			{#if data.enforced.state === 'no_key'}
				<p class="text-sm text-ink-3">
					<Stamp state="not_configured" label="N/C" /> No observer bouncer key configured — add one under
					<a href={resolve('/(app)/settings/crowdsec')} class="text-accent underline"
						>Settings → CrowdSec</a
					> to browse the enforced set.
				</p>
			{:else if data.enforced.state === 'no_client'}
				<p class="text-sm text-ink-3">
					<Stamp state="not_configured" label="N/C" /> Not connected to a LAPI.
				</p>
			{:else if data.enforced.state === 'error'}
				<p class="text-sm text-failed">Feed query failed: {data.enforced.error}</p>
			{:else}
				<form method="get" class="mb-3 flex flex-wrap items-end gap-3">
					<label class="flex flex-col gap-1 text-xs text-ink-3">
						Search
						<input
							name="fq"
							value={data.feedFilters.q}
							placeholder="IP, CIDR, scenario or value"
							class="w-56 rounded-[3px] border border-line bg-sheet px-2 py-1.5 font-mono text-sm text-ink"
						/>
					</label>
					<label class="flex flex-col gap-1 text-xs text-ink-3">
						Scope
						<select
							name="fs"
							class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
						>
							<option value="" selected={data.feedFilters.scope === ''}>any</option>
							{#each ['Ip', 'Range', 'Country', 'AS'] as s (s)}
								<option value={s} selected={data.feedFilters.scope === s}>{s}</option>
							{/each}
						</select>
					</label>
					<label class="flex flex-col gap-1 text-xs text-ink-3">
						Type
						<select
							name="ft"
							class="rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
						>
							<option value="" selected={data.feedFilters.type === ''}>any</option>
							{#each ['ban', 'captcha'] as t (t)}
								<option value={t} selected={data.feedFilters.type === t}>{t}</option>
							{/each}
						</select>
					</label>
					<Button type="submit">Filter</Button>
				</form>

				<div class="overflow-x-auto border border-rule bg-sheet">
					<table class="w-full border-collapse text-sm">
						<thead>
							<tr class="border-b border-rule-strong text-left text-xs text-ink-3">
								<th class="px-3 py-2 font-medium">Value</th>
								<th class="px-3 py-2 font-medium">Type</th>
								<th class="px-3 py-2 font-medium">Origin</th>
								<th class="px-3 py-2 font-medium">Reason</th>
								<th class="px-3 py-2 font-medium">Remaining</th>
								{#if data.canOperate}<th class="px-3 py-2 font-medium"></th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each data.enforced.rows as row (row.id)}
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
										{#if row.scope}<span class="ml-1 text-xs text-ink-3">{row.scope}</span>{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs">
										<span
											class={row.type === 'ban'
												? 'text-failed'
												: row.type === 'captcha'
													? 'text-stale'
													: 'text-ink-2'}>{row.type ?? '—'}</span
										>
										{#if row.simulated}
											<span
												class="ml-1 text-stale"
												title="Simulated — flagged in the feed, never enforced">sim</span
											>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs text-ink-2">{row.origin ?? '—'}</td>
									<td class="px-3 py-2 font-mono text-xs break-words text-ink-2">
										{(row.scenario ?? '—').replace(/^crowdsecurity\//, '')}
									</td>
									<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-ink-2">
										{row.duration ?? '—'}
									</td>
									{#if data.canOperate}
										<td class="px-3 py-2">
											{#if row.removable && row.id}
												<form method="post" action="?/unban">
													<input type="hidden" name="upstreamId" value={row.id} />
													<input type="hidden" name="value" value={row.value} />
													<Button type="submit" size="sm">Remove</Button>
												</form>
											{:else}
												<span
													class="text-xs text-ink-3"
													title="Centrally managed — remove by allowlisting the address"
													>central</span
												>
											{/if}
										</td>
									{/if}
								</tr>
							{:else}
								<tr>
									<td
										colspan={data.canOperate ? 6 : 5}
										class="px-3 py-8 text-center text-sm text-ink-3"
									>
										No enforced decisions match.
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if data.enforced.page > 1 || data.enforced.hasNext}
					<nav class="mt-3 flex items-center gap-2 text-sm" aria-label="Feed pagination">
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						{#if data.enforced.page > 1}
							<a
								href={resolve('/(app)/decisions') +
									`?${new URLSearchParams({
										...(data.feedFilters.q ? { fq: data.feedFilters.q } : {}),
										...(data.feedFilters.scope ? { fs: data.feedFilters.scope } : {}),
										...(data.feedFilters.type ? { ft: data.feedFilters.type } : {}),
										...(data.enforced.page > 2 ? { fpage: String(data.enforced.page - 1) } : {})
									}).toString()}`}
								class="border border-line bg-sheet px-2 py-1 text-ink-2 hover:bg-panel">Previous</a
							>
						{/if}
						<span class="px-1 font-mono text-xs text-ink-3 tabular-nums">
							page {data.enforced.page}
						</span>
						{#if data.enforced.hasNext}
							<a
								href={resolve('/(app)/decisions') +
									`?${new URLSearchParams({
										...(data.feedFilters.q ? { fq: data.feedFilters.q } : {}),
										...(data.feedFilters.scope ? { fs: data.feedFilters.scope } : {}),
										...(data.feedFilters.type ? { ft: data.feedFilters.type } : {}),
										fpage: String(data.enforced.page + 1)
									}).toString()}`}
								class="border border-line bg-sheet px-2 py-1 text-ink-2 hover:bg-panel">Next</a
							>
						{/if}
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</nav>
				{/if}
			{/if}
		</Module>

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
			<!-- eslint-disable svelte/no-navigation-without-resolve -->
			<a
				href={resolve('/(app)/decisions/export.csv') +
					`?q=${encodeURIComponent(data.filters.q)}${data.filters.expired ? '&expired=1' : ''}`}
				class="rounded-[3px] border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-sheet"
				>Export CSV</a
			>
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
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
