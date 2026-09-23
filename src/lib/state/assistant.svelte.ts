/**
 * The voice assistant as the UI sees it: one object whatever engine runs the
 * conversation. Reads and commands go to the engine the reader chose; the
 * typed-chat panel's own state lives here, so it survives an engine switch.
 */
import type { PassageRange, ReaderFocus } from '$lib/domain/assistant-context';
import type { NormalizedDocument } from '$lib/domain/types';
import type { AssistantSession } from './assistant-session.svelte';
import { realtimeAssistant } from './realtime-assistant.svelte';

class Assistant {
	/** The typed-chat panel, for when speaking aloud is not an option. */
	chatOpen = $state(false);
	/** Bumped whenever something asks for the composer's caret — the panel
	 * watches it so the "/" shortcut lands the cursor even when it is already
	 * open. */
	chatFocusToken = $state(0);
	/** Where the reader dragged the panel, in viewport pixels. Null keeps it
	 * docked above the mic chip. Survives closing and reopening. */
	chatPosition = $state<{ left: number; top: number } | null>(null);

	private get engines(): AssistantSession[] {
		return [realtimeAssistant];
	}

	/** The engine running (or about to run) the conversation. */
	get session(): AssistantSession {
		return realtimeAssistant;
	}

	get status() {
		return this.session.status;
	}
	get mode() {
		return this.session.mode;
	}
	get listening() {
		return this.session.listening;
	}
	get caption() {
		return this.session.caption;
	}
	get speaking() {
		return this.session.speaking;
	}
	get errorMessage() {
		return this.session.errorMessage;
	}
	get tourProgress() {
		return this.session.tourProgress;
	}
	get messages() {
		return this.session.messages;
	}
	get activity() {
		return this.session.activity;
	}
	get active(): boolean {
		return this.session.active;
	}

	beginTalking(doc: NormalizedDocument): Promise<void> {
		return this.session.beginTalking(doc);
	}
	stopTalking(): void {
		this.session.stopTalking();
	}
	hush(): void {
		this.session.hush();
	}
	sendTyped(doc: NormalizedDocument, text: string): Promise<void> {
		return this.session.sendTyped(doc, text);
	}
	toggleHandsFree(doc: NormalizedDocument): void {
		this.session.toggleHandsFree(doc);
	}
	applyLiveSettings(): void {
		this.session.applyLiveSettings();
	}
	/** End the conversation — on any engine still running one. */
	stop(errorText?: string): void {
		for (const engine of this.engines) {
			if (engine === this.session) engine.stop(errorText);
			else if (engine.active) engine.stop();
		}
	}
	dismissError(): void {
		this.session.dismissError();
	}

	/** Open the typed panel and put the caret in it. Idempotent: firing this
	 * on an open panel just re-focuses rather than closing it — Escape is the
	 * way out. */
	openChat(): void {
		this.chatOpen = true;
		this.chatFocusToken += 1;
	}

	/* The reader page's callbacks reach every engine. */
	set onShowPassage(callback: ((range: PassageRange) => void) | undefined) {
		for (const engine of this.engines) engine.onShowPassage = callback;
	}
	set onClearHighlight(callback: (() => void) | undefined) {
		for (const engine of this.engines) engine.onClearHighlight = callback;
	}
	set onPlayPassage(callback: ((range: PassageRange) => void) | undefined) {
		for (const engine of this.engines) engine.onPlayPassage = callback;
	}
	set onGetReaderFocus(callback: (() => ReaderFocus) | undefined) {
		for (const engine of this.engines) engine.onGetReaderFocus = callback;
	}
	set onPointAt(callback: ((segment: number) => void) | undefined) {
		for (const engine of this.engines) engine.onPointAt = callback;
	}
	set onAddAnnotation(callback: ((range: PassageRange, note?: string) => boolean) | undefined) {
		for (const engine of this.engines) engine.onAddAnnotation = callback;
	}
}

export const assistant = new Assistant();
