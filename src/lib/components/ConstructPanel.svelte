<script lang="ts" module>
	import type { NarrationEntry } from '$lib/domain/types';

	export interface ConstructPanelItem {
		constructId: string;
		/** Row label in multi-item panels ("Row 1 — Alice"). */
		label?: string;
		/** The text actually spoken right now (narration or built-in fallback). */
		spoken: string;
		entry?: NarrationEntry;
		/** False for deterministic-only items (table header) — still editable. */
		canRegenerate?: boolean;
		regenerating?: boolean;
	}
</script>

<script lang="ts">
	import { Check, LoaderCircle, PencilLine, RefreshCw, X } from '@lucide/svelte';
	import hljs from 'highlight.js/lib/core';
	import latex from 'highlight.js/lib/languages/latex';
	import markdown from 'highlight.js/lib/languages/markdown';
	import type { Attachment } from 'svelte/attachments';

	hljs.registerLanguage('latex', latex);
	hljs.registerLanguage('markdown', markdown);

	interface Props {
		/** "Equation", "Diagram", "Table" — builds the summary line. */
		noun: string;
		/** Omit both to show only the spoken text (code blocks already display
		 * their source right above the panel). */
		sourceLabel?: string;
		source?: string;
		/** Colors the source block. */
		sourceLanguage?: 'latex' | 'mermaid' | 'markdown';
		items: ConstructPanelItem[];
		onEdit: (constructId: string, text: string) => void | Promise<void>;
		onRegenerate?: (constructId: string) => void | Promise<void>;
	}

	let { noun, sourceLabel, source, sourceLanguage, items, onEdit, onRegenerate }: Props = $props();

	function escapeHtml(value: string): string {
		return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	}

	/** highlight.js has no mermaid grammar; a few token classes cover the
	 * parts worth coloring. */
	function highlightMermaid(code: string): string {
		return escapeHtml(code)
			.replace(/^(%%.*)$/gm, '<span class="hljs-comment">$1</span>')
			.replace(
				/\b(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey|participant|actor|subgraph|end|loop|alt|else|opt|note|title|section)\b/g,
				'<span class="hljs-keyword">$1</span>'
			)
			.replace(
				/(--?&gt;&gt;?|==&gt;|\.-&gt;|--&gt;|&lt;--|---|--)/g,
				'<span class="hljs-string">$1</span>'
			)
			.replace(/(\|[^|\n]*\|)/g, '<span class="hljs-attribute">$1</span>');
	}

	function highlightedSource(code: string, language?: string): Attachment<HTMLElement> {
		return (target) => {
			if (language === 'mermaid') {
				target.innerHTML = highlightMermaid(code);
				return;
			}
			if (language && hljs.getLanguage(language)) {
				target.innerHTML = hljs.highlight(code, { language }).value;
				return;
			}
			target.textContent = code;
		};
	}

	let editingId = $state<string | null>(null);
	let draft = $state('');

	function beginEdit(item: ConstructPanelItem): void {
		editingId = item.constructId;
		draft = item.spoken;
	}

	function cancelEdit(): void {
		editingId = null;
		draft = '';
	}

	async function saveEdit(): Promise<void> {
		const id = editingId;
		const text = draft.trim();
		if (!id || !text) return;
		editingId = null;
		draft = '';
		await onEdit(id, text);
	}

	function statusFor(item: ConstructPanelItem): { label: string; kind: string } {
		if (item.regenerating || item.entry?.status === 'pending')
			return { label: 'Rewriting…', kind: 'busy' };
		if (item.entry?.origin === 'manual') return { label: 'Edited', kind: 'manual' };
		if (item.entry?.status === 'ready') return { label: 'Generated', kind: 'generated' };
		return { label: 'Built-in', kind: 'builtin' };
	}
</script>

