<script lang="ts">
	import { AlertTriangle, Maximize2, Minimize2, Workflow } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import { renderMermaid } from '$lib/services/mermaid';

	interface Props {
		id: string;
		source: string;
	}

	let { id, source }: Props = $props();
	let fullSize = $state(false);
	const componentId = $props.id();
	const captionId = `${componentId}-caption`;

	function diagram(diagramSource: string): Attachment<HTMLDivElement> {
		return (target) => {
			const figure = target.closest<HTMLElement>('.mermaid-diagram');
			const statusMessage = figure?.querySelector<HTMLElement>('[data-diagram-status]');
			const errorDetail = figure?.querySelector<HTMLElement>('[data-diagram-error]');
			let active = true;
			let rendering = 0;

			const render = (themeRefresh = false) => {
				rendering += 1;
				const request = rendering;
				if (figure) figure.dataset.status = themeRefresh ? 'refreshing' : 'loading';
				if (statusMessage)
					statusMessage.textContent = themeRefresh ? 'Updating theme…' : 'Rendering…';
				target.setAttribute('aria-busy', 'true');
				if (!themeRefresh) target.replaceChildren();

				void renderMermaid(diagramSource, target)
					.then(() => {
						if (!active || request !== rendering) return;
						if (figure) figure.dataset.status = 'ready';
						if (statusMessage) statusMessage.textContent = 'Rendered';
						target.setAttribute('aria-busy', 'false');
					})
					.catch((error: unknown) => {
						if (!active || request !== rendering) return;
						if (figure) figure.dataset.status = 'error';
						if (statusMessage) statusMessage.textContent = '';
						if (errorDetail) {
							errorDetail.textContent =
								error instanceof Error
									? error.message.split('\n')[0]
									: 'The diagram could not be rendered.';
						}
						target.setAttribute('aria-busy', 'false');
						target.replaceChildren();
					});
			};

			render();
			const observer = new MutationObserver(() => render(true));
			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-theme']
			});

			return () => {
				observer.disconnect();
				active = false;
			};
		};
	}
</script>

<figure
	class="mermaid-diagram"
	class:full-size={fullSize}
	{id}
	aria-labelledby={captionId}
	data-status="loading"
>
	<figcaption id={captionId}>
		<span><Workflow size={15} aria-hidden="true" /> Diagram</span>
		<div class="diagram-actions">
			<small data-diagram-status aria-live="polite"></small>
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
		</div>
	</figcaption>

	<div class="diagram-output" {@attach diagram(source)}></div>

	<div class="diagram-error" role="alert">
		<AlertTriangle size={16} aria-hidden="true" />
		<div>
			<strong>Diagram unavailable</strong>
			<span data-diagram-error></span>
		</div>
	</div>

	<details>
		<summary>View diagram source</summary>
		<pre><code>{source}</code></pre>
	</details>
</figure>

<style>
	.mermaid-diagram {
		margin: 2.2em 0;
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
		font-family: 'Inter Variable', sans-serif;
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

	figcaption small {
		font-size: 0.9em;
		font-weight: 560;
		letter-spacing: 0.02em;
		text-transform: none;
	}

	.diagram-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.size-toggle {
		display: none;
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

	.mermaid-diagram:global([data-status='ready']) .size-toggle {
		display: inline-flex;
	}

	.mermaid-diagram:global([data-status='refreshing']) .size-toggle {
		display: inline-flex;
	}

	.diagram-output {
		max-width: 100%;
		overflow-x: auto;
		padding: 18px 6px 22px;
		overscroll-behavior-inline: contain;
		scrollbar-color: var(--reader-rule) transparent;
	}

	.mermaid-diagram:global([data-status='loading']) .diagram-output {
		min-height: 156px;
		background:
			linear-gradient(
					90deg,
					transparent,
					color-mix(in srgb, var(--primary) 6%, transparent),
					transparent
				)
				0 0 / 180% 100%,
			linear-gradient(var(--reader-rule), var(--reader-rule)) center 42% / 44% 1px no-repeat,
			linear-gradient(var(--reader-rule), var(--reader-rule)) center 58% / 31% 1px no-repeat;
		animation: diagram-loading 1.5s ease-in-out infinite;
	}

	.mermaid-diagram:global([data-status='error']) .diagram-output {
		display: none;
	}

	.mermaid-diagram:global([data-status='ready']) figcaption small,
	.mermaid-diagram:global([data-status='error']) figcaption small {
		visibility: hidden;
	}

	.diagram-output :global(.voicebook-mermaid-svg) {
		display: block;
		width: 100%;
		min-width: 0;
		height: auto;
		margin: 0 auto;
	}

	.mermaid-diagram.full-size .diagram-output :global(.voicebook-mermaid-svg) {
		width: auto;
		min-width: 100%;
	}

	.diagram-error {
		display: none;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: start;
		gap: 10px;
		padding: 16px 0 18px;
		color: var(--danger);
		font-size: 0.7em;
	}

	.mermaid-diagram:global([data-status='error']) .diagram-error {
		display: grid;
	}

	.diagram-error strong,
	.diagram-error span {
		display: block;
	}

	.diagram-error span {
		margin-top: 3px;
		color: var(--reader-quiet);
		font-weight: 440;
		line-height: 1.45;
	}

	details {
		border-top: 1px solid var(--reader-rule);
	}

	summary {
		width: fit-content;
		padding: 11px 0;
		color: var(--reader-quiet);
		cursor: pointer;
		font-size: 0.62em;
		font-weight: 620;
	}

	pre {
		overflow: auto;
		margin: 0 0 14px;
		padding: 15px 17px;
		border-radius: 5px;
		background: color-mix(in srgb, var(--reader) 94%, var(--text));
		color: var(--reader-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.64em;
		line-height: 1.55;
	}

	@keyframes diagram-loading {
		0%,
		100% {
			background-position:
				100% 0,
				center 42%,
				center 58%;
		}
		50% {
			background-position:
				-100% 0,
				center 42%,
				center 58%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mermaid-diagram:global([data-status='loading']) .diagram-output {
			animation: none;
		}
	}
</style>
