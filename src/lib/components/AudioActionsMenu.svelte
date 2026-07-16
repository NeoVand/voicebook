<script lang="ts">
	import {
		AudioLines,
		Check,
		Download,
		LoaderCircle,
		RefreshCw,
		Square,
		Trash2
	} from '@lucide/svelte';
	import { tick } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';
	import { GENERATION_STEP_OPTIONS } from '$lib/domain/synthesis';
	import { appState } from '$lib/state/app-state.svelte';
	import { player } from '$lib/state/player.svelte';
	import { providersState } from '$lib/state/providers.svelte';

	const uid = $props.id();
	let open = $state(false);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let downloading = $state(false);
	let downloadProgress = $state(0);
	let clearing = $state(false);
	let announcement = $state('');

	let usesElevenLabs = $derived(providersState.speechEngine === 'elevenlabs');
	let speechReady = $derived(
		usesElevenLabs
			? providersState.elevenLabsReady
			: appState.installedModels.includes('supertonic-3')
	);
	let voices = $derived(
		usesElevenLabs
			? providersState.elevenLabsVoices.map((voice) => ({ id: voice.id, name: voice.name }))
			: appState.selectedModel.voices.map((voice) => ({ id: voice.id, name: voice.name }))
	);
	let currentVoiceId = $derived(
		usesElevenLabs ? providersState.elevenLabsVoiceId : appState.selectedVoiceId
	);
	let currentVoiceName = $derived(
		voices.find((voice) => voice.id === currentVoiceId)?.name ?? 'Voice'
	);
	let busy = $derived(downloading || clearing);

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

	function menuItems(): HTMLButtonElement[] {
		return Array.from(
			menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemradio"]') ?? []
		).filter((item) => !item.disabled);
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
				const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
				const direction = event.key === 'ArrowDown' ? 1 : -1;
				items[(current + direction + items.length) % items.length]?.focus();
			}
		}
	}

	function handleWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) closeMenu();
	}

	async function chooseVoice(id: string): Promise<void> {
		if (id === currentVoiceId) return;
		await player.chooseVoice(id);
	}

	async function chooseSteps(steps: number): Promise<void> {
		await player.chooseGenerationSteps(steps);
	}

	function prepare(): void {
		closeMenu();
		if (player.isGeneratingAll) player.cancelGeneration();
		else void player.generateAll();
	}

	async function download(): Promise<void> {
		if (!player.isDocumentPrepared || busy) return;
		closeMenu();
		downloading = true;
		downloadProgress = 0;
		announcement = 'Creating the document MP3.';
		try {
			const { blob, filename } = await player.exportDocumentMp3((progress) => {
				downloadProgress = progress * 100;
			});
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = filename;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1_000);
			announcement = 'The document MP3 is ready to download.';
		} catch (error) {
			announcement =
				error instanceof Error ? error.message : 'The document MP3 could not be created.';
		} finally {
			downloading = false;
		}
	}

	async function clearAudio(): Promise<void> {
		if (busy) return;
		closeMenu();
		clearing = true;
		const cleared = await player.clearDocumentAudio();
		announcement = cleared
			? 'Cached audio and listening history cleared for this document.'
			: 'Cached audio could not be cleared.';
		clearing = false;
	}

	async function regenerateAudio(): Promise<void> {
		if (busy || player.isGeneratingAll) return;
		closeMenu();
		clearing = true;
		const cleared = await player.clearDocumentAudio();
		clearing = false;
		if (!cleared) {
			announcement = 'Cached audio could not be cleared.';
			return;
		}
		announcement = 'Regenerating the whole document audio.';
		void player.generateAll();
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} />

