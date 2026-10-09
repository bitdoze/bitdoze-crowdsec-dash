<script lang="ts">
	import { onMount } from 'svelte';
	import type { Component } from 'svelte';
	import { hourLabel } from '#lib/overview/format.ts';
	import type { ActivityPoint } from '#lib/overview/types.ts';

	interface Props {
		data: ActivityPoint[];
	}

	let { data }: Props = $props();

	// LayerChart is client-only and heavy; it is imported lazily after mount.
	// The text summary and the data table next to the chart always render.
	type BarChartComponent = Component<{
		data: { label: string; alerts: number }[];
		x: string;
		y: string;
		bandPadding?: number;
		series?: unknown[];
		props?: Record<string, unknown>;
		tooltipContext?: boolean;
		height?: number;
	}>;
	let BarChart = $state<BarChartComponent | null>(null);

	const points = $derived(data.map((p) => ({ label: hourLabel(p.at), alerts: p.alerts })));

	onMount(async () => {
		const mod = await import('layerchart');
		BarChart = mod.BarChart as unknown as BarChartComponent;
	});
</script>

<div class="h-40" aria-hidden="true">
	{#if BarChart}
		<BarChart
			data={points}
			x="label"
			y="alerts"
			bandPadding={0.35}
			height={160}
			tooltipContext={false}
			series={[{ key: 'alerts', label: 'Alerts', value: 'alerts', color: 'var(--color-accent)' }]}
			props={{
				xAxis: {
					format: (d: string) => (Number(d.slice(0, 2)) % 6 === 0 ? d : ''),
					tickLabelProps: { class: 'fill-ink-3', 'font-size': 10 }
				},
				yAxis: {
					tickLabelProps: { class: 'fill-ink-3', 'font-size': 10 }
				},
				grid: { class: 'stroke-rule', style: 'stroke-dasharray: none;' },
				bars: { strokeWidth: 0 },
				rule: { class: 'stroke-rule-strong' }
			}}
		/>
	{:else}
		<div class="flex h-full items-end gap-px border-b border-rule pb-px">
			{#each points as p, i (i)}
				<div
					class="flex-1 bg-rule"
					style:height={`${Math.min(100, p.alerts * 20)}%`}
					style:min-height={p.alerts > 0 ? '2px' : '0'}
				></div>
			{/each}
		</div>
	{/if}
</div>
