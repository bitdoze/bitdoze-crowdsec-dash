<script lang="ts">
	import type { ActionData, PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import Button from '#lib/components/Button.svelte';
	import CodeBlock from '#lib/components/CodeBlock.svelte';
	import { primaryRole } from '#lib/roles.ts';

	let { data, form }: PageProps & { form: ActionData } = $props();

	const totpUri = $derived(form?.totpSetup?.uri ?? '');
	const totpSecret = $derived.by(() => {
		try {
			return totpUri ? (new URL(totpUri).searchParams.get('secret') ?? '') : '';
		} catch {
			return '';
		}
	});
	const role = $derived(primaryRole(data.user.role));
</script>

<svelte:head><title>Settings — CrowdSec Dash</title></svelte:head>

<div class="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
	<header
		class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule-strong pb-4"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">Account settings</h1>
			<p class="mt-1 text-sm text-ink-3">
				{data.user.email} · role <span class="font-semibold text-ink-2">{role}</span>
			</p>
		</div>
	</header>

	{#if form?.notice}
		<p
			class="border border-verified bg-verified-tint px-3 py-2 text-sm text-verified"
			role="status"
		>
			{form.notice}
		</p>
	{/if}
	{#if form?.message}
		<p class="border border-failed bg-failed-tint px-3 py-2 text-sm text-failed" role="alert">
			{form.message}
		</p>
	{/if}

	<Module title="Two-factor authentication">
		<div class="space-y-4">
			<div class="flex items-center gap-3">
				<span class="text-sm text-ink-2">Status</span>
				{#if data.user.twoFactorEnabled}
					<Stamp state="verified" label="Enabled" />
				{:else}
					<Stamp state="not_configured" label="Off" />
				{/if}
			</div>

			{#if form?.totpSetup}
				<div class="space-y-4 border border-degraded bg-degraded-tint p-4">
					<p class="text-sm text-ink">
						Add this account to your authenticator app, then enter the code it shows.
					</p>
					{#if totpUri}
						<div>
							<p class="mb-1 text-xs font-semibold tracking-[0.05em] text-ink-2 uppercase">
								Authenticator URI
							</p>
							<CodeBlock code={totpUri} />
						</div>
						{#if totpSecret}
							<p class="text-xs text-ink-2">
								Manual entry secret: <code class="font-mono text-ink">{totpSecret}</code>
							</p>
						{/if}
					{/if}
					{#if form.totpSetup.backupCodes.length > 0}
						<div>
							<p class="mb-1 text-xs font-semibold tracking-[0.05em] text-ink-2 uppercase">
								Recovery codes — shown once
							</p>
							<p class="mb-2 text-xs text-ink-3">
								Each code signs in once when the authenticator is unavailable. Store them safely.
							</p>
							<CodeBlock code={form.totpSetup.backupCodes.join('\n')} />
						</div>
					{/if}
					<form method="post" action="?/confirm2fa" class="flex flex-wrap items-end gap-3">
						<Field
							label="Verification code"
							name="code"
							required
							inputmode="numeric"
							autocomplete="one-time-code"
							class="w-40"
						/>
						<Button variant="primary" type="submit">Verify &amp; enable</Button>
						<Button type="submit" formaction="?/cancel2fa" formnovalidate>Cancel</Button>
					</form>
				</div>
			{:else if data.user.twoFactorEnabled}
				{#if form?.backupCodes}
					<div class="space-y-2 border border-degraded bg-degraded-tint p-4">
						<p class="text-sm font-semibold text-ink">New recovery codes — shown once</p>
						<CodeBlock code={form.backupCodes.join('\n')} />
					</div>
				{/if}
				<div class="flex flex-wrap gap-6">
					<form method="post" action="?/regenerateCodes" class="flex items-end gap-3">
						<Field
							label="Password"
							name="password"
							type="password"
							required
							autocomplete="current-password"
							class="w-48"
						/>
						<Button type="submit">New recovery codes</Button>
					</form>
					<form method="post" action="?/disable2fa" class="flex items-end gap-3">
						<Field
							label="Password"
							name="password"
							type="password"
							required
							autocomplete="current-password"
							class="w-48"
						/>
						<Button type="submit" class="border-failed text-failed hover:bg-failed-tint"
							>Disable 2FA</Button
						>
					</form>
				</div>
			{:else}
				<form method="post" action="?/enable2fa" class="flex items-end gap-3">
					<Field
						label="Password"
						name="password"
						type="password"
						required
						autocomplete="current-password"
						class="w-48"
					/>
					<Button variant="primary" type="submit">Enable 2FA</Button>
				</form>
			{/if}
		</div>
	</Module>

	<Module title="Sessions">
		{#if data.sessions.length === 0}
			<p class="text-sm text-ink-3">No sessions found.</p>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-sm">
					<thead>
						<tr class="border-b border-rule-strong text-left">
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>Signed in</th
							>
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>IP</th
							>
							<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								>Agent</th
							>
							<th class="py-1.5 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
								><span class="sr-only">Actions</span></th
							>
						</tr>
					</thead>
					<tbody>
						{#each data.sessions as s (s.token)}
							<tr class="border-b border-rule last:border-0">
								<td class="py-2 pr-3 whitespace-nowrap text-ink-2">
									{new Date(s.createdAt).toLocaleString(undefined, {
										dateStyle: 'medium',
										timeStyle: 'short'
									})}
									{#if s.current}
										<span
											class="ml-2 border border-verified bg-verified-tint px-1 py-px text-xs font-semibold text-verified"
											>current</span
										>
									{/if}
								</td>
								<td class="py-2 pr-3 font-mono text-xs text-ink-2">{s.ipAddress ?? '—'}</td>
								<td class="max-w-0 truncate py-2 pr-3 text-xs text-ink-3" title={s.userAgent ?? ''}
									>{s.userAgent ?? '—'}</td
								>
								<td class="py-2 text-right">
									{#if !s.current}
										<form method="post" action="?/revokeSession">
											<input type="hidden" name="token" value={s.token} />
											<Button size="sm" type="submit">Revoke</Button>
										</form>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if data.sessions.some((s) => !s.current)}
				<form method="post" action="?/revokeOtherSessions" class="mt-3">
					<Button size="sm" type="submit">Sign out all other sessions</Button>
				</form>
			{/if}
		{/if}
	</Module>

	<Module title="Change password">
		<form method="post" action="?/changePassword" class="flex flex-wrap items-end gap-4">
			<Field
				label="Current password"
				name="currentPassword"
				type="password"
				required
				autocomplete="current-password"
				class="w-48"
			/>
			<Field
				label="New password"
				name="newPassword"
				type="password"
				required
				minlength={12}
				autocomplete="new-password"
				hint="At least 12 characters. Other sessions are signed out."
				class="w-56"
			/>
			<Button variant="primary" type="submit">Change password</Button>
		</form>
	</Module>
</div>
