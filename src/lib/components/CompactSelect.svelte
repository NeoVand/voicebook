<script lang="ts">
	import { Check, ChevronDown } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';

	interface CompactSelectOption {
		value: string;
		label: string;
	}

	interface Props {
		label: string;
		value: string;
		options: readonly CompactSelectOption[];
		onChange: (value: string) => void | Promise<void>;
		triggerWidth?: string;
		menuWidth?: string;
		align?: 'start' | 'end';
	}

	let {
		label,
		value,
		options,
		onChange,
		triggerWidth = '112px',
		menuWidth = triggerWidth,
		align = 'start'
	}: Props = $props();

	const uid = $props.id();
	let open = $state(false);
	let activeIndex = $state(0);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let selectedIndex = $derived(
		Math.max(
			0,
			options.findIndex((option) => option.value === value)
		)
	);
	let selectedLabel = $derived(options.find((option) => option.value === value)?.label ?? value);
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

	function optionId(index: number): string {
		return `${uid}-option-${index}`;
	}

	function openMenu(): void {
		if (options.length === 0) return;
		activeIndex = selectedIndex;
		open = true;
	}

	function closeMenu(restoreFocus = false): void {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function selectOption(index: number): void {
		const option = options[index];
		if (!option) return;
		closeMenu(true);
		void onChange(option.value);
	}

	function moveActive(delta: number): void {
		if (options.length === 0) return;
		activeIndex = (activeIndex + delta + options.length) % options.length;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) openMenu();
			else moveActive(event.key === 'ArrowDown' ? 1 : -1);
			return;
		}

		if (event.key === 'Home' || event.key === 'End') {
			if (!open || options.length === 0) return;
			event.preventDefault();
			activeIndex = event.key === 'Home' ? 0 : options.length - 1;
			return;
		}

		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (open) selectOption(activeIndex);
			else openMenu();
			return;
		}

		if (event.key === 'Escape' && open) {
			event.preventDefault();
			closeMenu();
		} else if (event.key === 'Tab') {
			closeMenu();
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) closeMenu();
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div
	class="compact-select"
	class:align-end={align === 'end'}
	style:--trigger-width={triggerWidth}
	style:--menu-width={menuWidth}
	{@attach trackRoot}
>
	<button
		class="select-trigger"
		class:open
		type="button"
		role="combobox"
		aria-label={label}
		aria-controls={`${uid}-listbox`}
		aria-expanded={open}
		aria-haspopup="listbox"
		aria-activedescendant={open ? optionId(activeIndex) : undefined}
		onclick={() => (open ? closeMenu() : openMenu())}
		onkeydown={handleKeydown}
		{@attach trackTrigger}
	>
		<span>{selectedLabel}</span>
		<ChevronDown size={13} aria-hidden="true" />
	</button>

	{#if open}
		<div
			id={`${uid}-listbox`}
			class="select-menu"
			role="listbox"
			aria-label={label}
			transition:fly={{ y: 5, duration: 120 }}
		>
			{#each options as option, index (option.value)}
				<button
					id={optionId(index)}
					class="select-option"
					class:active={index === activeIndex}
					class:selected={option.value === value}
					type="button"
					role="option"
					aria-selected={option.value === value}
					tabindex="-1"
					onpointerenter={() => (activeIndex = index)}
					onclick={() => selectOption(index)}
				>
					<span class="option-check" aria-hidden="true">
						<Check size={13} strokeWidth={2.2} />
					</span>
					<span>{option.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.compact-select {
		position: relative;
		width: var(--trigger-width);
		min-width: 0;
	}

	.select-trigger {
		display: flex;
		width: 100%;
		height: 40px;
		min-width: 0;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 0 7px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 580;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.select-trigger:hover,
	.select-trigger.open {
		background: rgba(255, 255, 255, 0.045);
		color: var(--text);
	}

	.select-trigger span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.select-trigger :global(svg) {
		flex: 0 0 auto;
		color: var(--faint);
		transition: transform 150ms var(--ease);
	}

	.select-trigger.open :global(svg) {
		transform: rotate(180deg);
	}

	.select-menu {
		position: absolute;
		bottom: calc(100% + 7px);
		left: 0;
		z-index: 60;
		display: grid;
		width: var(--menu-width);
		gap: 1px;
		padding: 4px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: #111216;
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.48);
	}

	.align-end .select-menu {
		right: 0;
		left: auto;
	}

	.select-option {
		display: grid;
		width: 100%;
		height: 34px;
		grid-template-columns: 16px minmax(0, 1fr);
		align-items: center;
		gap: 5px;
		padding: 0 8px 0 5px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		font-weight: 540;
		text-align: left;
	}

	.select-option.active {
		background: rgba(255, 255, 255, 0.055);
		color: var(--text);
	}

	.select-option.selected {
		color: #e4e0ff;
	}

	.option-check {
		display: grid;
		visibility: hidden;
		place-items: center;
		color: var(--primary);
	}

	.select-option.selected .option-check {
		visibility: visible;
	}

	@media (prefers-reduced-motion: reduce) {
		.select-trigger :global(svg) {
			transition: none;
		}
	}
</style>
