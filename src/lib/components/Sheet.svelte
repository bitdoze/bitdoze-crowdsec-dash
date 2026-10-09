<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Dialog } from 'bits-ui';

	interface Props {
		open?: boolean;
		children: Snippet;
	}

	let { open = $bindable(false), children }: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="overlay-fade fixed inset-0 z-40 bg-ink/40" />
		<Dialog.Content
			class="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-panel shadow-overlay outline-none"
			aria-label="Navigation"
		>
			{@render children()}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
