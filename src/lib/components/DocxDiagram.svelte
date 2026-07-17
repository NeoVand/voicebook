<script lang="ts">
	import type { DocumentDiagram } from '$lib/domain/types';

	interface Props {
		diagram: DocumentDiagram;
		alt: string;
	}

	let { diagram, alt }: Props = $props();
	const uid = $props.id();
	let padding = $derived(diagram.viewBox.width * 0.02);
	let box = $derived(
		`${diagram.viewBox.x - padding} ${diagram.viewBox.y - padding} ${diagram.viewBox.width + padding * 2} ${diagram.viewBox.height + padding * 2}`
	);
</script>

<!-- Authored box fills and strokes are kept; connectors, arrowheads, and
     floating labels take the reader theme's ink so the diagram belongs to
     the page in every palette. -->
<svg
	class="docx-diagram"
	viewBox={box}
	width={diagram.pixelWidth}
	height={diagram.pixelHeight}
	role="img"
	aria-label={alt}
>
	<defs>
		<marker
			id="arrow-{uid}"
			viewBox="0 0 10 10"
			refX="9"
			refY="5"
			markerWidth="7"
			markerHeight="7"
			orient="auto-start-reverse"
		>
			<path class="connector-head" d="M 0 0 L 10 5 L 0 10 z" />
		</marker>
	</defs>
	{#each diagram.boxes as shape, index (index)}
		{#if shape.fill !== 'none' || shape.stroke !== 'none'}
			{#if shape.shape === 'ellipse'}
				<ellipse
					cx={shape.x + shape.width / 2}
					cy={shape.y + shape.height / 2}
					rx={shape.width / 2}
					ry={shape.height / 2}
					fill={shape.fill}
					stroke={shape.stroke}
					stroke-width={shape.strokeWidth}
				/>
			{:else}
				<rect
					x={shape.x}
					y={shape.y}
					width={shape.width}
					height={shape.height}
					rx={shape.cornerRadius}
					fill={shape.fill}
					stroke={shape.stroke}
					stroke-width={shape.strokeWidth}
				/>
			{/if}
		{/if}
		{#if shape.lines.length}
			<text
				class:floating-label={shape.fill === 'none'}
				text-anchor="middle"
				dominant-baseline="middle"
				font-size={shape.fontSize}
				font-weight={shape.bold ? 600 : 400}
				fill={shape.fill === 'none' ? undefined : shape.fontColor}
			>
				{#each shape.lines as line, lineIndex (lineIndex)}
					<tspan
						x={shape.x + shape.width / 2}
						y={shape.y +
							shape.height / 2 +
							(lineIndex - (shape.lines.length - 1) / 2) * shape.fontSize * 1.25}
					>
						{line}
					</tspan>
				{/each}
			</text>
		{/if}
	{/each}
	{#each diagram.connectors as connector, index (index)}
		<line
			class="connector"
			x1={connector.x1}
			y1={connector.y1}
			x2={connector.x2}
			y2={connector.y2}
			stroke-width={connector.strokeWidth}
			marker-end={connector.arrow ? `url(#arrow-${uid})` : undefined}
		/>
	{/each}
</svg>

<style>
	.docx-diagram {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 1.5em auto;
	}

	text {
		font-family: var(--font-ui, system-ui, sans-serif);
	}

	.floating-label {
		fill: var(--reader-quiet, currentColor);
	}

	.connector {
		stroke: var(--reader-quiet, #6b7280);
	}

	.connector-head {
		fill: var(--reader-quiet, #6b7280);
	}
</style>
