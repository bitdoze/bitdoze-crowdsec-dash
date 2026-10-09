<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import { REMEDIATION_PRESETS, WAF_LEVELS } from '#lib/sites.ts';
	import { bucketHourLabel, dayLabel } from '#lib/activity.ts';
	import ActivityChart from '#lib/components/ActivityChart.svelte';

	let { data, form }: PageProps = $props();

	const checkState = {
		not_run: 'not_configured',
		verified: 'verified',
		failed: 'failed',
		stale: 'stale',
		not_applicable: 'not_configured'
	} as const;
	const checkLabel = {
		not_run: 'Not run',
		verified: 'Verified',
		failed: 'Failed',
		stale: 'Partial',
		not_applicable: 'N/A'
	} as const;
	const artifactState = {
		not_applied: 'not_configured',
		applied: 'stale',
		verified: 'verified'
	} as const;
	const artifactLabel = {
		not_applied: 'Not applied',
		applied: 'Applied',
		verified: 'Verified'
	} as const;
	const fmt = (d: Date | null) => (d ? new Date(d).toLocaleString() : '—');

	function checkFor(checkId: string) {
		return data.checks.find((c) => c.checkId === checkId);
	}
	const adopted = $derived(
		(data.detection?.adopted as { proxy?: string; at?: string } | undefined)?.proxy
	);
	// Managed writes into the proxy's own config space need adoption (spec 8).
	const proxyRoot = (p: string | null) => data.proxyRoots.some((r) => p?.startsWith(r));
	// Drift badge per artifact: compare the agent-observed hash (drift-
	// normalized) with the desired content's drift hash.
	function driftOf(a: {
		expectedHash: string;
		observedHash: string | null;
		observedAt: Date | null;
	}) {
		if (!a.observedAt) return null;
		if (a.observedHash === 'missing') return { state: 'failed' as const, label: 'absent' };
		if (a.observedHash === a.expectedHash) return { state: 'verified' as const, label: 'in sync' };
		return { state: 'stale' as const, label: 'drifted' };
	}
	// Downsampled rollup → shared chart; day labels for the 30-day range.
	const actLabel = $derived(data.activity.range === '30d' ? dayLabel : bucketHourLabel);
	const actPoints = $derived(
		data.activity.buckets.map((b) => ({
			at: new Date(b.at).toISOString(),
			alerts: b.total,
			decisions: 0
		}))
	);
</script>

