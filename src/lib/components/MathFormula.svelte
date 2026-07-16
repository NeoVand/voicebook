<script lang="ts">
	import katex from 'katex';
	import 'katex/dist/katex.min.css';
	import type { Attachment } from 'svelte/attachments';
	import type { Snippet } from 'svelte';

	interface Props {
		formula: string;
		displayMode?: boolean;
		id?: string;
		/** Replaces the built-in source expander (the reader passes its
		 * construct panel with the spoken description and edit controls). */
		panel?: Snippet;
	}

	let { formula, displayMode = false, id, panel }: Props = $props();

	function equation(source: string, block: boolean): Attachment<HTMLElement> {
		return (target) => {
			try {
				katex.render(source, target, {
					displayMode: block,
					output: 'htmlAndMathml',
					strict: 'warn',
					throwOnError: true,
					trust: false
				});
				target.dataset.status = 'ready';
			} catch {
				target.textContent = source;
				target.dataset.status = 'error';
			}
		};
	}
</script>

{#if displayMode}
	<figure class="math-block" {id} aria-label="Mathematical equation">
		<div class="math-output" {@attach equation(formula, true)}></div>
		{#if panel}
			{@render panel()}
		{:else}
			<details>
				<summary>View equation source</summary>
				<pre><code>{formula}</code></pre>
			</details>
		{/if}
	</figure>
{:else}
	<span class="math-inline" aria-label={`Equation: ${formula}`} {@attach equation(formula, false)}
	></span>
{/if}

<style>
	.math-inline {
		display: inline-block;
		max-width: 100%;
		vertical-align: -0.08em;
	}

	.math-block {
		max-width: 100%;
		margin: 1.8em 0;
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
	}

	.math-output {
		overflow-x: auto;
		padding: 1.2em 0;
		color: var(--reader-ink-strong);
		scrollbar-color: var(--reader-scroll-thumb) transparent;
	}

	.math-output:global([data-status='error']) {
		color: var(--danger);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78em;
		white-space: pre-wrap;
	}

	details {
		border-top: 1px solid var(--reader-rule);
	}

	summary {
		width: fit-content;
		padding: 10px 0;
		color: var(--reader-quiet);
		cursor: pointer;
		font-family: var(--font-ui);
		font-size: 0.62em;
		font-weight: 620;
	}

	pre {
		overflow: auto;
		margin: 0 0 14px;
		padding: 14px 16px;
		border-radius: 5px;
		background: var(--reader-code-soft);
		color: var(--reader-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.68em;
		line-height: 1.55;
	}

	:global(.katex) {
		color: inherit;
	}
</style>
