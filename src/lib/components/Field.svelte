<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils.ts';

	interface Props extends HTMLInputAttributes {
		label: string;
		hint?: string;
		class?: string;
	}

	const inputId = $props.id();
	let { label, hint, id = inputId, class: className, ...rest }: Props = $props();
</script>

<div class={cn('flex flex-col gap-1', className)}>
	<label for={id} class="text-xs font-semibold tracking-[0.05em] text-ink-2 uppercase">
		{label}
	</label>
	{#if hint}
		<p class="text-xs text-ink-3">{hint}</p>
	{/if}
	<input
		{id}
		{...rest}
		class="rounded-[3px] border border-line bg-sheet px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-3 focus-visible:border-accent"
	/>
</div>
