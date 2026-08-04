import { DEFAULT_LISTENING_MODE, isListeningMode } from '$lib/domain/listening-modes';
import type { ListeningMode } from '$lib/domain/types';

class ReaderChromeState {
	/** Contents starts closed — the document is the point. */
	outlineOpen = $state(false);
	menuOpen = $state(false);
	documentZoom = $state(1);
	/** The listening mode new imports start in. Per-document overrides live on
	 * the document itself and take precedence in the reader. */
	defaultListeningMode = $state<ListeningMode>(DEFAULT_LISTENING_MODE);
	/** The voice assistant's commentary bubble; hideable from the bubble
	 * itself, restorable from the mic chip's menu. */
	assistantCaptions = $state(true);
	/** Typed questions get a spoken answer as well as the transcript. Off is
	 * the quiet way to use the chat: the reply arrives as text only. */
	spokenChatReplies = $state(true);

	get zoomPercent(): number {
		return Math.round(this.documentZoom * 100);
	}

	get documentCanvasWidth(): number {
		return Math.round(900 * this.documentZoom);
	}

	hydratePreferences(): void {
		if (typeof window === 'undefined') return;
		const stored = Number(window.localStorage.getItem('voicebook:document-zoom'));
		if (Number.isFinite(stored) && stored >= 0.8 && stored <= 1.6) this.documentZoom = stored;
		const mode = window.localStorage.getItem('voicebook:listening-mode');
		if (isListeningMode(mode)) this.defaultListeningMode = mode;
		this.assistantCaptions = window.localStorage.getItem('voicebook:assistant-captions') !== '0';
		this.spokenChatReplies = window.localStorage.getItem('voicebook:spoken-chat-replies') !== '0';
	}

	setAssistantCaptions(on: boolean): void {
		this.assistantCaptions = on;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:assistant-captions', on ? '1' : '0');
		}
	}

	setSpokenChatReplies(on: boolean): void {
		this.spokenChatReplies = on;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:spoken-chat-replies', on ? '1' : '0');
		}
	}

	setDefaultListeningMode(mode: ListeningMode): void {
		this.defaultListeningMode = mode;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:listening-mode', mode);
		}
	}

	setDocumentZoom(value: number): void {
		// 1% resolution — the zoom control is a near-continuous slider.
		this.documentZoom = Math.round(Math.min(1.6, Math.max(0.8, value)) * 100) / 100;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:document-zoom', String(this.documentZoom));
		}
	}

	resetZoom(): void {
		this.setDocumentZoom(1);
	}

	closeTransientPanels(): void {
		this.menuOpen = false;
	}
}

export const readerChrome = new ReaderChromeState();
