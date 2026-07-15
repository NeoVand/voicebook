<script lang="ts">
	import { EllipsisVertical, LoaderCircle, Trash2 } from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';

	interface Props {
		canClear: boolean;
		clearing: boolean;
		onClear: () => void | Promise<void>;
	}

	let { canClear, clearing, onClear }: Props = $props();
	const uid = $props.id();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let clearItem = $state<HTMLButtonElement>();

	const trackRoot: Attachment<HTMLDivElement> = (element) => {
		root = element;
		return () => {
			if (root === element) root = undefined;
		};
	};

	const trackTrigger: Attachment<HTMLButtonElement> = (element) => {
		trigger = element;
		return () => {
			if (trigger === element) trigger = undefined;
		};
	};

	const trackClearItem: Attachment<HTMLButtonElement> = (element) => {
		clearItem = element;
		return () => {
			if (clearItem === element) clearItem = undefined;
		};
	};

	async function openMenu(): Promise<void> {
		open = true;
		await tick();
		clearItem?.focus();
	}

	function closeMenu(restoreFocus = false): void {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			void openMenu();
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			closeMenu(true);
		}
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeMenu(true);
		} else if (event.key === 'Tab') {
			closeMenu();
		} else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			event.preventDefault();
			clearItem?.focus();
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) closeMenu();
	}

	async function clearAudio(): Promise<void> {
		if (!canClear || clearing) return;
		closeMenu();
		await onClear();
		trigger?.focus();
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="player-actions" {@attach trackRoot}>
	<button
		class="actions-trigger"
		class:open
		type="button"
		aria-label="Document audio options"
		aria-controls={`${uid}-menu`}
		aria-expanded={open}
		aria-haspopup="menu"
		aria-busy={clearing}
		title="Document audio options"
		onclick={() => (open ? closeMenu() : void openMenu())}
		onkeydown={handleTriggerKeydown}
		{@attach trackTrigger}
	>
		{#if clearing}
			<span class="spinner"><LoaderCircle size={16} aria-hidden="true" /></span>
		{:else}
			<EllipsisVertical size={17} strokeWidth={1.8} aria-hidden="true" />
		{/if}
	</button>

	{#if open}
		<div
			id={`${uid}-menu`}
			class="actions-menu"
			role="menu"
			aria-label="Document audio options"
			tabindex="-1"
			onkeydown={handleMenuKeydown}
			transition:fly={{ y: 5, duration: 120 }}
		>
			<button
				class="menu-item danger"
				type="button"
				role="menuitem"
				disabled={!canClear || clearing}
				aria-busy={clearing}
				onclick={() => void clearAudio()}
				{@attach trackClearItem}
			>
				{#if clearing}
					<span class="spinner"><LoaderCircle size={15} aria-hidden="true" /></span>
				{:else}
					<Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
				{/if}
				<span>
					<strong>{clearing ? 'Clearing audio…' : 'Clear cached audio'}</strong>
					<small>This document</small>
				</span>
			</button>
		</div>
	{/if}
</div>

<style>
	.player-actions {
		position: relative;
		width: 36px;
		flex: 0 0 36px;
	}

	.actions-trigger {
		display: grid;
		width: 36px;
		height: 40px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.actions-trigger:hover,
	.actions-trigger.open {
		background: var(--hover);
		color: var(--text);
	}

	.actions-menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 7px);
		z-index: 65;
		display: grid;
		width: 194px;
		padding: 4px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: var(--surface-overlay);
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.48);
	}

	.menu-item {
		display: grid;
		width: 100%;
		min-height: 46px;
		grid-template-columns: 18px minmax(0, 1fr);
		align-items: center;
		gap: 7px;
		padding: 6px 9px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		text-align: left;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.menu-item:hover:not(:disabled),
	.menu-item:focus-visible:not(:disabled) {
		background: var(--danger-surface);
		color: var(--danger-text);
	}

	.menu-item:disabled {
		cursor: not-allowed;
		opacity: 0.42;
	}

	.menu-item span,
	.menu-item strong,
	.menu-item small {
		display: block;
		min-width: 0;
	}

	.menu-item strong {
		font-size: 10px;
		font-weight: 620;
		line-height: 1.25;
	}

	.menu-item small {
		margin-top: 2px;
		color: var(--faint);
		font-size: 8px;
		font-weight: 520;
		line-height: 1.2;
	}

	.spinner {
		display: grid;
		place-items: center;
		animation: spin 800ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