<details class="construct-panel">
	<summary>{source === undefined ? 'Spoken text' : `${noun} source & spoken text`}</summary>
	<div class="construct-panel-body">
		{#if source !== undefined}
			<section class="panel-source" aria-label={sourceLabel}>
				<h4>{sourceLabel}</h4>
				<pre><code class="hljs" {@attach highlightedSource(source, sourceLanguage)}></code></pre>
			</section>
		{/if}
		<section class="panel-descriptions" aria-label="Spoken descriptions">
			<h4>{items.length === 1 ? 'Spoken as' : 'Spoken as, per row'}</h4>
			{#each items as item (item.constructId)}
				{@const status = statusFor(item)}
				{@const editing = editingId === item.constructId}
				<div class="panel-item" class:editing>
					<div class="panel-item-head">
						{#if item.label}<span class="panel-item-label">{item.label}</span>{/if}
						<span class={`panel-item-status ${status.kind}`} title={item.entry?.modelId}>
							{#if status.kind === 'busy'}<LoaderCircle class="spin" size={11} />{/if}
							{status.label}
						</span>
						<span class="panel-item-actions">
							{#if !editing}
								<button
									type="button"
									class="panel-action"
									title="Edit the spoken text"
									aria-label={`Edit the spoken text${item.label ? ` for ${item.label}` : ''}`}
									onclick={() => beginEdit(item)}
								>
									<PencilLine size={13} />
								</button>
								{#if onRegenerate && item.canRegenerate !== false}
									<button
										type="button"
										class="panel-action"
										title="Rewrite with the language model"
										aria-label={`Rewrite${item.label ? ` ${item.label}` : ''} with the language model`}
										disabled={Boolean(item.regenerating)}
										onclick={() => void onRegenerate(item.constructId)}
									>
										<RefreshCw size={13} />
									</button>
								{/if}
							{/if}
						</span>
					</div>
					{#if editing}
						<!-- svelte-ignore a11y_autofocus -->
						<textarea
							rows="3"
							autofocus
							spellcheck="true"
							aria-label="Spoken text"
							bind:value={draft}
							onkeydown={(event) => {
								if (event.key === 'Escape') cancelEdit();
								else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void saveEdit();
							}}></textarea>
						<div class="panel-edit-actions">
							<button
								type="button"
								class="panel-save"
								disabled={!draft.trim()}
								onclick={() => void saveEdit()}
							>
								<Check size={13} /> Save
							</button>
							<button type="button" class="panel-cancel" onclick={cancelEdit}>
								<X size={13} /> Cancel
							</button>
						</div>
					{:else}
						<p class="panel-item-text">{item.spoken}</p>
					{/if}
				</div>
			{/each}
		</section>
	</div>
</details>

<style>
	.construct-panel {
		border-top: 1px solid var(--reader-rule);
		font-family: var(--font-ui);
	}

	/* The disclosure arrow needs air from the host's border — panels sit
	 * flush inside code figures, equations, and diagram cards alike. */
	summary {
		width: fit-content;
		padding: 10px 4px;
		margin-left: 14px;
		color: var(--reader-quiet);
		cursor: pointer;
		font-size: 0.62em;
		font-weight: 620;
	}

	.construct-panel-body {
		display: grid;
		gap: 13px;
		padding: 0 14px 14px;
		margin: 0;
	}

	.panel-source h4,
	.panel-descriptions h4 {
		margin: 0 0 6px;
		color: var(--reader-quiet);
		font-size: 0.56em;
		font-weight: 680;
		letter-spacing: 0.07em;
		text-transform: uppercase;
	}

	pre {
		overflow-x: hidden;
		margin: 0;
		padding: 14px 16px;
		border-radius: 5px;
		background: var(--reader-code-soft, color-mix(in srgb, var(--reader) 94%, var(--text)));
		color: var(--reader-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.66em;
		line-height: 1.6;
	}

	pre code {
		display: block;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	pre :global(.hljs-comment) {
		color: var(--reader-quiet);
		font-style: italic;
	}

	pre :global(.hljs-keyword),
	pre :global(.hljs-built_in),
	pre :global(.hljs-name),
	pre :global(.hljs-section) {
		color: var(--code-keyword, var(--primary));
		font-weight: 620;
	}

	pre :global(.hljs-string),
	pre :global(.hljs-attribute),
	pre :global(.hljs-literal) {
		color: var(--code-string, var(--bookmark));
	}

	pre :global(.hljs-number),
	pre :global(.hljs-symbol),
	pre :global(.hljs-variable),
	pre :global(.hljs-params) {
		color: var(--code-number, var(--reader-link));
	}

	pre :global(.hljs-title),
	pre :global(.hljs-tag) {
		color: var(--reader-ink-strong);
	}

	.panel-item {
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--reader-rule) 82%, transparent);
		border-radius: 6px;
	}

	.panel-item + .panel-item {
		margin-top: 6px;
	}

	.panel-item-head {
		display: flex;
		min-height: 22px;
		align-items: center;
		gap: 8px;
	}

	.panel-item-label {
		overflow: hidden;
		max-width: 40%;
		color: var(--reader-ink-strong);
		font-size: 0.62em;
		font-weight: 650;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.panel-item-status {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border-radius: 999px;
		font-size: 0.54em;
		font-weight: 680;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.panel-item-status.generated {
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: color-mix(in srgb, var(--primary) 80%, var(--reader-ink));
	}

	.panel-item-status.manual {
		background: color-mix(in srgb, var(--bookmark, #c99a3c) 14%, transparent);
		color: color-mix(in srgb, var(--bookmark, #c99a3c) 82%, var(--reader-ink));
	}

	.panel-item-status.builtin {
		background: color-mix(in srgb, var(--reader-quiet) 12%, transparent);
		color: var(--reader-quiet);
	}

	.panel-item-status.busy {
		background: color-mix(in srgb, var(--primary) 8%, transparent);
		color: var(--primary);
	}

	.panel-item-status :global(.spin) {
		animation: panel-spin 800ms linear infinite;
	}

	@keyframes panel-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.panel-item-status :global(.spin) {
			animation: none;
		}
	}

	.panel-item-actions {
		display: inline-flex;
		margin-left: auto;
		gap: 2px;
	}

	.panel-action {
		display: grid;
		width: 26px;
		height: 26px;
		place-items: center;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--reader-quiet);
		cursor: pointer;
		transition:
			background 140ms var(--ease),
			color 140ms var(--ease);
	}

	.panel-action:hover:not(:disabled) {
		background: color-mix(in srgb, var(--reader-ink) 8%, transparent);
		color: var(--reader-ink-strong);
	}

	.panel-action:disabled {
		cursor: default;
		opacity: 0.4;
	}

	.panel-item-text {
		overflow-wrap: anywhere;
		margin: 5px 0 0;
		color: var(--reader-ink);
		font-family: var(--font-reading);
		font-size: 0.72em;
		line-height: 1.55;
	}

	textarea {
		width: 100%;
		margin-top: 7px;
		padding: 9px 11px;
		border: 1px solid color-mix(in srgb, var(--primary) 38%, var(--reader-rule));
		border-radius: 6px;
		background: var(--reader);
		color: var(--reader-ink);
		font-family: var(--font-reading);
		font-size: 0.72em;
		line-height: 1.5;
		resize: vertical;
	}

	textarea:focus-visible {
		border-color: var(--primary);
		outline: none;
	}

	.panel-edit-actions {
		display: flex;
		margin-top: 7px;
		gap: 6px;
	}

	.panel-save,
	.panel-cancel {
		display: inline-flex;
		min-height: 27px;
		align-items: center;
		gap: 5px;
		padding: 0 11px;
		border: 1px solid transparent;
		border-radius: 999px;
		cursor: pointer;
		font-size: 0.6em;
		font-weight: 660;
	}

	.panel-save {
		background: var(--primary);
		color: var(--primary-ink, #fff);
	}

	.panel-save:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.panel-cancel {
		border-color: var(--reader-rule);
		background: transparent;
		color: var(--reader-quiet);
	}

	.panel-cancel:hover {
		color: var(--reader-ink-strong);
	}
</style>
