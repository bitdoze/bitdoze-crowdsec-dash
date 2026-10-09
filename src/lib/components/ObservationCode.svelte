<script lang="ts">
	import { cn } from '#lib/utils.ts';
	import type { ObservationCode } from '#lib/overview/types.ts';

	interface Props {
		code: ObservationCode;
		class?: string;
	}

	let { code, class: className }: Props = $props();

	const meta: Record<ObservationCode, { meaning: string; cls: string }> = {
		C1: { meaning: 'Danger present', cls: 'bg-failed-tint text-failed border-failed' },
		C2: {
			meaning: 'Potentially dangerous',
			cls: 'bg-degraded-tint text-degraded border-degraded'
		},
		FI: { meaning: 'Further investigation needed', cls: 'text-accent border-accent' },
		C3: { meaning: 'Improvement recommended', cls: 'text-ink-2 border-rule-strong' }
	};

	const m = $derived(meta[code]);
</script>

<abbr
	title="{code} — {m.meaning}"
	class={cn(
		'inline-flex items-center border px-1 py-px font-mono text-xs font-semibold no-underline',
		m.cls,
		className
	)}>{code}</abbr
>
