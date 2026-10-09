<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.ts';

	interface Props {
		children: Snippet;
		align?: 'start' | 'center' | 'end';
		class?: string;
	}

	let { children, align = 'end', class: className }: Props = $props();
</script>

<DropdownMenu.Portal>
	<DropdownMenu.Content
		{align}
		sideOffset={4}
		class={cn(
			'z-50 min-w-44 rounded-[6px] border border-rule-strong bg-sheet p-1 text-sm text-ink shadow-overlay',
			className
		)}
	>
		{@render children()}
	</DropdownMenu.Content>
</DropdownMenu.Portal>
