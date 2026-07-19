<script lang="ts">
	import { Image as ImageIcon, Maximize2, Minimize2, Shapes } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		kind: 'image' | 'diagram';
		/** The rendered media (an image or an inline diagram). */
		media: Snippet;
		/** The reader's construct panel with the spoken description and edit
		 * controls; absent for media nothing can describe. */
		panel?: Snippet;
	}

	let { kind, media, panel }: Props = $props();
	let fullSize = $state(false);
	const componentId = $props.id();
	const captionId = `${componentId}-caption`;
</script>

<figure class="media-figure" class:full-size={fullSize} aria-labelledby={captionId}>
	<figcaption id={captionId}>
		<span>
			{#if kind === 'diagram'}<Shapes size={15} aria-hidden="true" /> Diagram{:else}<ImageIcon
					size={15}
					aria-hidden="true"
				/> Image{/if}
		</span>
		<button
			class="size-toggle"
			type="button"
			aria-pressed={fullSize}
			onclick={() => (fullSize = !fullSize)}
		>
			{#if fullSize}<Minimize2 size={13} aria-hidden="true" /> Fit width{:else}<Maximize2
					size={13}
					aria-hidden="true"
				/> Full size{/if}
		</button>
	</figcaption>

	<div class="media-output">
		{@render media()}
	</div>

	{#if panel}
		{@render panel()}
	{/if}
</figure>

<style>
	.media-figure {
		margin: 2.2em 0;
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
		font-family: var(--font-ui);
	}

	figcaption {
		display: flex;
		min-height: 40px;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		color: var(--reader-quiet);
		font-size: 0.64em;
		font-weight: 680;
		letter-spacing: 0.075em;
		text-transform: uppercase;
	}

	figcaption span {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.size-toggle {
		display: inline-flex;
		height: 30px;
		align-items: center;
		gap: 6px;
		padding: 0 8px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--reader-quiet);
		font-size: 10px;
		font-weight: 620;
		letter-spacing: 0;
		text-transform: none;
	}

	.size-toggle:hover {
		background: var(--reader-code-soft);
		color: var(--reader-ink);
	}

	.media-output {
		max-width: 100%;
		overflow-x: auto;
		padding: 4px 0 14px;
		overscroll-behavior-inline: contain;
		scrollbar-color: var(--reader-rule) transparent;
	}

	.media-output :global(img),
	.media-output :global(svg.docx-diagram) {
		margin: 0 auto;
	}

	/* Raster media can't adapt to the theme the way redrawn diagrams do —
	 * a transparent PNG with dark strokes vanishes on a dark page. A quiet
	 * paper backing keeps figures legible everywhere; on light themes it
	 * disappears into the page. */
	.media-output :global(img) {
		padding: 8px;
		border-radius: 6px;
		background: color-mix(in srgb, #fff 96%, var(--reader) 4%);
	}

	/* Full size grows the media to at least the column width (small media
	 * scales up, oversized media stays natural and the strip scrolls),
	 * exactly like the Mermaid figure. */
	.media-figure.full-size .media-output :global(img),
	.media-figure.full-size .media-output :global(svg.docx-diagram) {
		width: auto;
		min-width: 100%;
		height: auto;
		max-width: none;
	}
</style>
