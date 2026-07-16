<script lang="ts">
	import { BrainCircuit, Check, RefreshCw, Settings2 } from '@lucide/svelte';
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';

	interface Props {
		working: boolean;
		paused: boolean;
		/** 0..1 completion of the current rewrite queue. */
		progress: number;
		/** Override copy while generateAll drives its own stage label. */
		stageLabel?: string;
		enabled: boolean;
		onToggleEnabled: (value: boolean) => void | Promise<void>;
		onRegenerate: () => void | Promise<void>;
	}

	let {
		working,
		paused,
		progress,
		stageLabel = '',
		enabled,
		onToggleEnabled,
		onRegenerate
	}: Props = $props();

	const uid = $props.id();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();

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

	const trackMenu: Attachment<HTMLDivElement> = (element) => {
		menu = element;
		return () => {
			if (menu === element) menu = undefined;
		};
	};

	function menuItems(): HTMLElement[] {
		return Array.from(
			menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []
		).filter((item) => !(item as HTMLButtonElement).disabled);
	}

	async function openMenu(): Promise<void> {
		open = true;
		await tick();
		menuItems()[0]?.focus();
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
			const items = menuItems();
			if (!items.length) return;
			if (event.key === 'Home') items[0]?.focus();
			else if (event.key === 'End') items.at(-1)?.focus();
			else {
				const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
				const direction = event.key === 'ArrowDown' ? 1 : -1;
				items[(current + direction + items.length) % items.length]?.focus();
			}
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) closeMenu();
	}

	async function toggleEnabled(): Promise<void> {
		await onToggleEnabled(!enabled);
	}

	async function regenerate(): Promise<void> {
		closeMenu();
		await onRegenerate();
		trigger?.focus();
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="llm-chip-root" {@attach trackRoot}>
	<button
		class="llm-chip"
		class:working
		class:paused
		class:disabled-state={!enabled}
		class:open
		type="button"
		aria-label={working
			? 'Language model is rewriting visuals for speech. Open description options.'
			: 'Language model description options'}
		aria-controls={`${uid}-menu`}
		aria-expanded={open}
		aria-haspopup="menu"
		title={working
			? 'Rewriting equations, tables, and diagrams for speech'
			: enabled
				? 'Spoken descriptions'
				: 'Spoken descriptions are off'}
		onclick={() => (open ? closeMenu() : void openMenu())}
		onkeydown={handleTriggerKeydown}
		{@attach trackTrigger}
	>
		<BrainCircuit size={14} strokeWidth={2.1} />
		{#if working}
			<span class="llm-chip-copy" aria-live="polite">
				{stageLabel || (paused ? 'Waiting for the voice engine' : 'Describing visuals')}
			</span>
			<i class="llm-chip-track" aria-hidden="true">
				<i style:width={`${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`}></i>
			</i>
		{/if}
	</button>

	{#if open}
		<div
			id={`${uid}-menu`}
			class="llm-menu"
			role="menu"
			aria-label="Spoken description options"
			tabindex="-1"
			onkeydown={handleMenuKeydown}
			transition:fly={{ y: 5, duration: 120 }}
			{@attach trackMenu}
		>
			<button
				class="menu-item"
				type="button"
				role="menuitemcheckbox"
				aria-checked={enabled}
				onclick={() => void toggleEnabled()}
			>
				<span class="menu-check" class:on={enabled} aria-hidden="true">
					{#if enabled}<Check size={12} strokeWidth={2.6} />{/if}
				</span>
				<span>
					<strong>Describe visuals</strong>
					<small>{enabled ? 'On — equations, tables, diagrams' : 'Off — built-in fallbacks'}</small>
				</span>
			</button>
			<button
				class="menu-item"
				type="button"
				role="menuitem"
				disabled={working || !enabled}
				onclick={() => void regenerate()}
			>
				<RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>
					<strong>Regenerate descriptions</strong>
					<small>{working ? 'Already rewriting…' : 'This document'}</small>
				</span>
			</button>
			<a
				class="menu-item"
				role="menuitem"
				href={resolve('/settings?section=llm')}
				onclick={() => closeMenu()}
			>
				<Settings2 size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>
					<strong>LLM settings</strong>
					<small>Models, engines, prompts</small>
				</span>
			</a>
		</div>
	{/if}
</div>

<style>
	.llm-chip-root {
		position: relative;
		display: inline-flex;
		min-width: 0;
	}

	.llm-chip {
		display: inline-flex;
		min-width: 0;
		height: 28px;
		align-items: center;
		gap: 7px;
		padding: 0 8px;
		border: 1px solid color-mix(in srgb, var(--primary) 22%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary-soft) 72%, transparent);
		color: var(--primary);
		cursor: pointer;
		font-size: 10px;
		font-weight: 620;
		letter-spacing: 0.01em;
		line-height: 1;
		white-space: nowrap;
		transition:
			background 150ms var(--ease),
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.llm-chip.working {
		padding: 0 11px;
	}

	.llm-chip:hover,
	.llm-chip.open {
		background: color-mix(in srgb, var(--primary-soft) 70%, var(--primary) 14%);
	}

	.llm-chip.paused,
	.llm-chip.disabled-state {
		border-color: var(--line-strong);
		background: var(--hover);
		color: var(--muted);
	}

	.llm-chip-copy {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.llm-chip-track {
		position: relative;
		display: block;
		overflow: hidden;
		width: 34px;
		height: 3px;
		flex: none;
		border-radius: 999px;
		background: color-mix(in srgb, var(--primary) 18%, transparent);
	}

	.llm-chip-track > i {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		border-radius: 999px;
		background: var(--primary);
		transition: width 300ms var(--ease);
	}

	.llm-chip.paused .llm-chip-track > i {
		background: var(--muted);
	}

	.llm-chip.working :global(svg) {
		flex: none;
		animation: llm-chip-pulse 2.2s ease-in-out infinite;
	}

	.llm-chip.paused :global(svg) {
		animation: none;
	}

	@keyframes llm-chip-pulse {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.llm-chip.working :global(svg) {
			animation: none;
		}
	}

	.llm-menu {
		position: absolute;
		bottom: calc(100% + 7px);
		left: 0;
		z-index: 65;
		display: grid;
		width: 208px;
		padding: 4px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: var(--surface-overlay);
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.48);
	}

	.menu-item {
		display: grid;
		width: 100%;
		min-height: 44px;
		grid-template-columns: 18px minmax(0, 1fr);
		align-items: center;
		gap: 7px;
		padding: 6px 9px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		text-align: left;
		text-decoration: none;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.menu-item:hover:not(:disabled),
	.menu-item:focus-visible:not(:disabled) {
		background: var(--hover);
		color: var(--text);
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

	.menu-check {
		display: grid;
		width: 15px;
		height: 15px;
		place-items: center;
		border: 1px solid var(--line-strong);
		border-radius: 4px;
		color: var(--primary-ink, #fff);
	}

	.menu-check.on {
		border-color: var(--primary);
		background: var(--primary);
	}
</style>
