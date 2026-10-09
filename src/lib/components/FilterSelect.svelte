<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { cn } from '#lib/utils.ts';

	interface Option {
		value: string;
		label: string;
		disabled?: boolean;
	}

	interface Props {
		label: string;
		value: string;
		options: Option[];
		/** Form field name — set when the select lives inside a GET form. */
		name?: string;
		disabled?: boolean;
		hideLabel?: boolean;
		class?: string;
		onchange?: (value: string) => void;
	}

	let {
		label,
		value,
		options,
		name,
		disabled = false,
		hideLabel = false,
		class: className,
		onchange
	}: Props = $props();
	const id = $props.id();
</script>

<div class={cn('flex items-center gap-1.5', className)}>
	<label
		for={id}
		class={cn(
			'text-xs font-semibold tracking-[0.05em] whitespace-nowrap text-ink-3 uppercase',
			hideLabel && 'sr-only'
		)}
	>
		{label}
	</label>
	<span class="relative inline-flex items-center">
		<select
			{id}
			{name}
			{disabled}
			class="cursor-pointer appearance-none rounded-[3px] border border-line bg-sheet py-1 pr-6 pl-2 text-sm text-ink hover:border-ink-3 disabled:cursor-not-allowed disabled:text-ink-3"
			{value}
			onchange={(e) => onchange?.(e.currentTarget.value)}
		>
			{#each options as option (option.value)}
				<option value={option.value} disabled={option.disabled}>{option.label}</option>
			{/each}
		</select>
		<ChevronDown
			size={13}
			strokeWidth={1.75}
			class="pointer-events-none absolute right-1.5 text-ink-3"
			aria-hidden="true"
		/>
	</span>
</div>
