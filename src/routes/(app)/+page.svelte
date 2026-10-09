<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1 class="mb-4 text-2xl font-bold">Overview</h1>

{#if data.user}
	<p class="mb-4">Signed in as {data.user.name} ({data.user.role ?? 'viewer'}).</p>
{/if}

<form method="post" action="/logout">
	<button class="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700">
		Sign out
	</button>
</form>
