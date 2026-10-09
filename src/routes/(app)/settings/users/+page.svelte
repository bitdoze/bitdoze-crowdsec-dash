<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Field from '#lib/components/Field.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';
	import Button from '#lib/components/Button.svelte';
	import { primaryRole, ROLES } from '#lib/roles.ts';

	let { data, form }: PageProps & { form: ActionData } = $props();

	let newRole = $state('viewer');
	let roleDraft = $state<Record<string, string>>({});
	let confirmRemove = $state<string | null>(null);
</script>

<svelte:head><title>Users — CrowdSec Dash</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
	<header
		class="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule-strong pb-4"
	>
		<div>
			<h1 class="text-xl font-semibold tracking-tight">User administration</h1>
			<p class="mt-1 text-sm text-ink-3">
				Accounts, roles, and access. Every change is written to the audit log.
			</p>
		</div>
		<nav class="text-xs text-ink-3">
			<a href={resolve('/(app)/settings')} class="text-accent underline">Account settings</a>
		</nav>
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

	<Module title="Create account">
		<form method="post" action="?/createUser" class="flex flex-wrap items-end gap-4">
			<Field label="Email" name="email" type="email" required autocomplete="off" class="w-64" />
			<Field
				label="Temporary password"
				name="password"
				type="password"
				required
				minlength={12}
				autocomplete="new-password"
				hint="At least 12 characters; the user changes it in Settings."
				class="w-64"
			/>
			<FilterSelect
				label="Role"
				options={ROLES.map((r) => ({ value: r, label: r }))}
				value={newRole}
				onchange={(v) => (newRole = v)}
			/>
			<input type="hidden" name="role" value={newRole} />
			<Field label="Display name" name="name" autocomplete="off" class="w-48" />
			<Button variant="primary" type="submit">Create</Button>
		</form>
	</Module>

	<Module title="Accounts">
		<div class="overflow-x-auto">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-rule-strong text-left">
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Account</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Role</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>2FA</th
						>
						<th class="py-1.5 pr-3 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							>Status</th
						>
						<th class="py-1.5 text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase"
							><span class="sr-only">Actions</span></th
						>
					</tr>
				</thead>
				<tbody>
					{#each data.users as u (u.id)}
						{@const isSelf = u.id === data.adminId}
						<tr class="border-b border-rule last:border-0">
							<td class="py-2 pr-3">
								<div class="font-medium text-ink">{u.name || u.email}</div>
								<div class="text-xs text-ink-3">
									{u.email}{isSelf ? ' · you' : ''}
								</div>
							</td>
							<td class="py-2 pr-3">
								<form method="post" action="?/setRole" class="flex items-center gap-2">
									<input type="hidden" name="userId" value={u.id} />
									<input type="hidden" name="role" value={roleDraft[u.id] ?? primaryRole(u.role)} />
									<FilterSelect
										label="Role for {u.email}"
										hideLabel
										options={ROLES.map((r) => ({ value: r, label: r }))}
										value={roleDraft[u.id] ?? primaryRole(u.role)}
										disabled={isSelf}
										onchange={(v) => (roleDraft[u.id] = v)}
									/>
									<Button
										size="sm"
										type="submit"
										disabled={isSelf ||
											(roleDraft[u.id] ?? primaryRole(u.role)) === primaryRole(u.role)}
									>
										Apply
									</Button>
								</form>
							</td>
							<td class="py-2 pr-3">
								{#if u.twoFactorEnabled}
									<Stamp state="verified" label="On" />
								{:else}
									<Stamp state="not_configured" label="Off" />
								{/if}
							</td>
							<td class="py-2 pr-3">
								{#if u.banned}
									<Stamp state="failed" label="Banned" />
								{:else}
									<Stamp state="verified" label="Active" />
								{/if}
							</td>
							<td class="py-2">
								{#if !isSelf}
									<div class="flex justify-end gap-2">
										<form method="post" action="?/setBanned">
											<input type="hidden" name="userId" value={u.id} />
											<input type="hidden" name="banned" value={String(!u.banned)} />
											<Button size="sm" type="submit">{u.banned ? 'Unban' : 'Ban'}</Button>
										</form>
										{#if confirmRemove === u.id}
											<form method="post" action="?/removeUser" class="flex items-center gap-2">
												<input type="hidden" name="userId" value={u.id} />
												<span class="text-xs text-failed">Remove {u.email}?</span>
												<Button size="sm" type="submit" class="border-failed text-failed"
													>Confirm</Button
												>
												<Button size="sm" type="button" onclick={() => (confirmRemove = null)}
													>Keep</Button
												>
											</form>
										{:else}
											<Button size="sm" type="button" onclick={() => (confirmRemove = u.id)}
												>Remove</Button
											>
										{/if}
									</div>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</Module>
</div>
