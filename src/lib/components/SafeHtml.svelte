<script lang="ts">
	import type { SafeHtmlNode } from '$lib/domain/types';
	import SafeHtml from './SafeHtml.svelte';

	interface Props {
		nodes: SafeHtmlNode[];
	}

	let { nodes }: Props = $props();

	function attribute(node: Extract<SafeHtmlNode, { type: 'element' }>, name: string) {
		return node.attributes?.[name];
	}
</script>

{#each nodes as node, index (index)}
	{#if node.type === 'text'}
		{node.text}
	{:else if node.tag === 'p'}
		<p><SafeHtml nodes={node.children} /></p>
	{:else if node.tag === 'div'}
		<div class:html-callout={attribute(node, 'variant') === 'callout'}>
			<SafeHtml nodes={node.children} />
		</div>
	{:else if node.tag === 'span'}
		<span><SafeHtml nodes={node.children} /></span>
	{:else if node.tag === 'strong'}
		<strong><SafeHtml nodes={node.children} /></strong>
	{:else if node.tag === 'em'}
		<em><SafeHtml nodes={node.children} /></em>
	{:else if node.tag === 'del'}
		<del><SafeHtml nodes={node.children} /></del>
	{:else if node.tag === 'sub'}
		<sub><SafeHtml nodes={node.children} /></sub>
	{:else if node.tag === 'sup'}
		<sup><SafeHtml nodes={node.children} /></sup>
	{:else if node.tag === 'mark'}
		<mark><SafeHtml nodes={node.children} /></mark>
	{:else if node.tag === 'kbd'}
		<kbd><SafeHtml nodes={node.children} /></kbd>
	{:else if node.tag === 'abbr'}
		<abbr title={String(attribute(node, 'title') ?? '')}><SafeHtml nodes={node.children} /></abbr>
	{:else if node.tag === 'a'}
		<svelte:element
			this={"a"}
			href={String(attribute(node, 'href') ?? '#')}
			title={String(attribute(node, 'title') ?? '') || undefined}
			target={String(attribute(node, 'href') ?? '').startsWith('#') ? undefined : '_blank'}
			rel={String(attribute(node, 'href') ?? '').startsWith('#') ? undefined : 'noreferrer'}
		>
			<SafeHtml nodes={node.children} />
		</svelte:element>
	{:else if node.tag === 'img'}
		<img
			src={String(attribute(node, 'src') ?? '')}
			alt={String(attribute(node, 'alt') ?? '')}
			title={String(attribute(node, 'title') ?? '') || undefined}
			width={Number(attribute(node, 'width')) || undefined}
			height={Number(attribute(node, 'height')) || undefined}
			loading="lazy"
			referrerpolicy="no-referrer"
		/>
	{:else if node.tag === 'br'}
		<br />
	{:else if node.tag === 'table'}
		<div class="html-table-region" role="region" aria-label="Embedded document table">
			<table><SafeHtml nodes={node.children} /></table>
		</div>
	{:else if node.tag === 'thead'}
		<thead><SafeHtml nodes={node.children} /></thead>
	{:else if node.tag === 'tbody'}
		<tbody><SafeHtml nodes={node.children} /></tbody>
	{:else if node.tag === 'tr'}
		<tr><SafeHtml nodes={node.children} /></tr>
	{:else if node.tag === 'th'}
		<th
			colspan={Number(attribute(node, 'colspan')) || undefined}
			rowspan={Number(attribute(node, 'rowspan')) || undefined}
		>
			<SafeHtml nodes={node.children} />
		</th>
	{:else if node.tag === 'td'}
		<td
			colspan={Number(attribute(node, 'colspan')) || undefined}
			rowspan={Number(attribute(node, 'rowspan')) || undefined}
		>
			<SafeHtml nodes={node.children} />
		</td>
	{:else if node.tag === 'progress'}
		<progress
			value={Number(attribute(node, 'value')) || 0}
			max={Number(attribute(node, 'max')) || 1}
		>
			{Math.round(
				((Number(attribute(node, 'value')) || 0) / (Number(attribute(node, 'max')) || 1)) * 100
			)}%
		</progress>
	{/if}
{/each}

<style>
	p,
	div {
		margin: 0 0 1.15em;
	}

	.html-callout {
		padding: 0.8em 1em 0.01em;
		border-left: 3px solid var(--primary);
		background: color-mix(in srgb, var(--primary) 7%, transparent);
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
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.76em;
	}

	a {
		color: var(--reader-link);
		text-underline-offset: 0.16em;
	}

	img {
		display: block;
		width: auto;
		max-width: 100%;
		height: auto;
		margin: 1.4em auto;
		border-radius: 5px;
	}

	.html-table-region {
		overflow-x: auto;
		margin: 1.5em 0;
		border-block: 1px solid var(--reader-rule);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-ui);
		font-size: 0.76em;
	}

	th,
	td {
		padding: 0.72rem 0.8rem;
		border-bottom: 1px solid var(--reader-rule);
		text-align: left;
	}

	progress {
		width: min(18rem, 100%);
		height: 0.55rem;
		accent-color: var(--primary);
		vertical-align: middle;
	}
</style>
