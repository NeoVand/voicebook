<script lang="ts">
	import { Mic, MicOff, PhoneOff } from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';
	import {
		REALTIME_EFFORTS,
		REALTIME_MODELS,
		REALTIME_VOICES,
		type RealtimeEffort
	} from '$lib/domain/provider-catalog';
	import type { NormalizedDocument } from '$lib/domain/types';
	import { providersState } from '$lib/state/providers.svelte';
	import { realtimeAssistant } from '$lib/state/realtime-assistant.svelte';

	interface Props {
		book: NormalizedDocument;
	}

	let { book }: Props = $props();

	const uid = $props.id();

	/** Press this long and it is a hold, not a tap. */
	const HOLD_MS = 250;
	/** Two taps inside this window make a double-tap. */
	const DOUBLE_MS = 300;

	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();

	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let tapTimer: ReturnType<typeof setTimeout> | undefined;
	let holding = false;
	let lastTapAt = 0;

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

	async function openMenu(): Promise<void> {
		open = true;
		await tick();
		menu?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
	}

	function closeMenu(restoreFocus = false): void {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function pressStart(): void {
		clearTimeout(holdTimer);
		holdTimer = setTimeout(() => {
			holding = true;
			closeMenu();
			void realtimeAssistant.beginTalking(book);
		}, HOLD_MS);
	}

	function pressEnd(): void {
		clearTimeout(holdTimer);
		if (holding) {
			holding = false;
			lastTapAt = 0;
			realtimeAssistant.stopTalking();
			return;
		}
		const now = performance.now();
		if (now - lastTapAt < DOUBLE_MS) {
			lastTapAt = 0;
			clearTimeout(tapTimer);
			closeMenu();
			realtimeAssistant.toggleHandsFree(book);
		} else {
			lastTapAt = now;
			clearTimeout(tapTimer);
			tapTimer = setTimeout(() => {
				if (lastTapAt) {
					lastTapAt = 0;
					if (open) closeMenu();
					else void openMenu();
				}
			}, DOUBLE_MS);
		}
	}

	function pressCancel(): void {
		clearTimeout(holdTimer);
		if (holding) {
			holding = false;
			realtimeAssistant.stopTalking();
		}
	}

	function handlePointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			// Capture is best-effort; an inactive pointer id must not kill the press.
		}
		pressStart();
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		if (event.repeat) return;
		if (event.key === ' ') {
			// Space is hold-to-talk on the keyboard: down opens, up sends.
			event.preventDefault();
			holding = true;
			closeMenu();
			void realtimeAssistant.beginTalking(book);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (open) closeMenu(true);
			else void openMenu();
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			closeMenu(true);
		}
	}

	function handleTriggerKeyup(event: KeyboardEvent): void {
		if (event.key === ' ') {
			event.preventDefault();
			if (holding) {
				holding = false;
				realtimeAssistant.stopTalking();
			}
		}
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			closeMenu(true);
		} else if (event.key === 'Tab') {
			closeMenu();
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) closeMenu();
	}

	function endConversation(): void {
		closeMenu(true);
		realtimeAssistant.stop();
	}

	let status = $derived(realtimeAssistant.status);
	let listening = $derived(realtimeAssistant.listening);
	let handsFree = $derived(realtimeAssistant.mode === 'handsFree' && realtimeAssistant.active);

	let label = $derived(
		status === 'connecting'
			? 'Connecting the voice assistant.'
			: status === 'live'
				? listening
					? handsFree
						? 'Hands-free listening. Open voice assistant options.'
						: 'Listening. Release to send.'
					: 'Voice assistant is on. Hold to talk, click for options.'
				: status === 'error'
					? 'Voice assistant failed. Hold to retry, click for options.'
					: 'Talk with this document. Hold to talk, click for options.'
	);
	let title = $derived(
		status === 'live'
			? listening
				? handsFree
					? 'Hands-free — click for options'
					: 'Listening — release to send'
				: 'Hold to talk · click for options'
			: status === 'connecting'
				? 'Connecting…'
				: 'Hold to talk · click for options'
	);
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="assistant-root" {@attach trackRoot}>
	<button
		class="assistant-trigger"
		class:connecting={status === 'connecting'}
		class:live={status === 'live'}
		class:listening={status === 'live' && listening}
		class:speaking={status === 'live' && realtimeAssistant.speaking && !listening}
		class:failed={status === 'error'}
		class:open
		type="button"
		data-tour="assistant"
		aria-label={label}
		aria-controls={`${uid}-menu`}
		aria-expanded={open}
		aria-haspopup="menu"
		aria-busy={status === 'connecting'}
		{title}
		onpointerdown={handlePointerDown}
		onpointerup={pressEnd}
		onpointercancel={pressCancel}
		onkeydown={handleTriggerKeydown}
		onkeyup={handleTriggerKeyup}
		oncontextmenu={(event) => event.preventDefault()}
		{@attach trackTrigger}
	>
		{#if status === 'error'}
			<MicOff size={16} strokeWidth={2} aria-hidden="true" />
		{:else}
			<Mic size={16} strokeWidth={2} aria-hidden="true" />
		{/if}
	</button>

	{#if open}
		<div
			id={`${uid}-menu`}
			class="assistant-menu"
			role="menu"
			aria-label="Voice assistant options"
			tabindex="-1"
			onkeydown={handleMenuKeydown}
			transition:fly={{ y: 5, duration: 120 }}
			{@attach trackMenu}
		>
			<p class="menu-hint">
				<strong>Hold the mic — or hold Space — and speak.</strong>
				Release to send. Double-tap the mic for hands-free.
			</p>

			<div class="menu-group" role="group" aria-label="Assistant voice">
				<div class="menu-heading">
					<strong>Voice</strong>
					{#if realtimeAssistant.active}
						<small>next conversation</small>
					{/if}
				</div>
				<div class="voice-options">
					{#each REALTIME_VOICES as voice (voice.id)}
						<button
							class:selected={voice.id === providersState.realtimeVoice}
							type="button"
							role="menuitemradio"
							aria-checked={voice.id === providersState.realtimeVoice}
							title={voice.tagline}
							onclick={() => void providersState.setRealtimeVoice(voice.id)}
						>
							{voice.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="menu-group" role="group" aria-label="Assistant model">
				<div class="menu-heading">
					<strong>Model</strong>
				</div>
				<div class="segmented-options">
					{#each REALTIME_MODELS as model (model.id)}
						<button
							class:selected={model.id === providersState.realtimeModelId}
							type="button"
							role="menuitemradio"
							aria-checked={model.id === providersState.realtimeModelId}
							title={model.tagline}
							onclick={() => void providersState.setRealtimeModel(model.id)}
						>
							{model.label.replace('GPT Realtime ', '')}
						</button>
					{/each}
				</div>
			</div>

			<div class="menu-group" role="group" aria-label="Thinking effort">
				<div class="menu-heading">
					<strong>Thinking</strong>
					<small>higher is smarter, slower</small>
				</div>
				<div class="segmented-options">
					{#each REALTIME_EFFORTS as effort (effort.id)}
						<button
							class:selected={effort.id === providersState.realtimeEffort}
							type="button"
							role="menuitemradio"
							aria-checked={effort.id === providersState.realtimeEffort}
							onclick={() => void providersState.setRealtimeEffort(effort.id as RealtimeEffort)}
						>
							{effort.label}
						</button>
					{/each}
				</div>
			</div>

			<button
				class="menu-item"
				type="button"
				role="menuitemcheckbox"
				aria-checked={handsFree}
				onclick={() => {
					closeMenu();
					realtimeAssistant.toggleHandsFree(book);
				}}
			>
				<Mic size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>
					<strong>Hands-free conversation</strong>
					<small>{handsFree ? 'On — it listens continuously' : 'Talk without holding'}</small>
				</span>
			</button>

			<button
				class="menu-item danger"
				type="button"
				role="menuitem"
				disabled={!realtimeAssistant.active}
				onclick={endConversation}
			>
				<PhoneOff size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>
					<strong>End conversation</strong>
					<small>{realtimeAssistant.active ? 'Hang up' : 'Not connected'}</small>
				</span>
			</button>
		</div>
	{/if}
</div>

<style>
	.assistant-root {
		position: relative;
		width: 36px;
		flex: 0 0 36px;
	}

	.assistant-trigger {
		position: relative;
		display: grid;
		width: 36px;
		height: 36px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		touch-action: none;
		-webkit-user-select: none;
		user-select: none;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.assistant-trigger:hover,
	.assistant-trigger.open {
		background: var(--control-hover);
		color: var(--text);
	}

	.assistant-trigger.connecting,
	.assistant-trigger.live {
		color: var(--primary);
	}

	/* The open microphone is the loudest state: a small filled disc. */
	.assistant-trigger.listening {
		color: var(--primary-ink, #fff);
	}

	.assistant-trigger.listening :global(svg) {
		position: relative;
		z-index: 1;
	}

	.assistant-trigger.failed {
		background: var(--danger-soft);
		color: var(--danger);
	}

	/* State ring, kept well inside the 36px hit target so it never crowds
	   the neighbouring transport controls. */
	.assistant-trigger.connecting::before,
	.assistant-trigger.live::before {
		position: absolute;
		inset: 4px;
		border-radius: 50%;
		content: '';
		pointer-events: none;
	}

	.assistant-trigger.connecting::before {
		background: conic-gradient(var(--primary) 22%, var(--line-strong) 0);
		-webkit-mask: radial-gradient(circle, transparent 72%, black 74%);
		mask: radial-gradient(circle, transparent 72%, black 74%);
		animation: assistant-spin 900ms linear infinite;
	}

	.assistant-trigger.live::before {
		background: var(--primary);
		-webkit-mask: radial-gradient(circle, transparent 72%, black 74%);
		mask: radial-gradient(circle, transparent 72%, black 74%);
		opacity: 0.55;
	}

	.assistant-trigger.listening::before {
		background: var(--primary);
		-webkit-mask: none;
		mask: none;
		opacity: 1;
	}

	.assistant-trigger.speaking :global(svg) {
		animation: assistant-pulse 1.4s ease-in-out infinite;
	}

	@keyframes assistant-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes assistant-pulse {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.assistant-trigger.connecting::before {
			animation: none;
		}

		.assistant-trigger.speaking :global(svg) {
			animation: none;
		}
	}

	.assistant-menu {
		position: absolute;
		bottom: calc(100% + 7px);
		left: 0;
		z-index: 65;
		display: grid;
		width: 236px;
		padding: 4px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: var(--surface-overlay);
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.48);
	}

	.menu-hint {
		margin: 0;
		padding: 7px 9px;
		border-bottom: 1px solid var(--line);
		color: var(--faint);
		font-size: 8px;
		font-weight: 520;
		line-height: 1.45;
	}

	.menu-hint strong {
		display: block;
		color: var(--muted);
		font-size: 9px;
		font-weight: 620;
	}

	.menu-group {
		padding: 6px 9px 7px;
		border-bottom: 1px solid var(--line);
	}

	.menu-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 5px;
	}

	.menu-heading strong {
		font-size: 9px;
		font-weight: 640;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.menu-heading small {
		color: var(--faint);
		font-size: 8px;
	}

	.voice-options {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 3px;
	}

	.segmented-options {
		display: flex;
		gap: 3px;
	}

	.segmented-options button {
		flex: 1;
	}

	.voice-options button,
	.segmented-options button {
		min-height: 24px;
		padding: 3px 6px;
		border: 1px solid var(--line-strong);
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		font-size: 9px;
		font-weight: 560;
		cursor: pointer;
		transition:
			background 150ms var(--ease),
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.voice-options button:hover,
	.segmented-options button:hover {
		background: var(--hover);
		color: var(--text);
	}

	.voice-options button.selected,
	.segmented-options button.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary);
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
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.menu-item:hover:not(:disabled),
	.menu-item:focus-visible:not(:disabled) {
		background: var(--hover);
		color: var(--text);
	}

	.menu-item.danger:hover:not(:disabled),
	.menu-item.danger:focus-visible:not(:disabled) {
		background: var(--danger-soft);
		color: var(--danger);
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
</style>
