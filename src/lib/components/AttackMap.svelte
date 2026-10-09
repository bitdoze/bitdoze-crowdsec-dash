<script lang="ts">
	import { onMount } from 'svelte';
	import { MAP_H, MAP_W, type MapPoint } from '#lib/map-projection.ts';
	import { magnitudeLevel } from '#lib/overview/format.ts';

	interface Props {
		points: MapPoint[];
	}
	let { points }: Props = $props();

	// The land outline (~110k point TopoJSON) is a lazy chunk, same pattern as
	// ActivityChart — SSR shows the dots immediately, land outlines on mount.
	let land = $state<string[] | null>(null);
	onMount(async () => {
		const mod = await import('#lib/map-geo.ts');
		land = mod.LAND_PATHS;
	});

	// Fixed radius ramp matching the magnitude legend (ScenarioRamp).
	const radius = (count: number) => 2 + magnitudeLevel(count) * 1.4;
</script>

<div class="border border-rule bg-sheet">
	<svg
		viewBox={`0 0 ${MAP_W} ${MAP_H}`}
		class="block h-auto w-full"
		role="img"
		aria-label={`Attack origin map: ${points.length} locations, ${points.reduce((n, p) => n + p.count, 0)} alerts`}
	>
		{#if land}
			<g class="fill-rule-strong/40">
				{#each land as d (d)}
					<path {d} />
				{/each}
			</g>
		{/if}
		{#each points as p (`${p.x}|${p.y}`)}
			<circle
				cx={p.x}
				cy={p.y}
				r={radius(p.count)}
				class="fill-accent/70 stroke-accent"
				stroke-width="0.6"
			>
				<title>{p.count} alert{p.count === 1 ? '' : 's'}</title>
			</circle>
		{/each}
	</svg>
	{#if points.length === 0}
		<p class="border-t border-rule px-3 py-2 text-xs text-ink-3">
			No alert geo data in this window — CrowdSec needs a MaxMind GeoIP database to label origins.
		</p>
	{/if}
</div>
