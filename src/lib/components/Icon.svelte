<script lang="ts">
	/**
	 * Renders a HugeIcons glyph declaratively from its icon data.
	 *
	 * The official `@hugeicons/svelte` component draws itself inside onMount,
	 * so its icons are absent from prerendered HTML and pop in after hydration.
	 * The data package is plain `[tag, attributes]` pairs, so the markup is
	 * rendered directly here instead: server-rendered, no runtime, and free to
	 * inherit `currentColor` like the icons it replaced.
	 */
	import type { SVGAttributes } from 'svelte/elements';
	import type { IconData } from '$lib/icons';

	interface Props extends SVGAttributes<SVGSVGElement> {
		icon: IconData;
		size?: number | string;
		/** Overrides the stroke weight baked into the icon data. */
		strokeWidth?: number | string;
	}

	let { icon, size = 24, strokeWidth, ...rest }: Props = $props();

	/** The icon data carries React-style attribute names; SVG needs the
	 * hyphenated forms, which `setAttribute` does not translate. */
	function svgAttributes(
		attributes: Readonly<Record<string, string | number>>
	): Record<string, string | number> {
		const mapped: Record<string, string | number> = {};
		for (const [name, value] of Object.entries(attributes)) {
			if (name === 'key') continue;
			mapped[name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] = value;
		}
		if (strokeWidth !== undefined && 'stroke' in attributes) mapped['stroke-width'] = strokeWidth;
		return mapped;
	}
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	color="currentColor"
	{...rest}
>
	{#each icon as [tag, attributes], index (index)}
		<svelte:element this={tag} {...svgAttributes(attributes)} />
	{/each}
</svg>
