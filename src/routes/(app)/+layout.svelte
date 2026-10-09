<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { DropdownMenu } from 'bits-ui';
	import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
	import Globe from '@lucide/svelte/icons/globe';
	import Siren from '@lucide/svelte/icons/siren';
	import Ban from '@lucide/svelte/icons/ban';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Bell from '@lucide/svelte/icons/bell';
	import Activity from '@lucide/svelte/icons/activity';
	import Settings from '@lucide/svelte/icons/settings';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import Search from '@lucide/svelte/icons/search';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import LogOut from '@lucide/svelte/icons/log-out';
	import type { LayoutProps } from './$types';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import Menu from '#lib/components/Menu.svelte';
	import MenuItem from '#lib/components/MenuItem.svelte';
	import Palette, { type PaletteItem } from '#lib/components/Palette.svelte';
	import FilterSelect from '#lib/components/FilterSelect.svelte';
	import Kbd from '#lib/components/Kbd.svelte';
	import { cn } from '#lib/utils.ts';

	let { data, children }: LayoutProps = $props();

	let navOpen = $state(false);
	let paletteOpen = $state(false);
	let isMac = $state(false);

	onMount(() => {
		isMac = /mac/i.test(navigator.platform);
	});

	const nav = $derived([
		{
			id: 'overview',
			label: 'Overview',
			icon: LayoutDashboard,
			href: resolve('/(app)'),
			active: page.url.pathname === '/'
		},
		{ id: 'sites', label: 'Sites', icon: Globe, planned: true as const },
		{ id: 'alerts', label: 'Alerts', icon: Siren, planned: true as const },
		{ id: 'decisions', label: 'Decisions', icon: Ban, planned: true as const },
		{ id: 'protection', label: 'Protection', icon: ShieldCheck, planned: true as const },
		{ id: 'notifications', label: 'Notifications', icon: Bell, planned: true as const },
		{ id: 'system', label: 'System', icon: Activity, planned: true as const },
		{
			id: 'settings',
			label: 'Settings',
			icon: Settings,
			href: resolve('/(app)/settings'),
			active: page.url.pathname.startsWith('/settings')
		}
	]);

	function updateParams(changes: Record<string, string | null>) {
		const params = new SvelteURLSearchParams(page.url.search);
		for (const [key, value] of Object.entries(changes)) {
			if (value === null) params.delete(key);
			else params.set(key, value);
		}
		goto(resolve(`/(app)?${params.toString()}`), { replace: true, reset: false });
	}

	const selectedSite = $derived(page.url.searchParams.get('site') ?? '');
	const range = $derived(page.url.searchParams.get('range') ?? '24h');

	const siteOptions = $derived([
		{ value: '', label: 'All sites' },
		...data.shell.sites.map((s) => ({ value: s.id, label: s.hostname }))
	]);

	const rangeOptions = [
		{ value: '1h', label: 'Last 1 h' },
		{ value: '6h', label: 'Last 6 h' },
		{ value: '24h', label: 'Last 24 h' }
	];

	function signOut() {
		(document.getElementById('logout-form') as HTMLFormElement | null)?.requestSubmit();
	}

	const paletteItems: PaletteItem[] = $derived([
		{ id: 'go-overview', label: 'Go to Overview', action: () => goto(resolve('/(app)')) },
		{ id: 'go-settings', label: 'Go to Settings', action: () => goto(resolve('/(app)/settings')) },
		{ id: 'search-ip', label: 'Search by IP address', hint: 'v0.1.0', disabled: true },
		...nav
			.filter((item) => item.planned)
			.map((item) => ({
				id: `go-${item.id}`,
				label: `Go to ${item.label}`,
				hint: 'Planned',
				disabled: true
			})),
		{ id: 'sign-out', label: 'Sign out', action: signOut }
	]);

	function onGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			paletteOpen = !paletteOpen;
		}
	}

	const initials = $derived(
		(data.user?.name ?? data.user?.email ?? '?')
			.split(/\s+/)
			.map((part) => part[0])
			.join('')
			.slice(0, 2)
			.toUpperCase()
	);
</script>

<svelte:window onkeydown={onGlobalKeydown} />

