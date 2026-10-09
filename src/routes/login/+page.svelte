<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import Field from '#lib/components/Field.svelte';
	import Button from '#lib/components/Button.svelte';

	let { data, form }: PageProps & { form: ActionData } = $props();
</script>

<AuthShell title="Sign in" subtitle="Administrator access">
	{#if form?.message}
		<p class="mb-4 border border-failed bg-failed-tint px-3 py-2 text-sm text-failed" role="alert">
			{form.message}
		</p>
	{/if}

	<form method="post" class="flex flex-col gap-4">
		<input type="hidden" name="redirectTo" value={form?.redirectTo ?? data.redirectTo} />
		<Field label="Email" type="email" name="email" required autocomplete="email" />
		<Field
			label="Password"
			type="password"
			name="password"
			required
			autocomplete="current-password"
		/>
		<Button variant="primary" type="submit" class="mt-1 w-full">Sign in</Button>
	</form>
</AuthShell>
