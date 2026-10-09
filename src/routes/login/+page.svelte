<script lang="ts">
	import type { ActionData, PageProps } from './$types';

	let { data, form }: PageProps & { form: ActionData } = $props();
</script>

<div class="mx-auto mt-16 max-w-sm">
	<h1 class="mb-6 text-2xl font-bold">Sign in</h1>

	{#if form?.message}
		<p class="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{form.message}</p>
	{/if}

	<form method="post" class="flex flex-col gap-4">
		<input type="hidden" name="redirectTo" value={form?.redirectTo ?? data.redirectTo} />
		<label class="flex flex-col gap-1 text-sm font-medium">
			Email
			<input
				class="rounded-md border border-gray-300 px-3 py-2"
				type="email"
				name="email"
				required
				autocomplete="email"
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm font-medium">
			Password
			<input
				class="rounded-md border border-gray-300 px-3 py-2"
				type="password"
				name="password"
				required
				autocomplete="current-password"
			/>
		</label>
		<button class="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700">
			Sign in
		</button>
	</form>
</div>
