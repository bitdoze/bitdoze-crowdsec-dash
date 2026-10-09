<script lang="ts">
	import Stamp from './Stamp.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import Button from './Button.svelte';
	import { formatDateTime, relativeTime } from '#lib/overview/format.ts';
	import type { CheckResult, TestMeta } from '#lib/overview/types.ts';

	interface Props {
		test: TestMeta;
		result: CheckResult;
	}

	let { test, result }: Props = $props();
	let showFix = $state(false);
</script>

<div class="grid gap-4 border-t border-rule bg-panel/40 px-4 py-3 sm:grid-cols-2">
	<div>
		<div class="flex flex-wrap items-center gap-2">
			<Stamp state={result.state} />
			<span class="text-sm font-semibold">{test.code} · {test.name}</span>
		</div>
		{#if result.summary}
			<p class="mt-2 text-sm text-ink-2">{result.summary}</p>
		{/if}
		<dl class="mt-3 space-y-1 text-xs">
			{#if result.method}
				<div class="flex gap-2">
					<dt class="w-24 shrink-0 font-semibold tracking-[0.05em] text-ink-3 uppercase">Method</dt>
					<dd class="text-ink-2">{result.method}</dd>
				</div>
			{/if}
			<div class="flex gap-2">
				<dt class="w-24 shrink-0 font-semibold tracking-[0.05em] text-ink-3 uppercase">Measured</dt>
				<dd class="text-ink-2">
					{#if result.measuredAt}
						<time datetime={result.measuredAt} title={formatDateTime(result.measuredAt)}>
							{relativeTime(result.measuredAt)}
						</time>
					{:else}
						Never
					{/if}
				</dd>
			</div>
			{#each result.evidence as item (item.label)}
				<div class="flex gap-2">
					<dt class="w-24 shrink-0 font-semibold tracking-[0.05em] text-ink-3 uppercase">
						{item.label}
					</dt>
					<dd class="font-mono text-ink-2">{item.value}</dd>
				</div>
			{/each}
		</dl>
	</div>
	<div class="border-t border-rule pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4">
		{#if result.nextStep}
			<p class="text-xs font-semibold tracking-[0.05em] text-ink-3 uppercase">Next step</p>
			<p class="mt-1 text-sm text-ink-2">{result.nextStep}</p>
		{/if}
		{#if result.fix}
			<div class="mt-3">
				<Button size="sm" onclick={() => (showFix = !showFix)} aria-expanded={showFix}>
					{showFix ? 'Hide fix' : 'Show fix'}
				</Button>
				{#if showFix}
					<div class="mt-2 space-y-2">
						<p class="text-sm font-medium">{result.fix.title}</p>
						<ol class="list-decimal space-y-1 pl-4 text-sm text-ink-2">
							{#each result.fix.steps as step, i (i)}
								<li>{step}</li>
							{/each}
						</ol>
						{#if result.fix.code}
							<CodeBlock code={result.fix.code} />
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
