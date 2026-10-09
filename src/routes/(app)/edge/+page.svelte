<script lang="ts">
	import type { PageProps } from './$types';
	import Module from '#lib/components/Module.svelte';
	import Stamp from '#lib/components/Stamp.svelte';
	import Button from '#lib/components/Button.svelte';
	import Field from '#lib/components/Field.svelte';

	let { data, form }: PageProps = $props();

	const fmt = (d: Date | null | undefined) => (d ? new Date(d).toLocaleString() : '—');
	const stamp = (state: string | null) =>
		state === 'ok' ? 'verified' : state === 'degraded' ? 'stale' : 'failed';
</script>

<svelte:head><title>Edge · CrowdSec Dash</title></svelte:head>

<div class="space-y-5">
	<header class="border-b border-rule-strong pb-4">
		<h1 class="text-xl font-semibold tracking-tight">Edge enforcement</h1>
		<p class="mt-1 max-w-2xl text-sm text-ink-3">
			Push this server's decisions to Cloudflare — one account-level IP list plus one WAF custom
			rule per selected zone. Shared IP enforcement at the edge; it does not run the AppSec engine
			in Cloudflare or replace Cloudflare's native WAF.
		</p>
	</header>

	{#if form?.notice}
		<div role="status" class="border border-rule bg-sheet px-4 py-3 text-sm text-ink-2">
			{form.notice}
		</div>
	{/if}

	{#each data.accounts as account (account.id)}
		<Module title={account.name}>
			<div class="flex flex-wrap items-center gap-2">
				{#if account.tokenStatus === 'active'}
					<Stamp state="verified" label="Token active" />
				{:else if account.tokenStatus}
					<Stamp state="failed" label={`Token ${account.tokenStatus}`} />
				{:else}
					<Stamp state="not_configured" label="Unverified" />
				{/if}
				{#if account.stale}
					<Stamp state="stale" label="Sync stale" />
				{/if}
				{#if account.cfAccountId}
					<span class="font-mono text-xs text-ink-3">account {account.cfAccountId}</span>
				{/if}
			</div>

			{#if account.lastError}
				<p class="mt-2 text-sm text-failed">{account.lastError}</p>
			{/if}

			{#if account.permissions.length}
				<div class="mt-3">
					<p class="text-xs font-medium tracking-wide text-ink-3 uppercase">Permissions</p>
					<div class="mt-1 flex flex-wrap gap-1">
						{#each account.permissions as p (p)}
							<span
								class="rounded-[3px] border border-rule px-1.5 py-0.5 font-mono text-xs text-ink-2"
								>{p}</span
							>
						{/each}
					</div>
				</div>
			{/if}

			<div class="mt-4 grid gap-4 lg:grid-cols-2">
				<div class="border border-rule p-3">
					<div class="flex items-center justify-between gap-2">
						<h3 class="text-sm font-semibold">Decision list</h3>
						{#if account.lastSyncState}
							<Stamp state={stamp(account.lastSyncState)} label={account.lastSyncState} />
						{/if}
					</div>
					{#if account.listId}
						<p class="mt-2 font-mono text-xs text-ink-2">{account.listName}</p>
						<p class="mt-1 text-sm text-ink-3">
							{account.listItemCount ?? 0} items · {account.listOwned
								? 'created by this dashboard'
								: 'adopted — never deleted on uninstall'}
							{#if account.listDropped}
								· <span class="text-degraded">{account.listDropped} over capacity</span>
							{/if}
						</p>
						<p class="mt-1 text-xs text-ink-3">
							last sync {fmt(account.lastSyncAt)}
							{#if account.lastSyncError}
								· <span class="text-failed">{account.lastSyncError}</span>
							{/if}
						</p>
						<p class="mt-2 text-xs text-ink-3">
							List items do not expire at Cloudflare — this dashboard removes them when decisions
							end. If sync stops, the list goes stale rather than empty.
						</p>
					{:else}
						<p class="mt-2 text-sm text-ink-3">
							No list yet — one IP list per account carries all local decisions (<code
								>crowdsec_dash_*</code
							>). A compatible existing list can be adopted.
						</p>
						{#if data.canOperate}
							<form method="post" action="?/createList" class="mt-3">
								<input type="hidden" name="accountId" value={account.id} />
								<Button type="submit">Adopt or create list</Button>
							</form>
						{/if}
					{/if}
					{#if data.canOperate && account.listId}
						<form method="post" action="?/syncNow" class="mt-3 inline">
							<input type="hidden" name="accountId" value={account.id} />
							<Button type="submit" variant="secondary">Sync now</Button>
						</form>
					{/if}
				</div>

				<div class="border border-rule p-3">
					<h3 class="text-sm font-semibold">Zones</h3>
					{#if account.zones.length === 0}
						<p class="mt-2 text-sm text-ink-3">
							No zones discovered — re-verify the token after granting Zone Read.
						</p>
					{:else}
						<ul class="mt-2 space-y-2">
							{#each account.zones as zone (zone.id)}
								<li class="border border-rule px-3 py-2">
									<form method="post" action="?/zone" class="flex flex-wrap items-center gap-2">
										<input type="hidden" name="zoneId" value={zone.id} />
										<label class="flex items-center gap-1.5 text-sm">
											<input type="checkbox" name="selected" value="1" checked={zone.selected} />
											<span class="font-mono">{zone.name}</span>
										</label>
										<span class="text-xs text-ink-3">{zone.plan}</span>
										{#if zone.ruleId}
											<Stamp state="verified" label="rule installed" />
										{/if}
										<input
											type="text"
											name="hostnames"
											placeholder="all hosts — or list hostnames"
											value={zone.hostnames.join(' ')}
											class="min-w-40 flex-1 rounded-[3px] border border-line bg-sheet px-2 py-1 font-mono text-xs"
										/>
										<select
											name="action"
											class="rounded-[3px] border border-line bg-sheet px-1.5 py-1 text-xs"
										>
											<option value="block" selected={zone.action === 'block'}>Block</option>
											<option value="challenge" selected={zone.action === 'challenge'}>
												Managed Challenge
											</option>
										</select>
										{#if data.canOperate}
											<Button type="submit" variant="secondary">Apply</Button>
										{/if}
									</form>
								</li>
							{/each}
						</ul>
						<p class="mt-2 text-xs text-ink-3">
							One custom rule per zone (<code>ip.src in ${account.listName ?? 'list'}</code>),
							narrowed to the listed hostnames when given. Free plans allow 5 rules per zone
							{#if account.zones[0]?.rulesInUse != null}
								— {account.zones[0].rulesInUse} in use on {account.zones[0].name}
							{/if}. Captcha-type decisions get the list's action.
						</p>
					{/if}
				</div>
			</div>

			{#if data.canOperate}
				<div class="mt-4 flex flex-wrap gap-2 border-t border-rule pt-3">
					<form method="post" action="?/reverify" class="inline">
						<input type="hidden" name="accountId" value={account.id} />
						<Button type="submit" variant="secondary">Re-verify token</Button>
					</form>
					<form method="post" action="?/uninstall" class="inline">
						<input type="hidden" name="accountId" value={account.id} />
						<Button type="submit" variant="secondary">Uninstall edge</Button>
					</form>
					<form method="post" action="?/disconnect" class="inline">
						<input type="hidden" name="accountId" value={account.id} />
						<Button type="submit" variant="secondary">Disconnect</Button>
					</form>
				</div>
			{/if}
		</Module>
	{:else}
		<Module title="Connect a Cloudflare account">
			<p class="max-w-2xl text-sm text-ink-3">
				Create an API token scoped to this account with
				<strong>Account Filter Lists — Edit</strong>, <strong>Zone WAF — Edit</strong>, and
				<strong>Zone — Read</strong>. The token is validated before anything is created, stored
				encrypted, and only the zones you select get a managed rule.
			</p>
			{#if data.canOperate}
				<form method="post" action="?/connect" class="mt-4 grid max-w-lg gap-3">
					<Field label="Label" name="name" id="cf-name" placeholder="personal" />
					<Field
						label="API token"
						name="token"
						id="cf-token"
						type="password"
						required
						autocomplete="off"
						hint="Scoped to one account — never a global API key. Needs Zone:Read, Account:Account Filter Lists:Edit, and Zone:Zone WAF:Edit."
					/>
					<div><Button type="submit">Verify and connect</Button></div>
				</form>
			{:else}
				<p class="mt-3 text-sm text-ink-3">You need the operate role to connect an account.</p>
			{/if}
		</Module>
	{/each}

	<Module title="About edge enforcement">
		<ul class="list-disc space-y-1 pl-5 text-sm text-ink-3">
			<li>
				Only decisions created locally (<code>crowdsec</code>, <code>cscli</code>, AppSec) are
				pushed — the community blocklist never leaves the origin bouncer (it alone exceeds Free-plan
				capacity).
			</li>
			<li>
				Origin access logs omit cache hits and edge-blocked requests — full edge visibility needs a
				separate logging integration (later enhancement).
			</li>
			<li>
				List writes are asynchronous and serialized; a full reconcile runs periodically and after
				decision changes.
			</li>
			<li>
				The Worker bouncer mode (Turnstile captcha, &gt;10k lists) is for paid plans — see
				<code>docs/</code> before enabling it; its daemon removes Workers when it stops.
			</li>
		</ul>
	</Module>
</div>
