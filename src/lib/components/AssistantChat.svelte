<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { ArrowUp, Globe, Mic, Volume2, VolumeX, X } from '$lib/icons';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';
	import type { NormalizedDocument } from '$lib/domain/types';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';
	import { realtimeAssistant } from '$lib/state/realtime-assistant.svelte';

	interface Props {
		book: NormalizedDocument;
	}

	let { book }: Props = $props();

	let draft = $state('');
	let list = $state<HTMLDivElement>();
	let composer = $state<HTMLTextAreaElement>();

	const trackList: Attachment<HTMLDivElement> = (element) => {
		list = element;
		return () => {
			if (list === element) list = undefined;
		};
	};

	const trackComposer: Attachment<HTMLTextAreaElement> = (element) => {
		composer = element;
		return () => {
			if (composer === element) composer = undefined;
		};
	};

	// Opening the panel means you intend to type — from the menu or from "/",
	// which bumps the token so an already-open panel still takes the caret.
	$effect(() => {
		void realtimeAssistant.chatFocusToken;
		const element = composer;
		if (element) requestAnimationFrame(() => element.focus());
	});

	// Keep the newest turn in view as messages stream in — and when the wait
	// indicator appears, which is the only thing on screen during a search.
	$effect(() => {
		void realtimeAssistant.messages.length;
		void realtimeAssistant.messages.at(-1)?.text;
		void realtimeAssistant.activity;
		const element = list;
		if (element) element.scrollTop = element.scrollHeight;
	});

	let busy = $derived(realtimeAssistant.status === 'connecting');

	async function send(): Promise<void> {
		const text = draft.trim();
		if (!text || busy) return;
		draft = '';
		await realtimeAssistant.sendTyped(book, text);
	}

	function handleComposerKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	function handlePanelKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			realtimeAssistant.chatOpen = false;
		}
	}

	/* ── Dragging ────────────────────────────────────────────────────────── */

	let panel = $state<HTMLDivElement>();
	let dragging = $state(false);
	let dragStart = { pointerX: 0, pointerY: 0, left: 0, top: 0 };

	const trackPanel: Attachment<HTMLDivElement> = (element) => {
		panel = element;
		return () => {
			if (panel === element) panel = undefined;
		};
	};

	/**
	 * Keep the whole panel on screen — the header is the only handle, so a
	 * header dragged past an edge would be unrecoverable.
	 *
	 * The panel is `position: fixed`, but the player bar's backdrop-filter
	 * makes IT the containing block, so left/top are measured from the bar's
	 * box rather than the viewport. Positions are stored in that space and
	 * only converted through the containing block's origin for this check —
	 * storing viewport coordinates teleports the panel by the bar's offset.
	 */
	function clamp(left: number, top: number): { left: number; top: number } {
		const element = panel;
		if (!element) return { left, top };
		const rect = element.getBoundingClientRect();
		const originX = rect.left - element.offsetLeft;
		const originY = rect.top - element.offsetTop;
		return {
			left: Math.max(8 - originX, Math.min(window.innerWidth - rect.width - 8 - originX, left)),
			top: Math.max(8 - originY, Math.min(window.innerHeight - rect.height - 8 - originY, top))
		};
	}

	function startDrag(event: PointerEvent): void {
		// The close button lives in the same bar and must stay clickable.
		if (event.target instanceof Element && event.target.closest('button')) return;
		const element = panel;
		if (!element) return;
		// Offsets, not client coordinates: the drag is a delta applied to where
		// the panel already sits, so a click that never moves changes nothing.
		dragStart = {
			pointerX: event.clientX,
			pointerY: event.clientY,
			left: element.offsetLeft,
			top: element.offsetTop
		};
		dragging = true;
		// Pointer capture keeps the drag alive past the panel's edges.
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		event.preventDefault();
	}

	function moveDrag(event: PointerEvent): void {
		if (!dragging) return;
		realtimeAssistant.chatPosition = clamp(
			dragStart.left + (event.clientX - dragStart.pointerX),
			dragStart.top + (event.clientY - dragStart.pointerY)
		);
	}

	function endDrag(event: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		if (event.currentTarget instanceof HTMLElement) {
			event.currentTarget.releasePointerCapture?.(event.pointerId);
		}
	}

	// A window that shrinks under a moved panel must not strand it off-screen.
	// Running once on open also pulls any out-of-range stored position back.
	$effect(() => {
		const settle = () => {
			const position = realtimeAssistant.chatPosition;
			if (position) realtimeAssistant.chatPosition = clamp(position.left, position.top);
		};
		requestAnimationFrame(settle);
		window.addEventListener('resize', settle);
		return () => window.removeEventListener('resize', settle);
	});
