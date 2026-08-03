<script lang="ts">
	import { Mic, SendHorizontal, X } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import { fly } from 'svelte/transition';
	import type { NormalizedDocument } from '$lib/domain/types';
	import { realtimeAssistant } from '$lib/state/realtime-assistant.svelte';

	interface Props {
		book: NormalizedDocument;
	}

	let { book }: Props = $props();

	let draft = $state('');
	let list = $state<HTMLDivElement>();

	const trackList: Attachment<HTMLDivElement> = (element) => {
		list = element;
		return () => {
			if (list === element) list = undefined;
		};
	};

	// Keep the newest turn in view as messages stream in.
	$effect(() => {
		void realtimeAssistant.messages.length;
		void realtimeAssistant.messages.at(-1)?.text;
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
</script>

{#if realtimeAssistant.chatOpen}
	<div
		class="assistant-chat"
		role="dialog"
		aria-label="Type to the assistant"
		tabindex="-1"
		transition:fly={{ y: 8, duration: 140 }}
		onkeydown={handlePanelKeydown}
	>
		<header>
			<strong>Assistant</strong>
			<button
				class="chat-close"
				type="button"
				aria-label="Close chat"
				onclick={() => (realtimeAssistant.chatOpen = false)}
			>
				<X size={14} />
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
						<span class="chat-voice-mark" title="Spoken"><Mic size={10} aria-hidden="true" /></span>
					{/if}
					<span class="chat-text">{message.text}</span>
				</div>
			{/each}
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
				onkeydown={handleComposerKeydown}></textarea>
			<button
				class="chat-send"
				type="button"
				aria-label="Send"
				disabled={busy || !draft.trim()}
				onclick={() => void send()}
			>
				<SendHorizontal size={14} />
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

	.assistant-chat header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 10px 6px;
		border-bottom: 1px solid var(--line);
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

	.assistant-chat footer {
		display: flex;
		align-items: flex-end;
		gap: 6px;
		padding: 8px;
		border-top: 1px solid var(--line);
	}

	.assistant-chat textarea {
		min-height: 30px;
		max-height: 92px;
		flex: 1;
		padding: 6px 8px;
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		background: transparent;
		color: var(--text);
		field-sizing: content;
		font-size: 11px;
		line-height: 1.4;
		resize: none;
	}

	.chat-send {
		display: grid;
		width: 30px;
		height: 30px;
		flex: 0 0 auto;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: var(--primary);
		color: var(--primary-ink);
		cursor: pointer;
		transition: opacity 150ms var(--ease);
	}

	.chat-send:disabled {
		cursor: default;
		opacity: 0.35;
	}
</style>
