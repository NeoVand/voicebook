<script lang="ts">
	import { ChevronLeft, ChevronRight, X } from '@lucide/svelte';
	import type { NormalizedDocument } from '$lib/domain/types';
	import { openPdfRenderer } from '$lib/services/pdf-pages';

	interface Props {
		document: NormalizedDocument;
		page: number;
		pageCount: number;
		onClose: () => void;
	}

	let { document: book, page, pageCount, onClose }: Props = $props();

	// Seeded from the opening request; prev/next then reassigns it.
	let currentPage = $derived(Math.max(1, Math.min(pageCount, page)));
	let canvas = $state<HTMLCanvasElement>();
	let strip = $state<HTMLElement>();
	let dialog = $state<HTMLElement>();
	let status = $state<'loading' | 'ready' | 'unavailable'>('loading');
	let renderToken = 0;

	$effect(() => {
		const target = currentPage;
		if (!canvas || !strip) return;
		const token = ++renderToken;
		status = 'loading';
		const cssWidth = Math.min(Math.max(strip.clientWidth - 2, 320), 900);
		void openPdfRenderer(book).then(async (renderer) => {
			if (!renderer) {
				if (token === renderToken) status = 'unavailable';
				return;
			}
			try {
				await renderer.renderPage(target, canvas!, cssWidth);
				if (token === renderToken) status = 'ready';
			} catch {
				if (token === renderToken) status = 'unavailable';
			}
		});
	});

	$effect(() => {
		const previouslyFocused = window.document.activeElement;
		dialog?.focus();
		return () => {
			if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
		};
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		} else if (event.key === 'ArrowLeft' && currentPage > 1) {
			event.preventDefault();
			currentPage -= 1;
		} else if (event.key === 'ArrowRight' && currentPage < pageCount) {
			event.preventDefault();
			currentPage += 1;
		} else if (event.key === 'Tab') {
			// Minimal focus trap: cycle within the dialog's few controls.
			const focusable = dialog?.querySelectorAll<HTMLElement>('button, [tabindex="0"]');
			if (!focusable?.length) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && window.document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && window.document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}
</script>

<div class="modal-scrim" role="presentation" onclick={onClose}>
	<div
		class="page-peek"
		role="dialog"
		aria-modal="true"
		aria-labelledby="page-peek-title"
		tabindex="-1"
		bind:this={dialog}
		onclick={(event) => event.stopPropagation()}
		onkeydown={handleKeydown}
	>
		<header>
			<div>
				<p class="eyebrow">Original page</p>
				<h2 id="page-peek-title">Page {currentPage} of {pageCount}</h2>
			</div>
			<div class="peek-controls">
				<button
					class="icon-button"
					type="button"
					aria-label="Previous page"
					disabled={currentPage <= 1}
					onclick={() => (currentPage -= 1)}
				>
					<ChevronLeft size={17} />
				</button>
				<button
					class="icon-button"
					type="button"
					aria-label="Next page"
					disabled={currentPage >= pageCount}
					onclick={() => (currentPage += 1)}
				>
					<ChevronRight size={17} />
				</button>
				<button class="icon-button" type="button" aria-label="Close" onclick={onClose}>
					<X size={17} />
				</button>
			</div>
		</header>
		<div class="peek-strip" bind:this={strip}>
			{#if status === 'unavailable'}
				<p class="peek-status" role="status">The original file isn’t available on this device.</p>
			{:else}
				{#if status === 'loading'}
					<p class="peek-status" role="status">Rendering page…</p>
				{/if}
				<canvas
					bind:this={canvas}
					class:pending={status !== 'ready'}
					aria-label={`Rendered original page ${currentPage}`}
				></canvas>
			{/if}
		</div>
	</div>
</div>

<style>
	.modal-scrim {
		position: fixed;
		z-index: 60;
		display: grid;
		place-items: center;
		padding: 20px;
		background: var(--modal-scrim);
		inset: 0;
	}

	.page-peek {
		display: flex;
		flex-direction: column;
		width: min(960px, 100%);
		max-height: calc(100dvh - 40px);
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--modal-surface);
		box-shadow: 0 24px 70px rgba(0, 0, 0, 0.35);
	}

	.page-peek:focus {
		outline: none;
	}

	.page-peek header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--line);
	}

	.eyebrow {
		margin: 0 0 2px;
		color: var(--muted);
		font-family: var(--font-ui);
		font-size: 10px;
		font-weight: 650;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.page-peek h2 {
		margin: 0;
		font-family: var(--font-ui);
		font-size: 15px;
	}

	.peek-controls {
		display: flex;
		gap: 6px;
	}

	.peek-strip {
		position: relative;
		display: grid;
		overflow: auto;
		justify-items: center;
		padding: 14px;
		background: var(--reader-code-soft, rgba(127, 127, 127, 0.08));
		border-radius: 0 0 14px 14px;
	}

	/* The canvas shows the page as authored (white paper in dark themes is
	   the point of an "original" view); only the frame follows the theme. */
	.peek-strip canvas {
		max-width: 100%;
		height: auto;
		border: 1px solid var(--line);
		border-radius: 4px;
		background: white;
	}

	.peek-strip canvas.pending {
		opacity: 0.35;
	}

	.peek-status {
		padding: 28px 12px;
		margin: 0;
		color: var(--muted);
		font-family: var(--font-ui);
		font-size: 13px;
	}
</style>
