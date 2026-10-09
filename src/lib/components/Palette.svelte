<script lang="ts">
	import { Dialog } from 'bits-ui';
	import Search from '@lucide/svelte/icons/search';
	import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
	import { cn } from '#lib/utils.ts';

	export interface PaletteItem {
		id: string;
		label: string;
		/** Right-hand note, e.g. "Planned" or "v0.1.0". */
		hint?: string;
		disabled?: boolean;
		action?: () => void;
	}

	interface Props {
		open?: boolean;
		items: PaletteItem[];
		placeholder?: string;
	}

	let { open = $bindable(false), items, placeholder = 'Search or jump to…' }: Props = $props();

	let query = $state('');
	let selected = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	const filtered = $derived(
		query.trim() === ''
			? items
			: items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()))
	);

	// Clamp the selection when the list shrinks.
	$effect(() => {
		if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
	});

	$effect(() => {
		if (open) {
			query = '';
			selected = 0;
		}
	});

	// The input binds when the dialog finishes mounting; focus it then.
	$effect(() => {
		if (open && inputEl) inputEl.focus();
	});

	function move(delta: number) {
		if (filtered.length === 0) return;
		let next = selected;
		for (let i = 0; i < filtered.length; i++) {
			next = (next + delta + filtered.length) % filtered.length;
			if (!filtered[next].disabled) break;
		}
		selected = next;
	}

	function activate(item: PaletteItem) {
		if (item.disabled || !item.action) return;
		open = false;
		item.action();
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			move(1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			move(-1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const item = filtered[selected];
			if (item) activate(item);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="overlay-fade fixed inset-0 z-40 bg-ink/40" />
		<Dialog.Content
			class="fixed top-[18vh] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-[6px] border border-line bg-sheet shadow-overlay outline-none"
			aria-label="Command palette"
		>
			<div class="flex items-center gap-2 border-b border-rule px-3 py-2">
				<Search size={14} strokeWidth={1.75} class="shrink-0 text-ink-3" aria-hidden="true" />
				<input
					bind:this={inputEl}
					bind:value={query}
					{placeholder}
					{onkeydown}
					class="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-activedescendant={filtered[selected]
						? `palette-item-${filtered[selected].id}`
						: undefined}
				/>
			</div>
			<ul id="palette-list" role="listbox" class="max-h-72 overflow-y-auto p-1">
				{#each filtered as item, i (item.id)}
					<li role="presentation">
						<button
							type="button"
							id={`palette-item-${item.id}`}
							role="option"
							aria-selected={i === selected}
							disabled={item.disabled}
							class={cn(
								'flex w-full items-center justify-between gap-3 rounded-[3px] px-2 py-1.5 text-left text-sm',
								i === selected && 'bg-panel',
								item.disabled ? 'cursor-not-allowed text-ink-3' : 'text-ink'
							)}
							onmousemove={() => {
								if (!item.disabled) selected = i;
							}}
							onclick={() => activate(item)}
						>
							<span class="truncate">{item.label}</span>
							{#if item.disabled && item.hint}
								<span class="shrink-0 text-xs text-ink-3">{item.hint}</span>
							{:else if i === selected && !item.disabled}
								<CornerDownLeft
									size={13}
									strokeWidth={1.75}
									class="shrink-0 text-ink-3"
									aria-hidden="true"
								/>
							{/if}
						</button>
					</li>
				{:else}
					<li class="px-2 py-3 text-sm text-ink-3">No matches.</li>
				{/each}
			</ul>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