{#snippet navList()}
	<nav aria-label="Main" class="flex-1 overflow-y-auto px-2 py-3">
		<ul class="space-y-0.5">
			{#each nav as item (item.id)}
				{@const Icon = item.icon}
				<li>
					{#if item.planned}
						<span
							class="flex cursor-not-allowed items-center justify-between gap-2 rounded-[3px] px-2 py-1.5 text-sm text-ink-3"
							aria-disabled="true"
						>
							<span class="flex items-center gap-2">
								<Icon size={15} strokeWidth={1.75} aria-hidden="true" />
								{item.label}
							</span>
							<span class="text-xs">Planned</span>
						</span>
					{:else}
						<a
							href={item.href}
							aria-current={item.active ? 'page' : undefined}
							class={cn(
								'flex items-center gap-2 rounded-[3px] px-2 py-1.5 text-sm',
								item.active
									? 'bg-sheet font-medium text-ink shadow-[inset_0_0_0_1px_var(--color-rule-strong)]'
									: 'text-ink-2 hover:bg-sheet hover:text-ink'
							)}
						>
							<Icon size={15} strokeWidth={1.75} aria-hidden="true" />
							{item.label}
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>
{/snippet}

<div class="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
	<aside class="sticky top-0 hidden h-dvh flex-col border-r border-rule-strong bg-panel lg:flex">
		<div class="border-b border-rule px-4 py-3">
			<Wordmark />
		</div>
		{@render navList()}
		<div class="border-t border-rule px-4 py-2 text-xs text-ink-3">v0.0.1 · self-hosted</div>
	</aside>

	<Sheet bind:open={navOpen}>
		<div class="border-b border-rule px-4 py-3">
			<Wordmark />
		</div>
		{@render navList()}
	</Sheet>

	<div class="flex min-w-0 flex-col">
		<header
			class="sticky top-0 z-30 flex items-center gap-2 border-b border-rule-strong bg-paper px-3 py-2 sm:gap-3 sm:px-4"
		>
			<button
				type="button"
				class="inline-flex cursor-pointer items-center justify-center rounded-[3px] p-1.5 text-ink-2 hover:bg-panel lg:hidden"
				aria-label="Open navigation"
				onclick={() => (navOpen = true)}
			>
				<MenuIcon size={18} strokeWidth={1.75} />
			</button>

			<div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
				<FilterSelect
					label="Site"
					value={selectedSite}
					options={siteOptions}
					disabled={siteOptions.length <= 1}
					onchange={(v) => updateParams({ site: v || null })}
				/>
				<FilterSelect
					label="Range"
					value={range}
					options={rangeOptions}
					class="hidden sm:flex"
					onchange={(v) => updateParams({ range: v === '24h' ? null : v })}
				/>
				{#if data.shell.source === 'fixture'}
					<span
						class="inline-flex items-center rounded-[3px] border border-degraded bg-degraded-tint px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-degraded"
					>
						Fixture data
					</span>
				{/if}
			</div>

			<button
				type="button"
				class="hidden cursor-pointer items-center gap-2 rounded-[3px] border border-line bg-sheet px-2 py-1 text-sm text-ink-3 hover:text-ink sm:inline-flex"
				onclick={() => (paletteOpen = true)}
			>
				<Search size={13} strokeWidth={1.75} aria-hidden="true" />
				<span class="hidden md:inline">Search or jump to</span>
				<Kbd>{isMac ? '⌘' : 'Ctrl'} K</Kbd>
			</button>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="inline-flex cursor-pointer items-center gap-1.5 rounded-[3px] py-1 pr-1 pl-1 hover:bg-panel"
					aria-label="Account menu"
				>
					<span
						class="inline-flex size-7 items-center justify-center rounded-full border border-line bg-panel text-xs font-semibold text-ink-2"
					>
						{initials}
					</span>
					<ChevronDown size={13} strokeWidth={1.75} class="text-ink-3" aria-hidden="true" />
				</DropdownMenu.Trigger>
				<Menu>
					<div class="px-2 py-1.5">
						<p class="truncate text-sm font-medium text-ink">{data.user?.name}</p>
						<p class="truncate text-xs text-ink-3">{data.user?.email}</p>
					</div>
					<DropdownMenu.Separator class="mx-1 my-1 border-t border-rule" />
					<MenuItem onSelect={() => goto(resolve('/(app)/settings'))}>Account settings</MenuItem>
					<MenuItem onSelect={signOut}>
						<LogOut size={14} strokeWidth={1.75} aria-hidden="true" />
						Sign out
					</MenuItem>
				</Menu>
			</DropdownMenu.Root>
		</header>

		<main class="mx-auto w-full max-w-[1440px] flex-1 px-3 py-5 sm:px-5 lg:px-8">
			{@render children()}
		</main>
	</div>
</div>

<Palette bind:open={paletteOpen} items={paletteItems} />

<form id="logout-form" method="post" action="/logout" class="hidden" aria-hidden="true"></form>