</script>

{#if realtimeAssistant.chatOpen}
	<div
		class="assistant-chat"
		class:dragging
		class:moved={Boolean(realtimeAssistant.chatPosition)}
		role="dialog"
		aria-label="Type to the assistant"
		tabindex="-1"
		style:left={realtimeAssistant.chatPosition
			? `${realtimeAssistant.chatPosition.left}px`
			: undefined}
		style:top={realtimeAssistant.chatPosition
			? `${realtimeAssistant.chatPosition.top}px`
			: undefined}
		transition:fly={{ y: 8, duration: 140 }}
		onkeydown={handlePanelKeydown}
		{@attach trackPanel}
	>
		<header
			role="presentation"
			title="Drag to move"
			onpointerdown={startDrag}
			onpointermove={moveDrag}
			onpointerup={endDrag}
			onpointercancel={endDrag}
		>
			<strong>Assistant</strong>
			<button
				class="chat-close"
				type="button"
				aria-label="Close chat"
				onclick={() => (realtimeAssistant.chatOpen = false)}
			>
				<Icon icon={X} size={14} />
			</button>
		</header>
		<div class="chat-messages" {@attach trackList}>
			{#if !realtimeAssistant.messages.length}
				<p class="chat-hint">
					Ask about this document by typing — same assistant, no speaking needed. It can highlight
					and scroll to what it mentions.
				</p>
			{/if}
			{#each realtimeAssistant.messages as message (message.id)}
				<div class="chat-message {message.role}" class:pending={message.pending}>
					{#if message.channel === 'voice'}
						<span class="chat-voice-mark" title="Spoken"
							><Icon icon={Mic} size={10} aria-hidden="true" /></span
						>
					{/if}
					<span class="chat-text">{message.text}</span>
				</div>
			{/each}
			{#if realtimeAssistant.activity}
				<div class="chat-activity" role="status">
					{#if realtimeAssistant.activity === 'searching'}
						<Icon icon={Globe} size={11} aria-hidden="true" />
						<span>Searching the web</span>
					{:else}
						<span class="sr-only">Thinking</span>
					{/if}
					<span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span>
				</div>
			{/if}
		</div>
		{#if realtimeAssistant.status === 'error' && realtimeAssistant.errorMessage}
			<p class="chat-error" role="alert">{realtimeAssistant.errorMessage}</p>
		{/if}
		<footer>
			<textarea
				rows="1"
				placeholder={busy ? 'Connecting…' : 'Ask about this document…'}
				aria-label="Message the assistant"
				disabled={busy}
				bind:value={draft}
				onkeydown={handleComposerKeydown}
				{@attach trackComposer}></textarea>
			<button
				class="chat-speak"
				class:on={readerChrome.spokenChatReplies}
				type="button"
				aria-pressed={readerChrome.spokenChatReplies}
				aria-label={readerChrome.spokenChatReplies
					? 'Replies are spoken aloud. Switch to text-only replies'
					: 'Replies are text only. Switch to spoken replies'}
				title={readerChrome.spokenChatReplies ? 'Answers out loud' : 'Answers in text only'}
				onclick={() => readerChrome.setSpokenChatReplies(!readerChrome.spokenChatReplies)}
			>
				<Icon icon={readerChrome.spokenChatReplies ? Volume2 : VolumeX} size={14} />
			</button>
			<button
				class="chat-send"
				type="button"
				aria-label="Send"
				disabled={busy || !draft.trim()}
				onclick={() => void send()}
			>
				<Icon icon={ArrowUp} size={14} strokeWidth={2.6} />
			</button>
		</footer>
	</div>
{/if}

<style>
	.assistant-chat {
		position: fixed;
		bottom: 74px;
		left: 14px;
		z-index: 60;
		display: grid;
		width: min(320px, calc(100vw - 28px));
		max-height: 46vh;
		grid-template-rows: auto minmax(0, 1fr) auto auto;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		background: var(--surface-overlay);
		box-shadow: 0 18px 52px rgba(0, 0, 0, 0.42);
	}

	/* Docked above the mic chip until dragged; .moved switches the anchor to
	   the top so the inline left/top can drive it. */
	.assistant-chat.moved {
		bottom: auto;
	}

	.assistant-chat.dragging {
		user-select: none;
	}

	.assistant-chat header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 10px 6px;
		border-bottom: 1px solid var(--line);
		cursor: grab;
		touch-action: none;
	}

	.assistant-chat.dragging header {
		cursor: grabbing;
	}

	.assistant-chat header strong {
		color: var(--faint);
		font-size: 8.5px;
		font-weight: 660;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.chat-close {
		display: grid;
		width: 20px;
		height: 20px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.chat-close:hover {
		background: var(--hover);
		color: var(--text);
	}

	.chat-messages {
		display: grid;
		overflow-y: auto;
		align-content: start;
		gap: 7px;
		padding: 10px;
		overscroll-behavior: contain;
	}

	.chat-hint {
		margin: 2px 0;
		color: var(--faint);
		font-size: 10px;
		line-height: 1.5;
	}

	.chat-message {
		display: flex;
		max-width: 92%;
		align-items: baseline;
		gap: 5px;
		font-size: 11px;
		line-height: 1.5;
	}

	.chat-message .chat-text {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.chat-message.user {
		justify-self: end;
		padding: 5px 9px;
		border-radius: 8px 8px 2px 8px;
		background: color-mix(in srgb, var(--primary) 12%, transparent);
		color: var(--text);
	}

	.chat-message.assistant {
		justify-self: start;
		color: var(--text-soft);
	}

	.chat-message.assistant.pending .chat-text::after {
		content: '▋';
		margin-left: 1px;
		animation: chat-caret 1s steps(2) infinite;
		color: var(--primary);
	}

	@keyframes chat-caret {
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.chat-message.assistant.pending .chat-text::after {
			animation: none;
		}
	}

	.chat-voice-mark {
		flex: 0 0 auto;
		color: var(--faint);
	}

	.chat-message.user .chat-voice-mark {
		color: color-mix(in srgb, var(--primary) 70%, var(--muted));
	}

	.chat-message.user:has(.chat-voice-mark) {
		background: transparent;
		color: var(--faint);
		font-style: italic;
	}

	.chat-error {
		margin: 0;
		padding: 6px 10px;
		border-top: 1px solid var(--line);
		color: var(--danger, #e5484d);
		font-size: 10px;
		line-height: 1.45;
	}

	/* The composer is a bare line of text on the panel: the footer rule is the
	   only frame, so nothing boxes the caret in — including on focus, where
	   the global form styles would otherwise paint a ring. */
	.assistant-chat footer {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		padding: 7px 8px 7px 11px;
		border-top: 1px solid var(--line);
	}

	.assistant-chat textarea {
		min-height: 26px;
		max-height: 92px;
		flex: 1;
		padding: 5px 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--text);
		field-sizing: content;
		font-size: 11px;
		line-height: 1.45;
		resize: none;
	}

	.assistant-chat textarea::placeholder {
		color: var(--faint);
	}

	.assistant-chat textarea:focus,
	.assistant-chat textarea:focus-visible {
		border: 0;
		outline: none;
		box-shadow: none;
	}

	/* Sits beside Send as a quiet sibling: same footprint, no fill, so the
	   send button stays the one bright thing in the composer. */
	.chat-speak {
		display: grid;
		width: 26px;
		height: 26px;
		flex: 0 0 auto;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--faint);
		cursor: pointer;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.chat-speak.on {
		color: var(--text);
	}

	.chat-speak:hover {
		background: color-mix(in srgb, var(--text) 9%, transparent);
		color: var(--text);
	}

	.chat-send {
		display: grid;
		width: 26px;
		height: 26px;
		flex: 0 0 auto;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: var(--primary);
		color: var(--primary-ink);
		cursor: pointer;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.chat-send:hover:not(:disabled) {
		background: var(--primary-hover);
	}

	.chat-send:disabled {
		background: color-mix(in srgb, var(--text) 11%, transparent);
		color: var(--faint);
		cursor: default;
	}

	/* Nothing streams during a tool call — these dots are the only proof the
	   assistant is still working. */
	.chat-activity {
		display: flex;
		align-items: center;
		justify-self: start;
		gap: 5px;
		color: var(--faint);
		font-size: 10px;
	}

	.chat-dots {
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	.chat-dots i {
		width: 4px;
		height: 4px;
		border-radius: 999px;
		animation: chat-dot 1.1s ease-in-out infinite;
		background: currentColor;
	}

	.chat-dots i:nth-child(2) {
		animation-delay: 0.18s;
	}

	.chat-dots i:nth-child(3) {
		animation-delay: 0.36s;
	}

	@keyframes chat-dot {
		0%,
		70%,
		100% {
			opacity: 0.25;
			transform: translateY(0);
		}
		35% {
			opacity: 1;
			transform: translateY(-2px);
		}
	}

	@keyframes chat-dot-fade {
		0%,
		100% {
			opacity: 0.3;
		}
		50% {
			opacity: 0.9;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.chat-dots i {
			animation: chat-dot-fade 1.4s ease-in-out infinite;
		}
	}
</style>
