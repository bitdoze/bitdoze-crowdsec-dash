<script lang="ts">
	import type { Snippet } from 'svelte';
	import Wordmark from './Wordmark.svelte';

	interface Props {
		title: string;
		subtitle?: string;
		children: Snippet;
	}

	let { title, subtitle, children }: Props = $props();
</script>

<div class="flex min-h-dvh flex-col items-center bg-paper px-4">
	<div class="mt-16 sm:mt-24">
		<Wordmark href={null} />
	</div>

	<div class="mt-8 w-full max-w-sm border border-line bg-sheet">
		<div class="border-b border-rule px-5 py-3">
			<h1 class="text-md font-semibold tracking-tight">{title}</h1>
			{#if subtitle}
				<p class="mt-0.5 text-xs text-ink-3">{subtitle}</p>
			{/if}
		</div>
		<div class="px-5 py-5">
			{@render children()}
		</div>
	</div>

	<p class="mt-6 pb-8 text-center text-xs text-ink-3">
		Self-hosted. Nothing leaves this server.<br />
		Locked out? On the server run
		<code class="font-mono">npm run recover -- &lt;email&gt;</code>
	</p>
</div>
