<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import {
		Cloud,
		CloudRain,
		Coffee,
		Flower2,
		Moon,
		Sparkles,
		Sprout,
		Sun,
		TreePine,
		Waves
	} from '$lib/icons';
	import type { ThemeId } from '$lib/state/appearance.svelte';

	let { theme, size = 16 }: { theme: ThemeId; size?: number } = $props();

	const ICONS = {
		sunny: Sun,
		cloudy: Cloud,
		meadow: Sprout,
		sakura: Flower2,
		rainy: CloudRain,
		midnight: Moon,
		forest: TreePine,
		cocoa: Coffee,
		ocean: Waves,
		aurora: Sparkles
	} as const;

	const glyph = $derived(ICONS[theme]);
</script>

<Icon icon={glyph} {size} />
