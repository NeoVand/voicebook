<script lang="ts">
	import type { InlineMark, InlineRun } from '$lib/domain/types';
	import MathFormula from './MathFormula.svelte';

	interface Props {
		run: InlineRun;
		pieces?: Array<{ text: string; wordIndex?: number }>;
		activeWordIndex?: number;
	}

	let { run, pieces, activeWordIndex }: Props = $props();
	let wrappers = $derived([
		...(run.href ? (['link'] as const) : []),
		...((run.marks ?? []) as Array<InlineMark | 'link'>)
	]);
	let content = $derived(pieces ?? [{ text: run.text }]);
</script>

{#snippet wrapped(index: number)}
	{#if index >= wrappers.length}
		{#each content as piece, pieceIndex (pieceIndex)}
			{#if piece.wordIndex !== undefined}
				<span
					class="spoken-word"
					class:active-word={activeWordIndex === piece.wordIndex}
					data-word-index={piece.wordIndex}
				>
					{piece.text}
				</span>
			{:else}
				{piece.text}
			{/if}
		{/each}
	{:else if wrappers[index] === 'link'}
		<svelte:element
			this={"a"}
			href={run.href}
			title={run.title}
			target={run.href?.startsWith('#') ? undefined : '_blank'}
			rel={run.href?.startsWith('#') ? undefined : 'noreferrer'}
		>
			{@render wrapped(index + 1)}
		</svelte:element>
	{:else if wrappers[index] === 'strong'}
		<strong>{@render wrapped(index + 1)}</strong>
	{:else if wrappers[index] === 'emphasis'}
		<em>{@render wrapped(index + 1)}</em>
	{:else if wrappers[index] === 'delete'}
		<del>{@render wrapped(index + 1)}</del>
	{:else if wrappers[index] === 'sub'}
		<sub>{@render wrapped(index + 1)}</sub>
	{:else if wrappers[index] === 'sup'}
		<sup>{@render wrapped(index + 1)}</sup>
	{:else if wrappers[index] === 'mark'}
		<mark>{@render wrapped(index + 1)}</mark>
	{:else if wrappers[index] === 'kbd'}
		<kbd>{@render wrapped(index + 1)}</kbd>
	{:else if wrappers[index] === 'abbr'}
		<abbr title={run.title}>{@render wrapped(index + 1)}</abbr>
	{:else}
		<code>{@render wrapped(index + 1)}</code>
	{/if}
{/snippet}

{#if run.image}
	{#if run.image.src}
		{#if run.href}
			<svelte:element
				this={"a"}
				class="document-image-link"
				href={run.href}
				target={run.href.startsWith('#') ? undefined : '_blank'}
				rel={run.href.startsWith('#') ? undefined : 'noreferrer'}
			>
				<img
					src={run.image.src}
					alt={run.image.alt}
					title={run.image.title}
					loading="lazy"
					referrerpolicy="no-referrer"
				/>
			</svelte:element>
		{:else}
			<img
				src={run.image.src}
				alt={run.image.alt}
				title={run.image.title}
				loading="lazy"
				referrerpolicy="no-referrer"
			/>
		{/if}
	{:else}
		<span class="missing-image" role="img" aria-label={run.image.alt || 'Image unavailable'}>
			{run.image.alt || 'Image unavailable'}
		</span>
	{/if}
{:else if run.progress}
	<progress value={run.progress.value} max={run.progress.max}>
		{Math.round((run.progress.value / run.progress.max) * 100)}%
	</progress>
{:else if run.math}
	<MathFormula formula={content.map((piece) => piece.text).join('')} />
{:else}
	{@render wrapped(0)}
{/if}

<style>
	.spoken-word {
		border-radius: 0.28em;
	}

	.active-word {
		box-decoration-break: clone;
		background: var(--active-word-bg, rgba(112, 176, 143, 0.34));
		box-shadow: 0 0 0 0.12em var(--active-word-bg, rgba(112, 176, 143, 0.34));
		color: var(--active-word-ink, var(--reader-ink-strong, #f7f4ed));
		-webkit-box-decoration-break: clone;
	}

	a {
		color: var(--reader-link, #9fcdb5);
		text-decoration-color: color-mix(in srgb, currentColor 48%, transparent);
		text-decoration-thickness: 0.08em;
		text-underline-offset: 0.16em;
	}

	a:hover {
		text-decoration-color: currentColor;
	}

	code {
		padding: 0.08em 0.26em;
		border-radius: 0.24em;
		background: var(--reader-code-soft, rgba(255, 255, 255, 0.065));
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.82em;
	}

	mark {
		padding: 0.04em 0.18em;
		border-radius: 0.18em;
		background: color-mix(in srgb, var(--bookmark) 28%, transparent);
		color: inherit;
	}

	kbd {
		padding: 0.08em 0.36em;
		border: 1px solid var(--reader-rule);
		border-bottom-width: 2px;
		border-radius: 0.28em;
		background: var(--reader-code-soft);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.76em;
	}

	img {
		display: block;
		width: auto;
		max-width: 100%;
		height: auto;
		margin: 1.5em auto;
		border-radius: 5px;
	}

	.document-image-link {
		display: block;
	}

	.missing-image {
		display: inline-flex;
		min-height: 3rem;
		align-items: center;
		padding: 0.65rem 0.8rem;
		border: 1px dashed var(--reader-rule);
		border-radius: 4px;
		color: var(--reader-quiet);
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.76em;
	}

	progress {
		width: min(18rem, 100%);
		height: 0.55rem;
		accent-color: var(--primary);
		vertical-align: middle;
	}
</style>
