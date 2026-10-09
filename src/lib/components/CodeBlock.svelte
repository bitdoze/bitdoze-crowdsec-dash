<script lang="ts">
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import { cn } from '#lib/utils.ts';

	interface Props {
		code: string;
		class?: string;
	}

	let { code, class: className }: Props = $props();
	let copied = $state(false);
	let timeout: ReturnType<typeof setTimeout>;

	async function copy() {
		try {
			await navigator.clipboard.writeText(code);
			copied = true;
			clearTimeout(timeout);
			timeout = setTimeout(() => (copied = false), 1600);
		} catch {
			copied = false;
		}
	}
</script>

<div class={cn('group relative border border-rule bg-panel', className)}>
	<pre class="overflow-x-auto px-3 py-2 font-mono text-sm text-ink">{code}</pre>
	<button
		type="button"
		onclick={copy}
		aria-label={copied ? 'Copied' : 'Copy command'}
		class="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-[3px] border border-line bg-sheet px-1.5 py-0.5 text-xs text-ink-2 hover:text-ink"
	>
		{#if copied}
			<Check size={14} strokeWidth={1.75} aria-hidden="true" />Copied
		{:else}
			<Copy size={14} strokeWidth={1.75} aria-hidden="true" />Copy
		{/if}
	</button>
</div>