<div class="audio-actions" {@attach trackRoot}>
	<button
		class="audio-trigger"
		class:active={player.isGeneratingAll}
		class:ready={player.isDocumentPrepared}
		class:open
		type="button"
		aria-label="Document audio options"
		aria-controls={`${uid}-menu`}
		aria-expanded={open}
		aria-haspopup="menu"
		aria-busy={player.isGeneratingAll || busy}
		title={player.isDocumentPrepared
			? 'Audio ready — voice, download, and cache options'
			: player.isGeneratingAll
				? `Preparing the document · ${Math.round(player.generationProgress)}%`
				: 'Voice and document audio options'}
		style:--generation-progress={`${Math.round(player.generationProgress)}%`}
		onclick={() => (open ? closeMenu() : void openMenu())}
		onkeydown={handleTriggerKeydown}
		{@attach trackTrigger}
	>
		{#if busy}
			<span class="spinner"><LoaderCircle size={16} aria-hidden="true" /></span>
		{:else if player.isDocumentPrepared}
			<Check size={17} strokeWidth={2.2} aria-hidden="true" />
		{:else}
			<AudioLines size={17} aria-hidden="true" />
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
			{@attach trackMenu}
		>
			<div class="menu-group" role="group" aria-label="Voice">
				<div class="menu-heading">
					<strong>Voice</strong>
					<small>{currentVoiceName} · {usesElevenLabs ? 'ElevenLabs' : 'On-device'}</small>
				</div>
				<div class="voice-options">
					{#each voices as voice (voice.id)}
						<button
							class="voice-option"
							class:selected={voice.id === currentVoiceId}
							type="button"
							role="menuitemradio"
							aria-checked={voice.id === currentVoiceId}
							onclick={() => void chooseVoice(voice.id)}
						>
							<span class="voice-option-check" aria-hidden="true">
								{#if voice.id === currentVoiceId}<Check size={12} strokeWidth={2.6} />{/if}
							</span>
							{voice.name}
						</button>
					{:else}
						<p class="voice-empty">Add an ElevenLabs key under Settings → Voice.</p>
					{/each}
				</div>
			</div>

			{#if !usesElevenLabs}
				<div class="menu-group" role="group" aria-label="Generation quality">
					<div class="menu-heading">
						<strong>Generation quality</strong>
						<small>{appState.generationSteps} steps</small>
					</div>
					<div class="quality-options">
						{#each GENERATION_STEP_OPTIONS as steps (steps)}
							<button
								class:selected={steps === appState.generationSteps}
								type="button"
								role="menuitemradio"
								aria-checked={steps === appState.generationSteps}
								onclick={() => void chooseSteps(steps)}
							>
								{steps}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<button
				class="menu-item"
				type="button"
				role="menuitem"
				aria-label={player.isDocumentPrepared
					? 'Whole document audio is ready'
					: player.isGeneratingAll
						? `Stop preparing whole document, ${Math.round(player.generationProgress)} percent complete`
						: 'Prepare whole document audio'}
				disabled={player.isDocumentPrepared || (!player.isGeneratingAll && !speechReady)}
				aria-busy={player.isGeneratingAll}
				onclick={prepare}
			>
				{#if player.isDocumentPrepared}
					<Check size={15} strokeWidth={2.2} aria-hidden="true" />
				{:else if player.isGeneratingAll}
					<Square size={13} fill="currentColor" aria-hidden="true" />
				{:else}
					<AudioLines size={15} strokeWidth={1.8} aria-hidden="true" />
				{/if}
				<span>
					<strong>
						{player.isDocumentPrepared
							? 'Audio ready'
							: player.isGeneratingAll
								? `Stop preparing · ${Math.round(player.generationProgress)}%`
								: 'Prepare document audio'}
					</strong>
					<small>{speechReady ? 'Whole document' : 'Set up a voice engine first'}</small>
				</span>
			</button>

			<button
				class="menu-item"
				type="button"
				role="menuitem"
				disabled={!player.isDocumentPrepared || busy}
				aria-busy={downloading}
				onclick={() => void download()}
			>
				{#if downloading}
					<span class="spinner"><LoaderCircle size={15} aria-hidden="true" /></span>
				{:else}
					<Download size={15} strokeWidth={1.8} aria-hidden="true" />
				{/if}
				<span>
					<strong>
						{downloading ? `Creating MP3 · ${Math.round(downloadProgress)}%` : 'Download MP3'}
					</strong>
					<small
						>{player.isDocumentPrepared ? 'Whole document' : 'Prepare the document first'}</small
					>
				</span>
			</button>

			<button
				class="menu-item"
				type="button"
				role="menuitem"
				disabled={!player.hasDocumentAudioState || player.isGeneratingAll || busy || !speechReady}
				onclick={() => void regenerateAudio()}
			>
				<RefreshCw size={15} strokeWidth={1.8} aria-hidden="true" />
				<span>
					<strong>Regenerate all audio</strong>
					<small>Clear, then prepare again</small>
				</span>
			</button>

			<button
				class="menu-item danger"
				type="button"
				role="menuitem"
				disabled={!player.hasDocumentAudioState || busy}
				aria-busy={clearing}
				onclick={() => void clearAudio()}
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
	<span class="sr-only" aria-live="polite">{announcement}</span>
</div>

<style>
	.audio-actions {
		position: relative;
		width: 36px;
		flex: 0 0 36px;
	}

	.audio-trigger {
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
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.audio-trigger:hover,
	.audio-trigger.open {
		background: var(--control-hover);
		color: var(--text);
	}

	.audio-trigger.active {
		background: var(--primary-soft);
		color: var(--primary);
	}

	.audio-trigger.ready {
		color: var(--timeline-cached);
	}

	.audio-trigger.active::before {
		position: absolute;
		inset: 2px;
		border-radius: 50%;
		background: conic-gradient(var(--primary) var(--generation-progress, 0%), var(--line-strong) 0);
		content: '';
		-webkit-mask: radial-gradient(circle, transparent 67%, black 69%);
		mask: radial-gradient(circle, transparent 67%, black 69%);
		pointer-events: none;
	}

	.actions-menu {
		position: absolute;
		bottom: calc(100% + 7px);
		left: 0;
		z-index: 65;
		display: grid;
		width: 226px;
		padding: 4px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: var(--surface-overlay);
		box-shadow: 0 14px 42px rgba(0, 0, 0, 0.48);
	}

	.menu-group {
		display: grid;
		gap: 6px;
		padding: 8px 8px 10px;
		border-bottom: 1px solid var(--line);
	}

	.menu-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
	}

	.menu-heading strong {
		font-size: 10px;
		font-weight: 640;
	}

	.menu-heading small {
		color: var(--faint);
		font-size: 8px;
	}

	.voice-options {
		display: grid;
		overflow-y: auto;
		max-height: 168px;
		gap: 1px;
		overscroll-behavior: contain;
	}

	.voice-option {
		display: flex;
		min-height: 30px;
		align-items: center;
		gap: 7px;
		padding: 0 7px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		font-size: 10px;
		font-weight: 560;
		text-align: left;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.voice-option:hover,
	.voice-option:focus-visible {
		background: var(--hover);
		color: var(--text);
	}

	.voice-option.selected {
		color: var(--text);
		font-weight: 650;
	}

	.voice-option-check {
		display: grid;
		width: 14px;
		height: 14px;
		flex: none;
		place-items: center;
		color: var(--primary);
	}

	.voice-empty {
		margin: 0;
		padding: 4px 7px;
		color: var(--faint);
		font-size: 9px;
	}

	.quality-options {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 3px;
	}

	.quality-options button {
		height: 30px;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: var(--control);
		color: var(--muted);
		font-size: 10px;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.quality-options button:hover {
		color: var(--text);
	}

	.quality-options button.selected {
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
		animation: audio-spin 800ms linear infinite;
	}

	@keyframes audio-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		clip-path: inset(50%);
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}

	@media (max-width: 560px) {
		.actions-menu {
			width: min(240px, calc(100vw - 24px));
			max-height: min(440px, calc(100dvh - 170px));
			overflow-y: auto;
		}
	}
</style>
