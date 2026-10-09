<script lang="ts">
	import type { ActionData } from './$types';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import Field from '#lib/components/Field.svelte';
	import Button from '#lib/components/Button.svelte';

	let { form }: { form: ActionData } = $props();
</script>

<AuthShell title="First-run setup" subtitle="Create the administrator account">
	<p class="mb-4 text-sm text-ink-2">
		The one-time setup token is printed in the server log at startup. This page disappears once the
		first account exists.
	</p>

	{#if form?.message}
		<p class="mb-4 border border-failed bg-failed-tint px-3 py-2 text-sm text-failed" role="alert">
			{form.message}
		</p>
	{/if}

	<form method="post" class="flex flex-col gap-4">
		<Field
			label="Setup token"
			type="password"
			name="token"
			required
			autocomplete="off"
			hint="From the server log, or SETUP_TOKEN"
		/>
		<Field label="Name" type="text" name="name" required autocomplete="name" />
		<Field label="Email" type="email" name="email" required autocomplete="email" />
		<Field
			label="Password"
			hint="Minimum 12 characters"
			type="password"
			name="password"
			required
			minlength={12}
			autocomplete="new-password"
		/>
		<Button variant="primary" type="submit" class="mt-1 w-full">Create administrator</Button>
	</form>
</AuthShell>
