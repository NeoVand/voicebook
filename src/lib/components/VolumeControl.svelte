<script lang="ts">
	import { Volume1, Volume2, VolumeX } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';

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
		class="volume-trigger"
		class:open
		type="button"
		aria-label={`Volume ${Math.round(volume * 100)} percent`}
		aria-expanded={open}
		aria-controls="volume-popover"
		title="Volume"
		onclick={() => (open = !open)}
	>
		{#if volume === 0}
			<VolumeX size={17} aria-hidden="true" />
		{:else if volume < 0.55}
			<Volume1 size={17} aria-hidden="true" />
		{:else}
			<Volume2 size={17} aria-hidden="true" />
		{/if}
	</button>

	{#if open}
		<label id="volume-popover" class="volume-popover" transition:fly={{ y: 5, duration: 120 }}>
			<span class="volume-readout" aria-hidden="true">{Math.round(volume * 100)}</span>
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
	{/if}
</div>

<style>
	.volume-control {
		position: relative;
		width: 36px;
		flex: 0 0 36px;
	}

	.volume-trigger {
		display: grid;
		width: 36px;
		height: 36px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.volume-trigger:hover,
	.volume-trigger.open {
		background: var(--control-hover);
		color: var(--text);
	}

	.volume-popover {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		z-index: 70;
		display: flex;
		width: 44px;
		height: 154px;
		align-items: center;
		flex-direction: column;
		gap: 6px;
		padding: 9px 0 10px;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		background: var(--surface-overlay);
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.42);
		transform: translateX(-50%);
	}

	.volume-readout {
		color: var(--faint);
		font-size: 8px;
		font-variant-numeric: tabular-nums;
		font-weight: 650;
	}

	.volume-popover input {
		appearance: none;
		width: 22px;
		height: 112px;
		margin: 0;
		background: transparent;
		direction: rtl;
		writing-mode: vertical-lr;
	}

	.volume-popover input::-webkit-slider-runnable-track {
		width: 4px;
		height: 100%;
		border-radius: 999px;
		background: linear-gradient(
			to top,
			var(--primary) 0 var(--volume-progress, 0%),
			var(--track) var(--volume-progress, 0%) 100%
		);
	}

	.volume-popover input::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		margin-left: -4px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--control-border);
	}

	.volume-popover input::-moz-range-track {
		width: 4px;
		height: 100%;
		border: 0;
		border-radius: 999px;
		background: var(--track);
	}

	.volume-popover input::-moz-range-progress {
		width: 4px;
		border-radius: 999px;
		background: var(--primary);
	}

	.volume-popover input::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
	}
</style>
