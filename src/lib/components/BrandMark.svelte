<script lang="ts">
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { AiBookIcon } from '@hugeicons/core-free-icons';

	let { active = false, size = 25 }: { active?: boolean; size?: number } = $props();
</script>

<span class="brand-logo" class:active aria-hidden="true">
	<HugeiconsIcon icon={AiBookIcon} {size} color="currentColor" strokeWidth={1.8} />
</span>

<style>
	.brand-logo {
		display: block;
		color: var(--brand-headphones, var(--primary));
		line-height: 0;
		transition: color 220ms var(--ease);
	}

	.brand-logo.active {
		animation: brand-breathe 780ms var(--ease) infinite alternate;
	}

	@keyframes brand-breathe {
		from {
			opacity: 0.55;
			transform: scale(0.94);
		}
		to {
			opacity: 1;
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.brand-logo {
			transition: none;
		}

		.brand-logo.active {
			animation: none;
		}
	}
</style>
