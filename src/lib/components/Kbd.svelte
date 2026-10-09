<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<kbd
	class="inline-flex items-center rounded-[3px] border border-line bg-sheet px-1.5 py-px font-mono text-xs text-ink-2"
	>{@render children()}</kbd
>