<svelte:head><title>{data.site.hostname} · Sites · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<p class="text-xs text-ink-3">
			<a href={resolve('/(app)/sites')} class="text-accent underline">Sites</a> · protection plan
		</p>
		<h1 class="mt-1 font-mono text-xl font-semibold tracking-tight">{data.site.hostname}</h1>
		<p class="mt-1 text-sm text-ink-3">
			{data.site.proxy} · {data.site.runtime} · {data.site.cloudflare
				? 'behind Cloudflare'
				: 'no Cloudflare'} · source: {data.site.source}
		</p>
	</header>

	{#if form?.notice}
		<div role="status" class="border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
			{form.notice}
		</div>
	{/if}

	<div class="grid gap-4 lg:grid-cols-2">
		<Module title="Topology">
			{#if data.canOperate}
				<form method="post" action="?/configure" class="flex flex-wrap items-end gap-3">
					<FilterSelect
						label="Proxy"
						name="proxy"
						value={data.site.proxy}
						options={[
							{ value: 'unknown', label: 'unknown' },
							{ value: 'caddy', label: 'Caddy' },
							{ value: 'traefik', label: 'Traefik' },
							{ value: 'nginx', label: 'Nginx' },
							{ value: 'other', label: 'Other' }
						]}
					/>
					<FilterSelect
						label="Runs"
						name="runtime"
						value={data.site.runtime}
						options={[
							{ value: 'unknown', label: 'unknown' },
							{ value: 'native', label: 'native' },
							{ value: 'docker', label: 'Docker' }
						]}
					/>
					<label class="flex items-center gap-2 pb-2 text-sm text-ink-2">
						<input
							type="checkbox"
							name="cloudflare"
							checked={data.site.cloudflare}
							class="accent-accent"
						/> behind Cloudflare
					</label>
					<Button variant="primary" type="submit">Save + regenerate</Button>
				</form>
				<form method="post" action="?/detect" class="mt-3 flex flex-wrap items-end gap-3">
					<Field
						label="Probe URL (optional)"
						name="probeUrl"
						placeholder="https://{data.site.hostname}"
						class="w-64"
					/>
					<Button variant="secondary" type="submit">Detect topology</Button>
				</form>
			{:else}
				<p class="text-sm text-ink-3">Operator permissions needed to change topology.</p>
			{/if}
			{#if data.canOperate && ['caddy', 'nginx'].includes(data.site.proxy)}
				{#if adopted === data.site.proxy}
					<p class="mt-3 text-xs text-ink-3">
						Adopted for managed config
						{#if data.detection?.confDir}— dir <code>{data.detection.confDir as string}</code>{/if}
						— proxy-config artifacts can be applied through the agent (validate + reload when a service
						target is declared).
					</p>
				{:else}
					<form method="post" action="?/adoptProxy" class="mt-3 flex flex-wrap items-end gap-3">
						<Field
							label="Managed config dir"
							name="confDir"
							value={(data.detection?.confDir as string) ??
								(data.site.proxy === 'caddy' ? '/etc/caddy/crowdsec' : '/etc/nginx/conf.d')}
							class="w-64"
						/>
						<Button variant="secondary" size="sm" type="submit">
							Adopt {data.site.proxy} for managed config
						</Button>
					</form>
					<p class="mt-1 text-[11px] text-ink-3">
						Required before the agent writes into the proxy config dir — artifacts only ever add new
						files; your existing config is never edited.
					</p>
				{/if}
			{/if}
			{#if data.detection}
				<p class="mt-3 text-xs text-ink-3">
					Last probe {(data.detection.at as string) ?? ''} — {data.detection.probedUrl as string}:
					{Object.keys((data.detection.headers as Record<string, string>) ?? {}).join(', ') ||
						'no identifying headers'}
					{#if data.detection.error}· error: {data.detection.error}{/if}
				</p>
			{/if}
		</Module>

		<Module title="Docker topology">
			{#if data.agent?.caps.docker}
				{#if data.dockerDiscovery}
					{@const d = data.dockerDiscovery as {
						at: string;
						dynamicDir?: string;
						traefik?: { container: string; image: string; bouncerPlugin: boolean } | null;
						crowdsec?: { container: string } | null;
						proxies?: Array<{ kind: string; container: string; image: string }>;
						apps?: Array<{
							container: string;
							router: string;
							hostnames: string[];
							middlewares: string[];
							publishedPorts: string[];
						}>;
					}}
					<dl class="space-y-1.5 text-sm">
						<div class="flex justify-between gap-3">
							<dt class="text-ink-3">Traefik</dt>
							<dd class="font-mono text-ink">
								{d.traefik ? `${d.traefik.container} · ${d.traefik.image}` : 'not found'}
								{#if d.traefik}
									<span class="text-ink-3">
										· bouncer plugin {d.traefik.bouncerPlugin ? 'loaded' : 'not seen'}
									</span>
								{/if}
							</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-ink-3">CrowdSec</dt>
							<dd class="font-mono text-ink">{d.crowdsec?.container ?? 'not found'}</dd>
						</div>
						<div class="flex justify-between gap-3">
							<dt class="text-ink-3">This site</dt>
							<dd class="text-right font-mono text-ink">
								{#each (d.apps ?? []).filter( (a) => a.hostnames.includes(data.site.hostname) ) as app (app.router)}
									{app.container} · router {app.router}
									{#if app.middlewares.length}
										· mw {app.middlewares.join(',')}
									{/if}
									{#if app.publishedPorts.length}
										<span class="text-failed"> · bypass: {app.publishedPorts.join(', ')}</span>
									{/if}
								{:else}
									<span class="text-ink-3">no router advertises {data.site.hostname}</span>
								{/each}
							</dd>
						</div>
						{#each (d.apps ?? []).filter((a) => !a.hostnames.includes(data.site.hostname) && a.publishedPorts.length) as app (app.router)}
							<div class="flex justify-between gap-3">
								<dt class="text-ink-3">{app.hostnames.join(', ') || app.container}</dt>
								<dd class="text-right font-mono text-failed">
									publishes {app.publishedPorts.join(', ')} — bypasses Traefik
								</dd>
							</div>
						{/each}
						<div class="flex justify-between gap-3">
							<dt class="text-ink-3">Other proxies</dt>
							<dd class="text-right font-mono text-ink">
								{(d.proxies ?? []).map((p) => `${p.kind} · ${p.container}`).join(' ') || ''}
								{#if !(d.proxies ?? []).length}
									<span class="text-ink-3">no caddy/nginx containers</span>
								{/if}
							</dd>
						</div>
					</dl>
					<p class="mt-2 text-[11px] text-ink-3">discovered {fmt(new Date(d.at))}</p>
				{:else}
					<p class="text-sm text-ink-3">
						No docker inventory captured yet — discovery reads <code>docker ps</code> through the agent
						and matches this site's hostname against Traefik router labels.
					</p>
				{/if}
				{#if data.canOperate}
					<form method="post" action="?/dockerDiscover" class="mt-3 flex flex-wrap items-end gap-3">
						<Field
							label="Traefik dynamic dir"
							name="dynamicDir"
							value={(data.dockerDiscovery as { dynamicDir?: string } | null)?.dynamicDir ??
								'/etc/traefik/dynamic'}
							class="w-64"
						/>
						<Button variant="secondary" size="sm" type="submit">Discover via agent</Button>
					</form>
					{#if data.dockerDiscovery && data.site.proxy !== 'traefik'}
						<form method="post" action="?/adoptTraefik" class="mt-2">
							<input
								type="hidden"
								name="dynamicDir"
								value={(data.dockerDiscovery as { dynamicDir?: string }).dynamicDir ??
									'/etc/traefik/dynamic'}
							/>
							<Button variant="secondary" size="sm" type="submit">Adopt Traefik topology</Button>
						</form>
					{/if}
				{/if}
			{:else}
				<p class="text-sm text-ink-3">
					Docker discovery needs the host agent with <code>AGENT_DOCKER=1</code> (or a docker-mode cscli
					bridge). It maps Traefik routers to containers and flags direct-port bypasses.
				</p>
			{/if}
		</Module>

		<Module title="Policy">
			{#if data.canOperate}
				<form method="post" action="?/setPolicy" class="space-y-3">
					<Field
						label="Hostname aliases"
						name="aliases"
						value={data.aliases.join(', ')}
						placeholder="www.{data.site.hostname}"
						hint="Comma/space-separated names whose alerts attribute here. Unknown names learn as their own sites — keep this tight."
					/>
					<div class="flex flex-wrap items-end gap-3">
						<FilterSelect
							label="WAF level"
							name="wafLevel"
							value={data.site.wafLevel}
							options={WAF_LEVELS.map((l) => ({
								value: l.value,
								label:
									l.value === '4' && data.site.wafLevel !== '4' && !data.crsAlerts
										? `${l.label} — needs CRS alerts`
										: l.label
							}))}
						/>
						<FilterSelect
							label="Remediation"
							name="remediationPreset"
							value={data.site.remediationPreset}
							options={REMEDIATION_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
						/>
						<Button variant="secondary" size="sm" type="submit">Save policy</Button>
					</div>
					<Field
						label="AppSec exclusion collections"
						name="exclusions"
						value={data.exclusions.join(', ')}
						placeholder="crowdsecurity/appsec-wordpress"
						hint="Optional. Per-site exclusion collections installed next to the level's rules — tune out app-specific false positives."
					/>
					<p class="text-[11px] text-ink-3">
						{WAF_LEVELS.find((l) => l.value === data.site.wafLevel)?.risk} · CRS alerts observed for this
						site: {data.crsAlerts}
						{#if !data.crsAlerts}
							— run level 3 before level 4 so in-band CRS has observe evidence
						{/if}
					</p>
				</form>
			{:else}
				<p class="text-sm text-ink-3">
					WAF level {data.site.wafLevel} · {data.site.remediationPreset} remediation
					{data.aliases.length ? `· aliases: ${data.aliases.join(', ')}` : ''}
				</p>
			{/if}
		</Module>

		<Module title="Verification checks">
			<ul class="space-y-3">
				{#each data.checkDefs as def (def.id)}
					{@const c = checkFor(def.id)}
					<li class="border-b border-rule pb-3 last:border-0 last:pb-0">
						<div class="flex items-center justify-between gap-2">
							<p class="text-sm font-medium text-ink">{def.title}</p>
							<Stamp
								state={checkState[c?.state ?? 'not_run']}
								label={checkLabel[c?.state ?? 'not_run']}
							/>
						</div>
						<p class="mt-0.5 text-xs text-ink-3">{def.detail}</p>
						{#if c?.evidence?.message}
							<p class="mt-1 text-xs text-ink-2">{c.evidence.message}</p>
						{/if}
						{#if c?.checkedAt}
							<p class="mt-0.5 text-[11px] text-ink-3">checked {fmt(c.checkedAt)}</p>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="mt-4 flex flex-wrap items-center gap-2">
				<form method="post" action="?/markWindow">
					<Button variant="secondary" size="sm" type="submit">Start test window</Button>
				</form>
				<form method="post" action="?/runChecks">
					<Button variant="secondary" size="sm" type="submit">Run checks</Button>
				</form>
				{#if data.canOperate}
					<form method="post" action="?/confirmRealIp">
						<Button variant="secondary" size="sm" type="submit">Confirm real IP</Button>
					</form>
				{/if}
			</div>
			<p class="mt-2 text-xs text-ink-3">
				Test path: <code class="font-mono">curl -k https://{data.site.hostname}{data.testPath}</code
				>
				— harmless; never bans anyone. From an allowlisted/private address the scenario is not exercised
				— run it from a public vantage point.
			</p>
		</Module>
	</div>

	<Module title="Activity">
		<div class="grid gap-4 lg:grid-cols-[1fr_auto]">
			<div>
				<p class="text-xs text-ink-3">
					Alerts attributed to {data.site.hostname}
					{#if data.aliases.length}
						(or aliases: {data.aliases.join(', ')})
					{/if}
					— full history on
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={resolve('/(app)/alerts') + `?site=${data.site.id}`} class="text-accent underline"
						>Alerts</a
					>.
				</p>
				{#if data.activity.recent.length}
					<table class="mt-2 w-full text-left text-xs">
						<thead class="text-ink-3">
							<tr><th class="py-1">Scenario</th><th>Source</th><th>Started</th></tr>
						</thead>
						<tbody>
							{#each data.activity.recent as r (r.upstreamId)}
								<tr class="border-t border-rule">
									<td class="py-1 pr-3 font-mono">{r.scenario ?? '—'}</td>
									<td class="pr-3 font-mono">{r.sourceIp ?? '—'}</td>
									<td class="text-ink-3">{fmt(r.startedAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{:else}
					<p class="mt-2 text-sm text-ink-3">
						No alerts attributed yet — set aliases above and point this site's access log at
						CrowdSec with the <code>target_fqdn</code> label.
					</p>
				{/if}
			</div>
			<div class="min-w-0">
				<div class="mb-1 flex items-center gap-1 text-[11px]">
					{#each ['24h', '7d', '30d'] as r (r)}
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							href={resolve('/(app)/sites/[id]', { id: data.site.id }) + `?actRange=${r}`}
							data-sveltekit-noscroll
							class="rounded-[3px] border px-2 py-0.5 {data.activity.range === r
								? 'border-accent-outline text-accent'
								: 'border-line text-ink-3 hover:text-ink-2'}">{r}</a
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					{/each}
					<span class="ml-1 text-ink-3">alerts per bucket</span>
				</div>
				{#if data.activity.buckets.length}
					<ActivityChart data={actPoints} xLabel={actLabel} tickStride={8} />
					<details class="mt-1">
						<summary class="cursor-pointer text-xs text-ink-3 hover:text-ink-2">Data table</summary>
						<table class="mt-1 w-full text-xs">
							<tbody>
								{#each data.activity.buckets as b (b.at)}
									<tr class="border-b border-rule last:border-0">
										<td class="py-1 font-mono">{actLabel(b.at)}</td>
										<td class="py-1 text-right font-mono tabular-nums">{b.total}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				{:else}
					<p class="mt-2 text-xs text-ink-3">No alert volume recorded in this range.</p>
				{/if}
			</div>
		</div>
	</Module>

	<Module title={data.agent ? 'Generated artifacts' : 'Generated artifacts — guided, not applied'}>
		<p class="mb-3 text-xs text-ink-3">
			{#if data.agent}
				Complete-file artifacts can be applied through the host agent (backup → write → validate →
				reload); fragments stay manual. Otherwise
			{:else}
				No host agent connected —
			{/if}
			copy each artifact to the host and apply it yourself. Mark it applied afterwards; a passing verification
			check promotes it to verified. Regenerating with different answers resets changed artifacts to not
			applied.
		</p>
		{#if data.agent?.caps.files && data.canOperate}
			<form method="post" action="?/checkDrift" class="mb-3">
				<Button variant="secondary" size="sm" type="submit">Check drift via agent</Button>
			</form>
		{/if}
		<div class="space-y-4">
			{#each data.artifacts as a (a.id)}
				{@const drift = driftOf(a)}
				<div class="border border-rule">
					<div
						class="flex items-center justify-between gap-2 border-b border-rule bg-sheet px-3 py-2"
					>
						<p class="text-sm font-medium text-ink">
							{a.title} <span class="ml-1 text-xs text-ink-3">{a.kind} · {a.format}</span>
						</p>
						<div class="flex items-center gap-2">
							<Stamp state={artifactState[a.state]} label={artifactLabel[a.state]} />
							{#if drift}
								<Stamp state={drift.state} label={drift.label} />
							{/if}
							{#if data.canOperate}
								{#if a.kind === 'collections' && data.agent?.caps.cscli}
									<form method="post" action="?/installCollections">
										<Button variant="secondary" size="sm" type="submit">Install via agent</Button>
									</form>
								{/if}
								{#if a.managed && a.target}
									{#if proxyRoot(a.target) && adopted !== data.site.proxy}
										<span class="text-[11px] text-ink-3">adopt {data.site.proxy} to apply</span>
									{:else}
										<form method="post" action="?/applyArtifact" class="flex items-center gap-1.5">
											<input type="hidden" name="artifactId" value={a.id} />
											{#if (data.agent?.caps.services ?? []).length}
												<select
													name="reloadTarget"
													class="border border-rule bg-sheet px-1.5 py-1 text-[11px] text-ink"
												>
													<option value="">no reload</option>
													{#each data.agent?.caps.services ?? [] as svc (svc)}
														<option value={svc}>{svc}</option>
													{/each}
												</select>
											{/if}
											<Button variant="secondary" size="sm" type="submit">Apply via agent</Button>
										</form>
									{/if}
								{/if}
								<form method="post" action="?/artifactState">
									<input type="hidden" name="artifactId" value={a.id} />
									<input
										type="hidden"
										name="state"
										value={a.state === 'applied' ? 'not_applied' : 'applied'}
									/>
									<Button variant="secondary" size="sm" type="submit">
										{a.state === 'applied' ? 'Unmark' : 'Mark applied'}
									</Button>
								</form>
							{/if}
						</div>
					</div>
					<CodeBlock code={a.content} class="border-0" />
				</div>
			{:else}
				<p class="text-sm text-ink-3">
					No artifacts yet — set the proxy above (or run Detect) and save.
				</p>
			{/each}
		</div>
	</Module>
</div>
