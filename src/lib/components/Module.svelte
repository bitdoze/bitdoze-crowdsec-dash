<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.ts';

	interface Props {
		title: string;
		actions?: Snippet;
		children: Snippet;
		class?: string;
		bodyClass?: string;
	}

	let { title, actions, children, class: className, bodyClass }: Props = $props();
</script>

<section class={cn('border-t border-rule-strong', className)}>
	<header class="flex items-start justify-between gap-2">
		<h2
			class="inline-flex items-center gap-2 border-x border-b border-rule bg-sheet px-3 py-1.5 text-sm font-semibold tracking-tight text-ink"
		>
			{title}
		</h2>
		{#if actions}
			<div class="flex items-center gap-1 pt-1">{@render actions()}</div>
		{/if}
	</header>
	<div class={cn('py-4', bodyClass)}>
		{@render children()}
	</div>
</section>
