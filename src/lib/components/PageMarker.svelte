<script lang="ts">
	import { FileSearch } from '@lucide/svelte';

	interface Props {
		page: number;
		/** Opens the original-page view; absent hides the button (no stored
		 * source to render). */
		onPeek?: (page: number) => void;
	}

	let { page, onPeek }: Props = $props();
</script>

<!-- Not a segment and never selectable: clicks fall through to nothing and
     copied text skips the label, so read-along and "Play from here" are
     unaffected by the marker sitting between paragraphs. -->
<div class="page-marker" role="separator" aria-label={`Page ${page}`} data-page={page}>
	<span class="page-marker-label">Page {page}</span>
	{#if onPeek}
		<button
			type="button"
			aria-label={`View original page ${page}`}
			title="View original page"
			onclick={() => onPeek?.(page)}
		>
			<FileSearch size={12} strokeWidth={2} />
		</button>
	{/if}
</div>

<style>
	.page-marker {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 2.2em 0 1.4em;
		user-select: none;
	}

	.page-marker::before {
		content: '';
		flex: 1;
		border-top: 1px solid var(--reader-rule);
	}

	.page-marker-label {
		color: var(--faint);
		font-family: var(--font-ui);
		font-size: 8px;
		font-weight: 650;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.page-marker button {
		display: grid;
		width: 22px;
		height: 22px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--faint);
		cursor: pointer;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.page-marker button:hover,
	.page-marker button:focus-visible {
		background: var(--reader-code-soft);
		color: var(--reader-ink);
	}
</style>
