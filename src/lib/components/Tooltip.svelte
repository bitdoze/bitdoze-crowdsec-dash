<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Tooltip } from 'bits-ui';
	import { cn } from '#lib/utils.ts';

	interface Props {
		content: string;
		children: Snippet;
		class?: string;
	}

	let { content, children, class: className }: Props = $props();
</script>

<Tooltip.Root delayDuration={300}>
	<Tooltip.Trigger class={cn('inline-flex', className)}>
		{@render children()}
	</Tooltip.Trigger>
	<Tooltip.Portal>
		<Tooltip.Content
			sideOffset={6}
			class="z-50 max-w-64 rounded-[6px] border border-rule-strong bg-sheet px-2 py-1 text-xs text-ink shadow-overlay"
		>
			{content}
		</Tooltip.Content>
	</Tooltip.Portal>
</Tooltip.Root>
