<script lang="ts">
	import type { PageProps } from './$types';
	import { resolve } from '$app/paths';
	import Module from '#lib/components/Module.svelte';
	import Button from '#lib/components/Button.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';

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
			{#if data.detection}
				<p class="mt-3 text-xs text-ink-3">
					Last probe {(data.detection.at as string) ?? ''} — {data.detection.probedUrl as string}:
					{Object.keys((data.detection.headers as Record<string, string>) ?? {}).join(', ') ||
						'no identifying headers'}
					{#if data.detection.error}· error: {data.detection.error}{/if}
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

	<Module title={data.agent ? 'Generated artifacts' : 'Generated artifacts — guided, not applied'}>
		<p class="mb-3 text-xs text-ink-3">
			{#if data.agent}
				Complete-file artifacts can be applied through the host agent (backup + write); fragments
				stay manual. Otherwise
			{:else}
				No host agent connected —
			{/if}
			copy each artifact to the host and apply it yourself. Mark it applied afterwards; a passing verification
			check promotes it to verified. Regenerating with different answers resets changed artifacts to not
			applied.
		</p>
		<div class="space-y-4">
			{#each data.artifacts as a (a.id)}
				<div class="border border-rule">
					<div
						class="flex items-center justify-between gap-2 border-b border-rule bg-sheet px-3 py-2"
					>
						<p class="text-sm font-medium text-ink">
							{a.title} <span class="ml-1 text-xs text-ink-3">{a.kind} · {a.format}</span>
						</p>
						<div class="flex items-center gap-2">
							<Stamp state={artifactState[a.state]} label={artifactLabel[a.state]} />
							{#if data.canOperate}
								{#if a.kind === 'collections' && data.agent?.caps.cscli}
									<form method="post" action="?/installCollections">
										<Button variant="secondary" size="sm" type="submit">Install via agent</Button>
									</form>
								{/if}
								{#if a.managed && a.target}
									<form method="post" action="?/applyArtifact">
										<input type="hidden" name="artifactId" value={a.id} />
										<Button variant="secondary" size="sm" type="submit">Apply via agent</Button>
									</form>
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
