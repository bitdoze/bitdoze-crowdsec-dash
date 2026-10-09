<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils.ts';

	interface Props {
		children: Snippet;
		disabled?: boolean;
		onSelect?: () => void;
		class?: string;
	}

	let { children, disabled = false, onSelect, class: className }: Props = $props();
</script>

<DropdownMenu.Item
	{disabled}
	onSelect={onSelect ?? (() => {})}
	class={cn(
		'flex cursor-pointer items-center gap-2 rounded-[3px] px-2 py-1.5 text-sm outline-none',
		'data-highlighted:bg-panel data-highlighted:text-ink',
		'data-disabled:cursor-not-allowed data-disabled:text-ink-3',
		className
	)}
>
	{@render children()}
</DropdownMenu.Item>
