<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<div class="mx-auto mt-16 max-w-sm">
	<h1 class="mb-2 text-2xl font-bold">First-run setup</h1>
	<p class="mb-6 text-sm text-gray-600">
		Create the first administrator account. The setup token is printed once in the server log at
		startup.
	</p>

	{#if form?.message}
		<p class="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{form.message}</p>
	{/if}

	<form method="post" class="flex flex-col gap-4">
		<label class="flex flex-col gap-1 text-sm font-medium">
			Setup token
			<input
				class="rounded-md border border-gray-300 px-3 py-2"
				type="password"
				name="token"
				required
				autocomplete="off"
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm font-medium">
			Name
			<input
				class="rounded-md border border-gray-300 px-3 py-2"
				type="text"
				name="name"
				required
				autocomplete="name"
			/>
		</label>
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
			Password (min. 12 characters)
			<input
				class="rounded-md border border-gray-300 px-3 py-2"
				type="password"
				name="password"
				required
				minlength="12"
				autocomplete="new-password"
			/>
		</label>
		<button class="rounded-md bg-blue-600 px-4 py-2 text-white transition hover:bg-blue-700">
			Create administrator
		</button>
	</form>
</div>
