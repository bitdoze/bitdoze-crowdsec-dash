<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import StampIcon from '@lucide/svelte/icons/stamp';
	import type { PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Button from '#lib/components/Button.svelte';
	import Evidence from '#lib/components/Evidence.svelte';
	import ObservationCode from '#lib/components/ObservationCode.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import ActivityChart from '#lib/components/ActivityChart.svelte';
	import AttackMap from '#lib/components/AttackMap.svelte';
	import ScenarioRamp from '#lib/components/ScenarioRamp.svelte';
	import { TESTS, type TestId } from '#lib/overview/types.ts';
	import { formatCount, formatDateTime, hourLabel, relativeTime } from '#lib/overview/format.ts';
	import { cn } from '#lib/utils.ts';

	let { data }: PageProps = $props();
	const overview = $derived(data.overview);

	const RANGE_HOURS: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24 };
	const rangeHours = $derived(RANGE_HOURS[data.range] ?? 24);
	const activity = $derived(overview.activity.slice(-rangeHours));

	const visibleSites = $derived(
		data.selectedSite ? overview.sites.filter((s) => s.id === data.selectedSite) : overview.sites
	);

	const totalAlerts = $derived(activity.reduce((sum, p) => sum + p.alerts, 0));
	const totalDecisions = $derived(activity.reduce((sum, p) => sum + p.decisions, 0));
	const peak = $derived(
		activity.reduce(
			(best, p) =>
				p.alerts + p.decisions > best.n ? { n: p.alerts + p.decisions, at: p.at } : best,
			{ n: 0, at: '' }
		)
	);

	/* Evidence rows ------------------------------------------------------ */

	let openKey = $state<string | null>(null);
	const openEvidence = $derived.by(() => {
		if (!openKey) return null;
		const [siteId, testId] = openKey.split('::');
		const site = overview.sites.find((s) => s.id === siteId);
		const test = TESTS.find((t) => t.id === testId);
		if (!site || !test) return null;
		return { site, test, result: site.checks[test.id] };
	});

	function toggleEvidence(siteId: string, testId: TestId) {
		const key = `${siteId}::${testId}`;
		openKey = openKey === key ? null : key;
	}

	function closeEvidence() {
		if (!openKey) return;
		const key = openKey;
		openKey = null;
		document.getElementById(`cell-${key}`)?.focus();
	}

	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && openKey) {
			e.preventDefault();
			closeEvidence();
		}
	}

	/* Re-inspect (fixture demonstration) --------------------------------- */

	const checking = new SvelteSet<string>();
	const restamped = new SvelteSet<string>();
	let inspecting = $state(false);
	let announce = $state('');

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	async function reinspect() {
		if (inspecting || overview.source !== 'fixture') return;
		inspecting = true;
		openKey = null;
		restamped.clear();
		const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
		const rows = visibleSites;
		const stagger = reduceMotion ? 0 : 90;
		const settle = reduceMotion ? 0 : 420;

		announce = 'Re-inspection started.';

		await Promise.all(
			rows.map(async (site, i) => {
				const keys = TESTS.map((t) => `${site.id}::${t.id}`);
				await sleep(i * stagger);
				for (const key of keys) checking.add(key);
				await sleep(settle);
				for (const key of keys) {
					checking.delete(key);
					restamped.add(key);
				}
			})
		);

		const testCount = rows.length * TESTS.length;
		announce = `Re-inspection complete: ${rows.length} sites, ${testCount} tests re-stamped. No changes.`;
		inspecting = false;
		await sleep(600);
		restamped.clear();
	}

	/* Observations fix toggles -------------------------------------------- */

	const openFixes = new SvelteSet<string>();
	function toggleFix(title: string) {
		if (openFixes.has(title)) openFixes.delete(title);
		else openFixes.add(title);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if overview.source === 'none'}
	<div class="mx-auto max-w-xl pt-10">
		<div class="border border-rule bg-sheet px-6 py-8 text-center">
			<span
				class="mx-auto inline-flex items-center justify-center border border-ink p-1"
				aria-hidden="true"
			>
				<span class="inline-flex items-center justify-center border border-ink p-1">
					<StampIcon size={18} strokeWidth={1.75} />
				</span>
			</span>
			<h1 class="mt-4 text-lg font-semibold">Not connected to CrowdSec yet</h1>
			<p class="mx-auto mt-2 max-w-md text-sm text-ink-2">
				Once this dashboard is connected to a CrowdSec LAPI, the overview shows each site's
				protection tests, open observations, and activity.
			</p>
			<p class="mt-4 inline-flex items-center gap-2 text-xs text-ink-3">
				<Stamp state="not_configured" /> Connection setup arrives in v0.1.0
			</p>
		</div>
	</div>
{:else}
	<!-- Certificate header band -->
	<div class="flex flex-wrap items-start justify-between gap-3 border-b border-rule-strong pb-4">
		<div>
			<h1 class="text-xl font-semibold tracking-tight">{overview.server.name ?? 'Server'}</h1>
			<p class="mt-1 text-sm text-ink-2">
				CrowdSec {overview.server.crowdsecVersion}
				{#if overview.server.lapi}
					· LAPI <span class="font-mono text-xs">{overview.server.lapi}</span>
				{/if}
				{#if overview.inspectedAt}
					· last inspected
					<time datetime={overview.inspectedAt} title={formatDateTime(overview.inspectedAt)}>
						{relativeTime(overview.inspectedAt)}
					</time>
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-3">
			{#if overview.verdict}
				<div class="text-right">
					<Stamp state={overview.verdict.state} size="lg" />
					<p class="mt-1 text-sm font-medium">{overview.verdict.label}</p>
				</div>
			{/if}
			{#if overview.source === 'fixture'}
				<Button variant="primary" onclick={reinspect} loading={inspecting} disabled={inspecting}>
					<RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
					Re-inspect
				</Button>
			{/if}
		</div>
	</div>

	<p class="sr-only" aria-live="polite">{announce}</p>

	<div class="mt-5 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
		<div class="min-w-0">
			<Module title="Inspection schedule">
				<!-- Server-wide strip -->
				<div class="mb-4 border border-rule bg-sheet">
					<div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-rule px-3 py-2">
						{#each overview.serverChecks as sc (sc.id)}
							<span class="inline-flex items-center gap-1.5 text-xs" title={sc.detail}>
								<span class="font-semibold tracking-[0.05em] text-ink-3 uppercase">{sc.label}</span>
								<Stamp state={sc.state} />
							</span>
						{/each}
					</div>
					<p class="px-3 py-1.5 text-xs text-ink-3">
						Server-wide: bans, the firewall, and the blocklist apply to every site on this server.
					</p>
				</div>

				<!-- Schedule table -->
				<div class="overflow-x-auto">
					<table class="w-full border-collapse text-sm">
						<thead>
							<tr class="border-b border-rule-strong text-left">
								<th class="w-8 py-1.5 pr-2 text-xs font-semibold text-ink-3">#</th>
								<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
									>Site</th
								>
								{#each TESTS as test (test.id)}
									<th
										class="px-1.5 py-1.5 text-center text-xs font-semibold whitespace-nowrap text-ink-3"
										title={test.description}
									>
										<span class="font-mono">{test.code}</span>
										<span class="hidden tracking-[0.05em] uppercase sm:inline"> {test.column}</span>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each visibleSites as site, i (site.id)}
								<tr class="border-b border-rule">
									<td class="py-2 pr-2 align-middle text-xs text-ink-3">{i + 1}</td>
									<td class="py-2 pr-3 align-middle">
										<p class="font-medium">{site.hostname}</p>
										<p class="text-xs text-ink-3">{site.proxy}</p>
									</td>
									{#each TESTS as test (test.id)}
										{@const key = `${site.id}::${test.id}`}
										{@const result = site.checks[test.id]}
										<td class="px-1 py-2 text-center align-middle">
											<button
												type="button"
												id={`cell-${key}`}
												class={cn(
													'inline-flex cursor-pointer rounded-[2px] p-0.5',
													openKey === key && 'outline-2 outline-offset-1 outline-accent-outline'
												)}
												aria-expanded={openKey === key}
												aria-controls={openKey === key ? `evidence-${site.id}` : undefined}
												aria-label={`${site.hostname} ${test.name}: ${result.state}`}
												onclick={() => toggleEvidence(site.id, test.id)}
											>
												<span class={restamped.has(key) ? 'stamp-press' : undefined}>
													<Stamp state={checking.has(key) ? 'checking' : result.state} />
												</span>
											</button>
										</td>
									{/each}
								</tr>
								{#if openEvidence && openEvidence.site.id === site.id}
									<tr id={`evidence-${site.id}`} class="border-b border-rule-strong">
										<td colspan={2 + TESTS.length}>
											<Evidence test={openEvidence.test} result={openEvidence.result} />
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>
				<p class="mt-3 text-xs text-ink-3">
					Select a cell to read its evidence. Press <kbd class="font-mono">Esc</kbd> to close.
				</p>
			</Module>

			<!-- Below the fold -->
			<div class="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
				<Module title="Measurements" class="min-w-0">
					<table class="w-full text-sm">
						<tbody>
							{#each overview.measurements as m (m.label)}
								<tr class="border-b border-rule last:border-0">
									<td class="py-1.5 pr-2 text-ink-2">{m.label}</td>
									<td class="py-1.5 text-right font-mono text-ink tabular-nums">
										{#if m.value === null}
											<span class="font-sans text-xs text-ink-3"
												>Not measured{m.unavailableReason ? ` — ${m.unavailableReason}` : ''}</span
											>
										{:else}
											{formatCount(m.value)}
										{/if}
									</td>
								</tr>
								{#if m.note}
									<tr class="border-b border-rule last:border-0">
										<td colspan="2" class="pb-1.5 text-xs text-ink-3">{m.note}</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</Module>

				<Module title={`Activity (${data.range})`} class="min-w-0">
					<p class="mb-2 text-sm text-ink-2">
						{formatCount(totalAlerts)} alerts, {formatCount(totalDecisions)} new decisions
						{#if peak.n > 0}
							· peak {peak.n} at {hourLabel(peak.at)}
						{/if}
					</p>
					<ActivityChart data={activity} />
					<details class="mt-2">
						<summary class="cursor-pointer text-xs text-ink-3 hover:text-ink-2">Data table</summary>
						<table class="mt-1 w-full text-xs">
							<thead>
								<tr class="border-b border-rule text-left text-ink-3">
									<th class="py-1 font-semibold">Hour</th>
									<th class="py-1 text-right font-semibold">Alerts</th>
									<th class="py-1 text-right font-semibold">Decisions</th>
								</tr>
							</thead>
							<tbody>
								{#each activity as p (p.at)}
									<tr class="border-b border-rule last:border-0">
										<td class="py-1 font-mono">{hourLabel(p.at)}</td>
										<td class="py-1 text-right font-mono tabular-nums">{p.alerts}</td>
										<td class="py-1 text-right font-mono tabular-nums">{p.decisions}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				</Module>

				<Module title="Attack origins" class="min-w-0 md:col-span-2 xl:col-span-3">
					<AttackMap points={overview.mapPoints} />
					<p class="mt-2 text-xs text-ink-3">
						Alert sources in the selected window, from stored GeoIP fields. Dot size follows the
						magnitude ramp.
					</p>
				</Module>

				<Module title="Top scenarios" class="min-w-0">
					{#if overview.topScenarios.length > 0}
						<table class="w-full text-sm">
							<tbody>
								{#each overview.topScenarios as s (s.name)}
									<tr class="border-b border-rule last:border-0">
										<td
											class="w-full py-1.5 pr-2 font-mono text-xs break-words text-ink-2"
											title={s.name}>{s.name.replace(/^crowdsecurity\//, '')}</td
										>
										<td class="py-1.5 pr-2 whitespace-nowrap"><ScenarioRamp count={s.count} /></td>
										<td class="py-1.5 text-right font-mono text-ink tabular-nums"
											>{formatCount(s.count)}</td
										>
									</tr>
								{/each}
							</tbody>
						</table>
						<p class="mt-2 text-xs text-ink-3">
							Magnitude: ● 1–9 · ●● 10–99 · ●●● 100–999 · ●●●● 1,000+ · ●●●●● 10,000+
						</p>
					{:else}
						<p class="text-sm text-ink-3">No scenarios triggered in this window.</p>
					{/if}
				</Module>
			</div>
		</div>

		<!-- Observations -->
		<div class="min-w-0">
			<Module title="Observations">
				{#if overview.observations.length > 0}
					<ol class="space-y-4">
						{#each overview.observations as obs, i (obs.title)}
							<li class="border-b border-rule pb-4 last:border-0 last:pb-0">
								<div class="flex items-start gap-2">
									<ObservationCode code={obs.code} class="mt-0.5 shrink-0" />
									<div class="min-w-0">
										<p class="text-sm font-semibold">
											<span class="mr-1 text-xs text-ink-3">{i + 1}.</span>{obs.title}
										</p>
										<p class="mt-1 text-sm text-ink-2">{obs.detail}</p>
										<div class="mt-2">
											<Button
												size="sm"
												onclick={() => toggleFix(obs.title)}
												aria-expanded={openFixes.has(obs.title)}
											>
												{openFixes.has(obs.title) ? 'Hide fix' : 'Show fix'}
											</Button>
										</div>
										{#if openFixes.has(obs.title)}
											<div class="mt-2 space-y-2">
												<p class="text-sm font-medium">{obs.fix.title}</p>
												<ol class="list-decimal space-y-1 pl-4 text-sm text-ink-2">
													{#each obs.fix.steps as step, j (j)}
														<li>{step}</li>
													{/each}
												</ol>
												{#if obs.fix.code}
													<CodeBlock code={obs.fix.code} />
												{/if}
											</div>
										{/if}
									</div>
								</div>
							</li>
						{/each}
					</ol>
				{:else}
					<p class="text-sm text-ink-3">No open observations.</p>
				{/if}
			</Module>
		</div>
	</div>
{/if}

<style>
	.stamp-press {
		display: inline-flex;
		animation: stamp-press 140ms ease-out;
	}
	@keyframes stamp-press {
		from {
			transform: scale(0.94);
		}
		to {
			transform: scale(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.stamp-press {
			animation: none;
		}
	}
</style>
