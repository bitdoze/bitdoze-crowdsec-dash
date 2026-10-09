<script lang="ts">
	import type { Component } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import ClockAlert from '@lucide/svelte/icons/clock-alert';
	import Minus from '@lucide/svelte/icons/minus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { cn } from '#lib/utils.ts';
	import type { CheckState } from '#lib/overview/types.ts';

	type StampState = CheckState | 'checking';

	interface Props {
		state: StampState;
		size?: 'sm' | 'lg';
		class?: string;
	}

	let { state, size = 'sm', class: className }: Props = $props();

	const meta: Record<StampState, { label: string; icon: Component; cls: string; ruled: boolean }> = {
		verified: {
			label: 'Verified',
			icon: Check,
			cls: 'border-verified bg-verified-tint text-verified',
			ruled: true
		},
		degraded: {
			label: 'Degraded',
			icon: TriangleAlert,
			cls: 'border-degraded bg-degraded-tint text-degraded',
			ruled: true
		},
		failed: { label: 'Failed', icon: X, cls: 'border-failed bg-failed-tint text-failed', ruled: true },
		stale: { label: 'Stale', icon: ClockAlert, cls: 'border-stale bg-stale-tint text-stale', ruled: true },
		not_configured: {
			label: 'N/C',
			icon: Minus,
			cls: 'border-rule-strong text-ink-3',
			ruled: false
		},
		checking: {
			label: 'Checking',
			icon: LoaderCircle,
			cls: 'border-dotted border-ink-3 text-ink-2',
			ruled: false
		}
	};

	const m = $derived(meta[state]);
	const Icon = $derived(m.icon);
	const iconSize = $derived(size === 'sm' ? 14 : 16);
</script>

<span
	class={cn(
		'inline-flex select-none items-center whitespace-nowrap border font-semibold tracking-[0.06em] uppercase',
		size === 'sm' ? 'text-xs' : 'text-sm',
		m.cls,
		className
	)}
	data-state={state}
>
	{#if m.ruled}
		<span class="m-0.5 inline-flex items-center gap-1.5 border border-current px-1.5 py-px">
			<Icon size={iconSize} strokeWidth={1.75} aria-hidden="true" />
			{m.label}
		</span>
	{:else}
		<span class="inline-flex items-center gap-1.5 px-1.5 py-px">
			<Icon
				size={iconSize}
				strokeWidth={1.75}
				aria-hidden="true"
				class={state === 'checking' ? 'stamp-spin' : undefined}
			/>
			{m.label}
		</span>
	{/if}
</span>

<style>
	.stamp-spin {
		animation: stamp-rotate 1s linear infinite;
	}
	@keyframes stamp-rotate {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.stamp-spin {
			animation: none;
		}
	}
</style>
