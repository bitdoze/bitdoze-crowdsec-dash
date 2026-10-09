<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import { cn } from '#lib/utils.ts';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost';
		size?: 'sm' | 'md';
		loading?: boolean;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		loading = false,
		disabled = false,
		class: className,
		children,
		...rest
	}: Props = $props();
</script>

<button
	{...rest}
	disabled={disabled || loading}
	class={cn(
		'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[3px] font-semibold transition-colors',
		'disabled:cursor-not-allowed disabled:opacity-50',
		'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-outline',
		size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
		variant === 'primary' &&
			'bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-hover',
		variant === 'secondary' &&
			'border border-line bg-sheet text-ink hover:bg-panel active:bg-panel',
		variant === 'ghost' && 'text-ink-2 hover:bg-panel hover:text-ink active:bg-panel',
		className
	)}
>
	{#if loading}
		<LoaderCircle size={14} strokeWidth={1.75} aria-hidden="true" class="btn-spin" />
	{/if}
	{@render children()}
</button>

<style>
	.btn-spin {
		animation: btn-rotate 0.9s linear infinite;
	}
	@keyframes btn-rotate {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.btn-spin {
			animation: none;
		}
	}
</style>
