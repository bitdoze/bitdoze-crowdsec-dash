<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Button from '#lib/components/Button.svelte';

	let { data, form }: PageProps = $props();
	const versionRows = $derived([
		['Dashboard', data.versions.app],
		['Node', data.versions.node],
		['CrowdSec', data.versions.crowdsec],
		['Host agent', data.versions.agent]
	] as [string, string | null][]);
	const retFields = $derived([
		['ret_notifications', 'Notifications', data.retention.notifications],
		['ret_jobs', 'Jobs', data.retention.jobs],
		['ret_audit', 'Audit', data.retention.audit],
		['ret_metrics', 'Metrics', data.retention.metrics],
		['ret_decisionRequests', 'Decision requests', data.retention.decisionRequests],
		['ret_alerts', 'Alert cache', data.retention.alerts],
		['ret_rollups', 'Hourly aggregates', data.retention.rollups]
	] as [string, string, number][]);

	const jobStamp: Record<string, 'verified' | 'stale' | 'failed' | 'not_configured'> = {
		queued: 'not_configured',
		running: 'stale',
		succeeded: 'verified',
		failed: 'failed',
		cancel_requested: 'stale',
		cancelled: 'not_configured',
		rollback_running: 'stale',
		rollback_failed: 'failed'
	};
	const fmt = (ms: number | null | Date) => (ms ? new Date(ms).toLocaleString() : '—');
	const kv = (row: unknown, keys: string[]) => {
		if (!row || typeof row !== 'object') return '—';
		const r = row as Record<string, unknown>;
		for (const k of keys) if (r[k] !== undefined && r[k] !== null) return String(r[k]);
		return '—';
	};
</script>

