<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	interface Props {
		connected: boolean;
		freshness: {
			lastSuccessAt: Date | null;
			lastError: string | null;
			partial: boolean;
			empty: boolean;
		};
	}
	let { connected, freshness }: Props = $props();
</script>

{#if !connected}
	<div class="border border-rule bg-sheet px-4 py-6 text-center text-sm">
		<p class="font-medium text-ink">No CrowdSec connection</p>
		<p class="mt-1 text-ink-3">
			This page reads the local projection. Connect a LAPI on the
			<a href={resolve('/(app)/settings/crowdsec')} class="text-accent underline"
				>CrowdSec settings page</a
			>.
		</p>
	</div>
{:else if freshness.lastError}
	<div
		class="border border-failed bg-failed-tint px-3 py-2 text-sm text-failed"
		role="status"
		data-testid="sync-error"
	>
		<span class="font-semibold">Sync failing.</span>
		{freshness.lastError} — showing cached data{freshness.lastSuccessAt
			? `, last synced ${freshness.lastSuccessAt.toLocaleString()}`
			: ''}.
	</div>
{:else if freshness.partial}
	<div
		class="border border-degraded bg-degraded-tint px-3 py-2 text-sm text-degraded"
		role="status"
		data-testid="sync-partial"
	>
		<span class="font-semibold">Partial data.</span> Historical import is still catching up; counts grow
		as it completes.
	</div>
{:else if freshness.empty && !page.url.searchParams.size}
	<div class="border border-rule bg-sheet px-4 py-6 text-center text-sm" role="status">
		<p class="font-medium text-ink">Waiting for the first sync</p>
		<p class="mt-1 text-ink-3">The worker polls the LAPI every minute; rows appear here.</p>
	</div>
{/if}
