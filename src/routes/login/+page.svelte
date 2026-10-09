<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import AuthShell from '#lib/components/AuthShell.svelte';
	import Field from '#lib/components/Field.svelte';
	import Button from '#lib/components/Button.svelte';

	let { data, form }: PageProps & { form: ActionData } = $props();
	let useRecovery = $state(false);
</script>

<AuthShell
	title={form?.needsTwoFactor ? 'Two-factor verification' : 'Sign in'}
	subtitle={form?.needsTwoFactor ? 'Enter the second factor' : 'Administrator access'}
>
	{#if form?.message}
		<p class="mb-4 border border-failed bg-failed-tint px-3 py-2 text-sm text-failed" role="alert">
			{form.message}
		</p>
	{/if}

	{#if form?.needsTwoFactor}
		<form
			method="post"
			action={useRecovery ? '?/verifyBackup' : '?/verify'}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="redirectTo" value={form.redirectTo ?? data.redirectTo} />
			<Field
				label={useRecovery ? 'Recovery code' : 'Verification code'}
				name="code"
				required
				autocomplete="one-time-code"
				inputmode={useRecovery ? 'text' : 'numeric'}
				hint={useRecovery
					? 'One of the recovery codes saved when two-factor was enabled.'
					: 'The six-digit code from your authenticator app.'}
			/>
			<Button variant="primary" type="submit" class="mt-1 w-full">Verify</Button>
			<button
				type="button"
				class="cursor-pointer self-start text-xs text-accent underline"
				onclick={() => (useRecovery = !useRecovery)}
			>
				{useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
			</button>
		</form>
	{:else}
		<form method="post" action="?/signIn" class="flex flex-col gap-4">
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
	{/if}
</AuthShell>
