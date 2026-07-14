<script lang="ts">
	import type { InlineMark, InlineRun } from '$lib/domain/types';

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
	{:else}
		<code>{@render wrapped(index + 1)}</code>
	{/if}
{/snippet}

{@render wrapped(0)}

<style>
	.spoken-word {
		border-radius: 0.28em;
	}

	.active-word {
		box-decoration-break: clone;
		background: var(--active-word-bg, rgba(168, 157, 246, 0.34));
		box-shadow: 0 0 0 0.12em var(--active-word-bg, rgba(168, 157, 246, 0.34));
		color: var(--active-word-ink, var(--reader-ink-strong, #f7f4ed));
		-webkit-box-decoration-break: clone;
	}

	a {
		color: var(--reader-link, #a89df6);
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
</style>
