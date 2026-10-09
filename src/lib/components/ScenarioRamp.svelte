<script lang="ts">
	import { magnitudeLevel } from '#lib/overview/format.ts';
	import { cn } from '#lib/utils.ts';

	interface Props {
		count: number;
		class?: string;
	}

	let { count, class: className }: Props = $props();
	const level = $derived(magnitudeLevel(count));
</script>

<span
	class={cn('inline-flex items-center gap-0.5', className)}
	role="img"
	aria-label="Magnitude {level} of 5"
>
	{#each [1, 2, 3, 4, 5] as step (step)}
		<span
			class={cn(
				'inline-block size-1.5 rounded-full border',
				step <= level ? 'border-ink bg-ink' : 'border-rule-strong bg-transparent'
			)}
		></span>
	{/each}
</span>
