<script lang="ts">
	import { Volume1, Volume2, VolumeX } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';

	interface Props {
		volume: number;
		onChange: (volume: number) => void;
	}

	let { volume, onChange }: Props = $props();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	const trackRoot: Attachment<HTMLDivElement> = (element) => {
		root = element;
		return () => {
			if (root === element) root = undefined;
		};
	};

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) open = false;
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') open = false;
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div class="volume-control" {@attach trackRoot}>
	<button
		class="mobile-volume-trigger"
		class:open
		type="button"
		aria-label={`Volume ${Math.round(volume * 100)} percent`}
		aria-expanded={open}
		aria-controls="mobile-volume-popover"
		title="Volume"
		onclick={() => (open = !open)}
	>
		{#if volume === 0}
			<VolumeX size={16} aria-hidden="true" />
		{:else if volume < 0.55}
			<Volume1 size={16} aria-hidden="true" />
		{:else}
			<Volume2 size={16} aria-hidden="true" />
		{/if}
	</button>

	<label id="mobile-volume-popover" class="player-volume" class:open>
		<span class="sr-only">Volume</span>
		<Volume2 size={16} aria-hidden="true" />
		<input
			aria-label="Volume"
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={volume}
			style:--volume-progress={`${Math.round(volume * 100)}%`}
			oninput={(event) => onChange(Number((event.currentTarget as HTMLInputElement).value))}
		/>
	</label>
</div>

<style>
	.volume-control {
		position: relative;
		min-width: 0;
	}

	.mobile-volume-trigger {
		display: none;
	}

	.player-volume {
		display: flex;
		width: 106px;
		height: 40px;
		align-items: center;
		gap: 8px;
		padding: 0 4px;
		color: var(--muted);
	}

	.player-volume input {
		appearance: none;
		width: 100%;
		height: 20px;
		margin: 0;
		background: transparent;
	}

	.player-volume input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--primary) 0 var(--volume-progress, 0%),
			var(--track) var(--volume-progress, 0%) 100%
		);
	}

	.player-volume input::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--control-border);
	}

	.player-volume input::-moz-range-track {
		height: 4px;
		border: 0;
		border-radius: 999px;
		background: var(--track);
	}

	.player-volume input::-moz-range-progress {
		height: 4px;
		border-radius: 999px;
		background: var(--primary);
	}

	.player-volume input::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
	}

	@media (max-width: 560px) {
		.mobile-volume-trigger {
			display: grid;
			width: 40px;
			height: 40px;
			place-items: center;
			padding: 0;
			border: 0;
			border-radius: 5px;
			background: transparent;
			color: var(--muted);
		}

		.mobile-volume-trigger:hover,
		.mobile-volume-trigger.open {
			background: var(--hover);
			color: var(--text);
		}

		.player-volume {
			position: absolute;
			right: -2px;
			bottom: calc(100% + 8px);
			z-index: 70;
			display: none;
			width: 44px;
			height: 138px;
			justify-content: center;
			padding: 10px 0;
			border: 1px solid var(--line-strong);
			border-radius: 8px;
			background: var(--surface-overlay);
			box-shadow: 0 14px 42px rgba(0, 0, 0, 0.34);
		}

		.player-volume.open {
			display: flex;
		}

		.player-volume > :global(svg) {
			display: none;
		}

		.player-volume input {
			width: 22px;
			height: 116px;
			writing-mode: vertical-lr;
			direction: rtl;
		}

		.player-volume input::-webkit-slider-runnable-track {
			width: 4px;
			height: 100%;
			background: linear-gradient(
				to top,
				var(--primary) 0 var(--volume-progress, 0%),
				var(--track) var(--volume-progress, 0%) 100%
			);
		}

		.player-volume input::-webkit-slider-thumb {
			margin-top: 0;
			margin-left: -4px;
		}
	}
</style>
