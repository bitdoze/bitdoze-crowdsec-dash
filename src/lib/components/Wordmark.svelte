<script lang="ts">
	import { resolve } from '$app/paths';
	import Stamp from '@lucide/svelte/icons/stamp';
	import { cn } from '#lib/utils.ts';

	interface Props {
		href?: '/' | null;
		class?: string;
	}

	let { href = '/', class: className }: Props = $props();
</script>

{#snippet mark()}
	<span class="inline-flex items-center justify-center border border-ink p-0.5" aria-hidden="true">
		<span class="inline-flex items-center justify-center border border-ink p-0.5">
			<Stamp size={13} strokeWidth={1.75} />
		</span>
	</span>
	<span class="min-w-0">
		<span class="block truncate text-sm font-semibold tracking-tight">Bitdoze</span>
		<span class="block truncate text-xs font-medium text-ink-2">CrowdSec Dash</span>
	</span>
{/snippet}

{#if href}
	<a href={resolve('/(app)')} class={cn('flex items-center gap-2 text-ink', className)}>
		{@render mark()}
	</a>
{:else}
	<div class={cn('flex items-center gap-2 text-ink', className)}>
		{@render mark()}
	</div>
{/if}
