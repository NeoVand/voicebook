import { DEFAULT_LISTENING_MODE, isListeningMode } from '$lib/domain/listening-modes';
import type { ListeningMode } from '$lib/domain/types';

/**
 * How a document is shown. 'reading' is the reflowed markdown — the only
 * option for anything that was never a page. 'page' draws the original PDF
 * and paints the spoken passage onto it, for readers who want the paper as
 * the authors set it.
 */
export type ReaderView = 'reading' | 'page';

export const READER_VIEWS: ReaderView[] = ['reading', 'page'];

/**
 * How bright the original pages are allowed to be. Paper is the page as
 * printed; dimmed takes the glare off white paper without touching what the
 * figures look like; night inverts it, so the paper is dark and the ink
 * light. Unset follows the theme — a dark theme should not open a document
 * by shining a white page at the reader.
 */
export type PageTone = 'paper' | 'dim' | 'night';

export const PAGE_TONES: PageTone[] = ['paper', 'dim', 'night'];

function isPageTone(value: unknown): value is PageTone {
	return PAGE_TONES.includes(value as PageTone);
}

function isReaderView(value: unknown): value is ReaderView {
	return READER_VIEWS.includes(value as ReaderView);
}

class ReaderChromeState {
	/** Contents starts closed — the document is the point. */
	outlineOpen = $state(false);
	menuOpen = $state(false);
	documentZoom = $state(1);
	/** The preferred view, remembered across documents. A document with no
	 * original pages falls back to reading without changing this. */
	readerView = $state<ReaderView>('reading');
	/** Undefined until the reader chooses: see `pageToneFor`. */
	pageTone = $state<PageTone>();
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
		const view = window.localStorage.getItem('voicebook:reader-view');
		if (isReaderView(view)) this.readerView = view;
		const tone = window.localStorage.getItem('voicebook:page-tone');
		if (isPageTone(tone)) this.pageTone = tone;
		this.assistantCaptions = window.localStorage.getItem('voicebook:assistant-captions') !== '0';
		this.spokenChatReplies = window.localStorage.getItem('voicebook:spoken-chat-replies') !== '0';
	}

	/** The tone in force, given whether the current theme is a dark one. */
	pageToneFor(darkTheme: boolean): PageTone {
		return this.pageTone ?? (darkTheme ? 'dim' : 'paper');
	}

	cyclePageTone(darkTheme: boolean): void {
		const current = this.pageToneFor(darkTheme);
		this.setPageTone(PAGE_TONES[(PAGE_TONES.indexOf(current) + 1) % PAGE_TONES.length]);
	}

	setPageTone(tone: PageTone): void {
		this.pageTone = tone;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:page-tone', tone);
		}
	}

	/** Steps to the next view. A cycle rather than a flip, so a third view can
	 * join without the control changing shape. */
	cycleReaderView(): void {
		const next = READER_VIEWS[(READER_VIEWS.indexOf(this.readerView) + 1) % READER_VIEWS.length];
		this.setReaderView(next);
	}

	setReaderView(view: ReaderView): void {
		this.readerView = view;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('voicebook:reader-view', view);
		}
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
