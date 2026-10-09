<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { SvelteURLSearchParams } from 'svelte/reactivity';

	interface Props {
		page: number;
		pages: number;
		total: number;
		perPage: number;
	}
	let { page: current, pages, total, perPage }: Props = $props();

	function pathFor(p: number): string {
		const params = new SvelteURLSearchParams(page.url.search);
		if (p <= 1) params.delete('page');
		else params.set('page', String(p));
		const qs = params.toString();
		// Pathname form (no leading slash) — resolve() applies the base prefix
		// and route params are already concrete in page.url.pathname.
		return page.url.pathname.slice(1) + (qs ? `?${qs}` : '');
	}
</script>

{#if pages > 1}
	<nav class="flex items-center justify-between text-sm" aria-label="Pagination">
		<p class="text-xs text-ink-3">
			{(current - 1) * perPage + 1}–{Math.min(current * perPage, total)} of
			{total.toLocaleString()}
		</p>
		<div class="flex items-center gap-1">
			{#if current > 1}
				<a
					href={resolve(pathFor(current - 1) as '')}
					class="border border-line bg-sheet px-2 py-1 text-ink-2 hover:bg-panel">Previous</a
				>
			{/if}
			<span class="px-2 font-mono text-xs text-ink-3 tabular-nums">{current} / {pages}</span>
			{#if current < pages}
				<a
					href={resolve(pathFor(current + 1) as '')}
					class="border border-line bg-sheet px-2 py-1 text-ink-2 hover:bg-panel">Next</a
				>
			{/if}
		</div>
	</nav>
{/if}