<svelte:head><title>System · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">System</h1>
		<p class="mt-1 text-sm text-ink-3">
			Engine inventory, the optional host agent, and durable jobs.
		</p>
	</header>

	{#if form?.notice}
		<div role="status" class="border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
			{form.notice}
		</div>
	{/if}

	<Module title="Host agent">
		{#if data.agent}
			<div class="flex flex-wrap items-center gap-2">
				<Stamp state="verified" label="Connected" />
				<span class="font-mono text-xs text-ink-3">
					v{data.agent.version} · protocol {data.agent.protocol}
				</span>
			</div>
			<div class="mt-3 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
				<p>
					<span class="text-ink-3">cscli bridge:</span>
					{#if data.agent.caps.cscli}
						<span class="font-mono text-xs">{data.agent.caps.cscliMode}</span>
						{#if data.agent.caps.cscliMode?.startsWith('docker:')}
							<span class="text-xs text-ink-3">— the agent holds the Docker socket</span>
						{/if}
					{:else}
						<span class="text-ink-3">not configured</span>
					{/if}
				</p>
				<p>
					<span class="text-ink-3">Scoped file roots:</span>
					{#if data.agent.caps.files}
						<span class="font-mono text-xs">{data.agent.caps.roots.join(', ')}</span>
					{:else}
						<span class="text-ink-3">none — file ops denied</span>
					{/if}
				</p>
				<p>
					<span class="text-ink-3">Reload targets:</span>
					{#if data.agent.caps.services.length}
						<span class="font-mono text-xs">{data.agent.caps.services.join(', ')}</span>
					{:else}
						<span class="text-ink-3">none — reloads denied</span>
					{/if}
				</p>
			</div>
		{:else if data.agentConfigured}
			<div class="flex flex-wrap items-center gap-2">
				<Stamp state="failed" label="Unreachable" />
				<span class="text-sm text-ink-3">
					AGENT_SOCKET is set but the agent did not answer — check the agent process and the token.
				</span>
			</div>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<Stamp state="not_configured" label="Not configured" />
				<span class="text-sm text-ink-3">
					Deploy the agent (server/agent.js) on the CrowdSec host and set AGENT_SOCKET + AGENT_TOKEN
					to unlock tier D: bouncers, Hub, allowlist writes, and managed applies.
				</span>
			</div>
		{/if}
	</Module>

	{#if data.agent?.caps.cscli}
		<div class="grid gap-5 lg:grid-cols-2">
			<Module title="Machines" bodyClass="py-0">
				{#if data.tierDError}
					<p class="py-4 text-sm text-degraded">cscli bridge error: {data.tierDError}</p>
				{:else}
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="border-b border-rule text-xs text-ink-3">
								<th class="py-2 pr-3 font-medium">Machine</th>
								<th class="px-3 py-2 font-medium">Last pull</th>
								<th class="px-3 py-2 font-medium">Version</th>
							</tr>
						</thead>
						<tbody>
							{#each data.machines as m (kv(m, ['machine_id', 'id', 'name']))}
								<tr class="border-b border-rule last:border-0">
									<td class="py-2 pr-3 font-mono text-xs">{kv(m, ['machine_id', 'id', 'name'])}</td>
									<td class="px-3 py-2 text-xs text-ink-3"
										>{kv(m, ['last_heartbeat', 'last_pull', 'updated_at'])}</td
									>
									<td class="px-3 py-2 font-mono text-xs">{kv(m, ['version'])}</td>
								</tr>
							{:else}
								<tr><td colspan="3" class="py-3 text-sm text-ink-3">No machines reported.</td></tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</Module>

			<Module title="Bouncers" bodyClass="py-0">
				{#if data.tierDError}
					<p class="py-4 text-sm text-degraded">—</p>
				{:else}
					<table class="w-full text-left text-sm">
						<thead>
							<tr class="border-b border-rule text-xs text-ink-3">
								<th class="py-2 pr-3 font-medium">Bouncer</th>
								<th class="px-3 py-2 font-medium">Type</th>
								<th class="px-3 py-2 font-medium">Last pull</th>
							</tr>
						</thead>
						<tbody>
							{#each data.bouncers as b (kv(b, ['name']))}
								<tr class="border-b border-rule last:border-0">
									<td class="py-2 pr-3 font-mono text-xs">{kv(b, ['name'])}</td>
									<td class="px-3 py-2 text-xs text-ink-3">{kv(b, ['type'])}</td>
									<td class="px-3 py-2 text-xs text-ink-3">{kv(b, ['last_pull', 'updated_at'])}</td>
								</tr>
							{:else}
								<tr><td colspan="3" class="py-3 text-sm text-ink-3">No bouncers reported.</td></tr>
							{/each}
						</tbody>
					</table>
				{/if}
			</Module>
		</div>

		<Module title="Hub items">
			{#if data.tierDError}
				<p class="text-sm text-degraded">—</p>
			{:else}
				<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
					{data.hubCount} installed items · simulation:
					{#if data.simulation.global === null}
						unknown
					{:else}
						<span class="font-mono">{data.simulation.global ? 'enabled' : 'disabled'}</span>
					{/if}
					{#if data.canOperate && data.simulation.global !== null}
						<form method="post" action="?/simulate" class="inline">
							<input type="hidden" name="enabled" value={data.simulation.global ? '0' : '1'} />
							<button type="submit" class="text-accent underline">
								{data.simulation.global ? 'disable globally' : 'enable globally'}
							</button>
						</form>
					{/if}
				</div>
				<div class="flex flex-wrap gap-1.5">
					{#each data.hubItems as item (kv(item, ['name']))}
						{@const nm = kv(item, ['name'])}
						{@const type = kv(item, ['type'])}
						<span
							class="bg-paper-2 inline-flex items-center gap-1.5 rounded-sm border border-rule px-2 py-0.5 font-mono text-xs"
						>
							{#if type !== '—'}<span class="text-ink-3">{type.replace(/s$/, '')}</span>{/if}
							{nm}
							{#if data.simulation.items[nm]}
								<span class="text-degraded">sim</span>
							{/if}
							{#if (type === 'scenarios' || type === 'scenario') && data.canOperate}
								<form method="post" action="?/simulate" class="inline">
									<input type="hidden" name="scope" value={nm} />
									<input
										type="hidden"
										name="enabled"
										value={data.simulation.items[nm] ? '0' : '1'}
									/>
									<button
										type="submit"
										class="text-accent underline"
										title={data.simulation.items[nm]
											? 'Stop simulating — scenario bans again'
											: 'Simulate — alerts without decisions'}
									>
										{data.simulation.items[nm] ? 'un-sim' : 'simulate'}
									</button>
								</form>
							{/if}
						</span>
					{:else}
						<span class="text-sm text-ink-3">No hub items installed.</span>
					{/each}
				</div>
			{/if}
		</Module>
	{/if}

	<Module title="Jobs">
		{#if data.jobs.length === 0}
			<p class="text-sm text-ink-3">
				No jobs yet — durable work like hub installs, allowlist writes, and managed applies appears
				here once the agent is connected.
			</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead>
						<tr class="border-b border-rule text-xs text-ink-3">
							<th class="py-2 pr-3 font-medium">Job</th>
							<th class="px-3 py-2 font-medium">State</th>
							<th class="px-3 py-2 font-medium">Created</th>
							<th class="px-3 py-2 font-medium">Result</th>
							{#if data.canOperate}<th class="py-2 pl-3 font-medium"></th>{/if}
						</tr>
					</thead>
					<tbody>
						{#each data.jobs as j (j.id)}
							<tr class="border-b border-rule last:border-0">
								<td class="py-2 pr-3">
									<span class="font-mono text-xs">{j.kind}</span>
									{#if j.attempts > 0}
										<span class="ml-1 text-xs text-ink-3">×{j.attempts + 1}</span>
									{/if}
								</td>
								<td class="px-3 py-2">
									<Stamp state={jobStamp[j.state] ?? 'not_configured'} label={j.state} />
								</td>
								<td class="px-3 py-2 text-xs text-ink-3">{fmt(j.createdAt)}</td>
								<td class="px-3 py-2 text-xs text-ink-3">
									<span class="line-clamp-1">{j.result ?? '—'}</span>
								</td>
								{#if data.canOperate}
									<td class="py-2 pl-3 whitespace-nowrap">
										{#if j.state === 'queued' || j.state === 'running'}
											<form method="post" action="?/cancelJob" class="inline">
												<input type="hidden" name="jobId" value={j.id} />
												<Button variant="secondary" size="sm" type="submit">Cancel</Button>
											</form>
										{:else if j.state === 'failed' || j.state === 'rollback_failed' || j.state === 'cancelled'}
											<form method="post" action="?/runAgain" class="inline">
												<input type="hidden" name="jobId" value={j.id} />
												<Button variant="secondary" size="sm" type="submit">Run again</Button>
											</form>
										{/if}
									</td>
								{/if}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Module>

	<Module title="Operations">
		<div class="grid gap-4 lg:grid-cols-2">
			<div>
				<p class="text-xs font-medium tracking-wide text-ink-3 uppercase">Component versions</p>
				<table class="mt-2 w-full text-left text-sm">
					<tbody>
						{#each versionRows as [label, v] (label)}
							<tr class="border-b border-rule last:border-0">
								<td class="py-1.5 pr-3 text-ink-3">{label}</td>
								<td class="py-1.5 font-mono text-xs">{v ?? 'not connected'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<div class="mt-3 flex flex-wrap items-center gap-3">
					{#if data.canOperate}
						<form method="post" action="?/checkUpdate">
							<Button type="submit" size="sm" variant="secondary">Check for updates</Button>
						</form>
					{/if}
					{#if data.updateCheck}
						<span class="text-xs text-ink-3">
							{#if data.updateCheck.error}
								Last check failed: {data.updateCheck.error}
							{:else if data.updateCheck.updateAvailable}
								Update available:
								<!-- release URL comes from the GitHub API response -->
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									href={data.updateCheck.latestUrl}
									class="text-accent underline"
									target="_blank"
									rel="noreferrer">{data.updateCheck.latestTag}</a
								>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								— review the release notes, then pull the new image or package and restart.
							{:else}
								Latest release {data.updateCheck.latestTag ?? 'unknown'} · checked {fmt(
									new Date(data.updateCheck.checkedAt)
								)}
							{/if}
						</span>
					{:else}
						<span class="text-xs text-ink-3">No release check yet — the worker checks daily.</span>
					{/if}
				</div>
			</div>

			<div>
				<p class="text-xs font-medium tracking-wide text-ink-3 uppercase">Disk &amp; data</p>
				{#if data.disk}
					<p class="mt-2 text-sm text-ink-2">
						{(data.disk.freeBytes / 1073741824).toFixed(1)} GiB free of
						{(data.disk.totalBytes / 1073741824).toFixed(1)} GiB ({data.disk.freePct.toFixed(0)}%)
						on
						<span class="font-mono text-xs">{data.disk.path}</span>
					</p>
				{/if}
				<form method="post" action="?/saveRetention" class="mt-3 space-y-2">
					<div class="flex flex-wrap items-end gap-3">
						{#each retFields as [name, label, val] (name)}
							<label class="flex flex-col gap-1 text-xs text-ink-3">
								{label} (days)
								<input
									type="number"
									{name}
									value={val}
									min="1"
									max="3650"
									class="w-24 rounded-[3px] border border-line bg-sheet px-2 py-1.5 text-sm text-ink"
								/>
							</label>
						{/each}
					</div>
					<div class="flex items-center gap-2">
						{#if data.canConfigure}
							<Button type="submit" size="sm" variant="secondary">Save retention</Button>
						{/if}
						{#if data.canOperate}
							<Button type="submit" size="sm" variant="secondary" formaction="?/runRetention">
								Run cleanup now
							</Button>
						{/if}
						{#if data.retentionLastRun}
							<span class="text-xs text-ink-3">last run {fmt(new Date(data.retentionLastRun))}</span
							>
						{/if}
					</div>
				</form>
			</div>
		</div>

		<div class="mt-4 flex flex-wrap items-center gap-3 border-t border-rule pt-3">
			<a
				href={resolve('/(app)/system/backup.db')}
				class="rounded-[3px] border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-sheet"
				>Download database backup</a
			>
			<a
				href={resolve('/(app)/system/support-bundle.json')}
				class="rounded-[3px] border border-line px-3 py-1.5 text-sm text-ink-2 hover:bg-sheet"
				>Download support bundle</a
			>
			<span class="text-xs text-ink-3">
				{data.backups.length} backup{data.backups.length === 1 ? '' : 's'} kept on the server
				{#if data.backups[0]}— newest {fmt(data.backups[0].at)}{/if}
			</span>
		</div>
	</Module>

	<Module title="Recent audit">
		<table class="w-full text-left text-sm">
			<thead>
				<tr class="border-b border-rule text-xs text-ink-3">
					<th class="py-2 pr-3 font-medium">When</th>
					<th class="px-3 py-2 font-medium">Action</th>
					<th class="px-3 py-2 font-medium">IP</th>
				</tr>
			</thead>
			<tbody>
				{#each data.recentAudit as a (a.id)}
					<tr class="border-b border-rule last:border-0">
						<td class="py-1.5 pr-3 text-xs whitespace-nowrap text-ink-3">{fmt(a.at)}</td>
						<td class="px-3 py-1.5 font-mono text-xs">{a.action}</td>
						<td class="px-3 py-1.5 font-mono text-xs text-ink-3">{a.ip ?? '—'}</td>
					</tr>
				{:else}
					<tr><td colspan="3" class="py-3 text-sm text-ink-3">Nothing recorded yet.</td></tr>
				{/each}
			</tbody>
		</table>
	</Module>
</div>
