/**
 * What every voice-assistant engine shares: the state the UI reads (status,
 * captions, transcript), the reader-page callbacks, and the tools — running a
 * validated tool call against the open document, persisting marks and
 * memories, walkthrough bookkeeping, and the conversation footprint. Engines
 * (GPT-Live, GPT Realtime) add the transport and the protocol on top.
 */
import { SvelteSet } from 'svelte/reactivity';
import {
	describePassageLocation,
	parseAssistantToolCall,
	readPassageText,
	readSectionOutput,
	searchDocumentOutput,
	type AssistantInstructions,
	type PassageRange,
	type ReaderFocus,
	type TourStop
} from '$lib/domain/assistant-context';
import { MEMORY_TEXT_LIMIT } from '$lib/domain/study-tree';
import type { NormalizedDocument, StudyMemory } from '$lib/domain/types';
import { performWebResearch } from '$lib/services/web-research';
import { appState } from './app-state.svelte';
import { providersState } from './providers.svelte';

export type AssistantStatus = 'idle' | 'connecting' | 'live' | 'error';

/** How every walkthrough stop is narrated. Left alone, a model narrates the
 * whole tour at stop 1, re-highlights what is already highlighted, and asks
 * whether to go on — the app handles all of that. */
const TOUR_STOP_NOTE =
	"It is highlighted. Narrate this stop only, in a sentence or two. The app highlights each stop itself and moves on when you finish, so don't call show_passage, preview later stops, or ask whether to continue.";
export type AssistantMode = 'ptt' | 'handsFree';
export type AssistantActivity = '' | 'thinking' | 'searching';

/** One turn in the conversation transcript, spoken or typed. */
export interface AssistantChatMessage {
	id: string;
	role: 'user' | 'assistant';
	/** How the words traveled: 'voice' turns come from audio, 'text' turns
	 * from the typed chat. */
	channel: 'voice' | 'text';
	text: string;
	/** Still streaming in. */
	pending?: boolean;
}

export function microphoneErrorMessage(error: unknown): string {
	const name = error instanceof DOMException ? error.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return "Microphone access was blocked. Allow it in the browser's site settings.";
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') {
		return 'No microphone was found on this device.';
	}
	return 'The microphone could not be started.';
}

export abstract class AssistantSession {
	status = $state<AssistantStatus>('idle');
	mode = $state<AssistantMode>('ptt');
	/** The microphone is open: the chip is held, or hands-free is on. */
	listening = $state(false);
	/** Live transcript of what the assistant is currently saying. */
	caption = $state('');
	speaking = $state(false);
	errorMessage = $state('');
	/** Progress of a guided walkthrough, for the caption pill. */
	tourProgress = $state<{ stop: number; of: number }>();
	/** The running transcript: typed turns verbatim, voice turns as they are
	 * transcribed. Kept across reconnects; cleared when the document changes. */
	messages = $state<AssistantChatMessage[]>([]);
	/** What the assistant is doing between the reader's turn and its reply, so
	 * a silent wait never reads as a freeze. Cleared the moment words arrive. */
	activity = $state<AssistantActivity>('');

	/** Assigned by the reader page (and cleared on unmount). */
	onShowPassage?: (range: PassageRange) => void;
	onClearHighlight?: () => void;
	/** Start the app's narration voice over a passage (play_section). */
	onPlayPassage?: (range: PassageRange) => void;
	/** What the reader is pointing at (selection, hover, playhead). */
	onGetReaderFocus?: () => ReaderFocus;
	/** Strong per-segment emphasis inside the highlighted passage. */
	onPointAt?: (segment: number) => void;
	/** Persist a highlight (or, with note text, a margin note) over a passage.
	 * Returns false when the range could not be anchored. */
	onAddAnnotation?: (range: PassageRange, note?: string) => boolean;

	protected document?: NormalizedDocument;
	protected context?: AssistantInstructions;
	/** Blocks this session showed, read, or toured — flushed into the
	 * document's conversation footprint when the session ends. */
	private sessionBlocks = new SvelteSet<string>();
	private sessionLastBlockId?: string;
	private textItemId = '';
	private transcriptDocumentId = '';
	protected tour?: { stops: TourStop[]; index: number; paused: boolean };
	/** play_section range waiting for the assistant's own audio to drain —
	 * starting the narrator under the assistant's voice doubles the stage. */
	protected pendingPlayback?: PassageRange;

	get active(): boolean {
		return this.status === 'connecting' || this.status === 'live';
	}

	/** Press-and-hold: talk while held. Starts the session on first use. */
	abstract beginTalking(doc: NormalizedDocument): Promise<void>;
	/** Release: close the microphone and let the assistant answer. */
	abstract stopTalking(): void;
	/** Quiet the assistant without opening the microphone. */
	abstract hush(): void;
	/** Send a typed message into the conversation. */
	abstract sendTyped(doc: NormalizedDocument, text: string): Promise<void>;
	/** Double-tap or the menu row: lock or unlock hands-free listening. */
	abstract toggleHandsFree(doc: NormalizedDocument): void;
	/** Pick up a changed voice, model, or effort in a live session. */
	abstract applyLiveSettings(): void;
	/** End the session; with a message, surface it as the error state. */
	abstract stop(errorText?: string): void;
	/** Leave hands-free for hold-to-talk (play_section: the microphone must
	 * not hear the narrator). */
	protected abstract setHandsFree(on: boolean): void;
	/** Ask the model to narrate the next walkthrough stop (or wrap up). */
	protected abstract tourNudge(text: string): void;

	/** Clear a lingering error pill without starting a session. */
	dismissError(): void {
		if (this.status === 'error') {
			this.errorMessage = '';
			this.status = 'idle';
		}
	}

	/** A new document starts a new transcript. */
	protected adoptTranscript(doc: NormalizedDocument): void {
		if (this.transcriptDocumentId === doc.id) return;
		this.transcriptDocumentId = doc.id;
		this.messages = [];
	}

	/** Append streamed assistant output to the transcript, one message per
	 * response item, voice transcripts and typed replies alike. */
	protected streamAssistantText(itemId: string, delta: string, channel: 'voice' | 'text'): void {
		if (!delta) return;
		// Words are arriving: the wait is over, whatever it was for.
		this.activity = '';
		const last = this.messages.at(-1);
		if (last?.role === 'assistant' && last.pending && itemId === this.textItemId) {
			last.text += delta;
			return;
		}
		this.textItemId = itemId;
		this.messages.push({
			id: crypto.randomUUID(),
			role: 'assistant',
			channel,
			text: delta,
			pending: true
		});
	}

	protected settleTranscript(): void {
		for (const message of this.messages) {
			if (message.pending) message.pending = false;
		}
	}

	/** Shared teardown of everything above the transport. */
	protected resetSession(errorText: string): void {
		this.tour = undefined;
		this.tourProgress = undefined;
		this.pendingPlayback = undefined;
		this.flushConversationFootprint();
		this.document = undefined;
		this.context = undefined;
		this.textItemId = '';
		this.settleTranscript();
		this.activity = '';
		this.caption = '';
		this.speaking = false;
		this.listening = false;
		this.mode = 'ptt';
		this.onClearHighlight?.();
		this.errorMessage = errorText;
		this.status = errorText ? 'error' : 'idle';
	}

	/** Run a tool call against the open document. Slow tools (web research)
	 * return a promise; everything else answers at once. */
	protected runTool(
		name: string,
		argumentsJson: string
	): Record<string, unknown> | Promise<Record<string, unknown>> {
		const doc = this.document;
		if (!doc) return { error: 'No document is open.' };
		const { call, error } = parseAssistantToolCall(doc, name, argumentsJson);
		if (!call) return { error };
		if (call.name === 'clear_highlight') {
			this.onClearHighlight?.();
			return { ok: true };
		}
		if (call.name === 'read_section' || call.name === 'search_document') {
			// Resolve against the map the model was shown, so its S-numbers match.
			const map = this.context?.map;
			if (!map)
				return {
					error: 'This document is short enough that its full text is already in your context.'
				};
			return call.name === 'read_section'
				? readSectionOutput(doc, map, call.section, call.fromSegment)
				: searchDocumentOutput(doc, map, call.query);
		}
		if (call.name === 'read_passage') {
			const passage = readPassageText(doc, call.range);
			return passage.truncated ? { text: passage.text, truncated: true } : { text: passage.text };
		}
		if (call.name === 'plan_tour') {
			this.tour = { stops: call.stops, index: 0, paused: false };
			this.applyTourStop();
			return {
				ok: true,
				stop: 1,
				of: call.stops.length,
				point: call.stops[0].point,
				note: TOUR_STOP_NOTE
			};
		}
		if (call.name === 'continue_tour') {
			const tour = this.tour;
			if (!tour) return { error: 'No walkthrough is active.' };
			tour.paused = false;
			this.applyTourStop();
			const stop = tour.stops[tour.index];
			return { ok: true, stop: tour.index + 1, of: tour.stops.length, point: stop.point };
		}
		if (call.name === 'point_at') {
			this.touchRange({ startIndex: call.segment, endIndex: call.segment });
			this.onPointAt?.(call.segment);
			return { ok: true };
		}
		if (call.name === 'get_reader_focus') return this.readerFocusOutput(doc);
		if (call.name === 'web_research') {
			const engine = providersState.webResearchEngine;
			if (!engine) return { error: 'Web research needs an OpenAI key (Settings → LLM).' };
			return this.performWebResearchCall(doc, call.query, engine);
		}
		if (call.name === 'save_memory') {
			const now = Date.now();
			const blockId = call.segment === undefined ? undefined : doc.segments[call.segment]?.blockId;
			const memory: StudyMemory = {
				id: crypto.randomUUID(),
				text: call.text,
				...(blockId ? { blockId } : {}),
				origin: 'assistant',
				createdAt: now,
				updatedAt: now
			};
			doc.memories = [...(doc.memories ?? []), memory];
			void appState.saveDocument(doc).catch(() => undefined);
			return { ok: true, note: 'Saved — it will be waiting next session.' };
		}
		if (call.name === 'add_highlight' || call.name === 'add_note') {
			const note = call.name === 'add_note' ? call.text : undefined;
			const added = this.onAddAnnotation?.(call.range, note) ?? false;
			if (!added) return { error: 'That passage could not be annotated.' };
			const location = describePassageLocation(doc, call.range);
			return {
				ok: true,
				note: note ? 'The margin note is saved.' : 'The passage is highlighted for keeps.',
				...(location ? { under_heading: location } : {})
			};
		}
		if (call.name === 'play_section') {
			this.pauseTour();
			this.onClearHighlight?.();
			// Hands-free would hear the narrator; drop back to hold-to-talk.
			if (this.mode === 'handsFree') this.setHandsFree(false);
			// At tool time there is no telling whether spoken audio follows —
			// always queue, and start once the assistant's voice has drained.
			this.touchRange(call.range);
			this.pendingPlayback = call.range;
			return {
				ok: true,
				note: 'Playback starts when you finish speaking. Stay silent until the reader speaks to you.'
			};
		}
		this.touchRange(call.range);
		this.onShowPassage?.(call.range);
		const location = describePassageLocation(doc, call.range);
		return location ? { ok: true, under_heading: location } : { ok: true };
	}

	private readerFocusOutput(doc: NormalizedDocument): Record<string, unknown> {
		const focus = this.onGetReaderFocus?.();
		const output: Record<string, unknown> = {};
		if (focus?.selection) {
			output.selected_segments = {
				start: focus.selection.startIndex,
				end: focus.selection.endIndex,
				text: readPassageText(doc, focus.selection, 500).text
			};
		}
		if (focus?.hovered !== undefined) {
			output.hovered_segment = {
				index: focus.hovered,
				text: readPassageText(doc, { startIndex: focus.hovered, endIndex: focus.hovered }, 300).text
			};
		}
		if (focus?.playhead !== undefined) output.playhead_segment = focus.playhead;
		if (!Object.keys(output).length) {
			return { note: 'The reader is not pointing at anything right now.' };
		}
		return output;
	}

	/** Run a web search and persist the finding as a sourced web memory — the
	 * document keeps it even if the session ends before the answer lands. */
	private async performWebResearchCall(
		doc: NormalizedDocument,
		query: string,
		engine: { model: string; apiKey: string }
	): Promise<Record<string, unknown>> {
		this.activity = 'searching';
		try {
			const finding = await performWebResearch(engine.model, engine.apiKey, query);
			const now = Date.now();
			const memory: StudyMemory = {
				id: crypto.randomUUID(),
				text: finding.text.slice(0, MEMORY_TEXT_LIMIT),
				origin: 'web',
				...(finding.citations[0] ? { sourceUrl: finding.citations[0].url } : {}),
				createdAt: now,
				updatedAt: now
			};
			doc.memories = [...(doc.memories ?? []), memory];
			void appState.saveDocument(doc).catch(() => undefined);
			return {
				ok: true,
				finding: finding.text,
				sources: finding.citations.slice(0, 3).map((c) => `${c.title} — ${c.url}`),
				note: 'The finding is saved to the study notes.'
			};
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : 'The web search failed.'
			};
		} finally {
			// The reply that follows re-arms 'thinking'; leaving 'searching' up
			// would outlive the search on any path.
			if (this.activity === 'searching') this.activity = '';
		}
	}

	/** Record the blocks a range touches for the session footprint. */
	protected touchRange(range: PassageRange): void {
		const doc = this.document;
		if (!doc) return;
		for (let index = range.startIndex; index <= range.endIndex; index += 1) {
			const blockId = doc.segments[index]?.blockId;
			if (!blockId) continue;
			this.sessionBlocks.add(blockId);
			this.sessionLastBlockId = blockId;
		}
	}

	/** Merge this session's footprint into the document and persist it. Runs
	 * on stop, before the document reference is dropped. */
	protected flushConversationFootprint(): void {
		const doc = this.document;
		const touched = this.sessionBlocks;
		if (doc && touched.size) {
			const merged = [...(doc.conversation?.discussedBlockIds ?? [])];
			for (const blockId of touched) if (!merged.includes(blockId)) merged.push(blockId);
			doc.conversation = {
				// Soft cap: coverage is coarse by design; ancient entries age out.
				discussedBlockIds: merged.slice(-500),
				lastBlockId: this.sessionLastBlockId ?? doc.conversation?.lastBlockId,
				lastSessionAt: Date.now()
			};
			void appState.saveDocument(doc).catch(() => undefined);
		}
		this.sessionBlocks.clear();
		this.sessionLastBlockId = undefined;
	}

	/* ── Guided walkthroughs ─────────────────────────────────────────────── */

	protected pauseTour(): void {
		if (this.tour) this.tour.paused = true;
	}

	protected startPendingPlayback(): void {
		const range = this.pendingPlayback;
		if (!range) return;
		this.pendingPlayback = undefined;
		this.onPlayPassage?.(range);
	}

	protected applyTourStop(): void {
		const tour = this.tour;
		if (!tour) return;
		this.touchRange(tour.stops[tour.index].range);
		this.onShowPassage?.(tour.stops[tour.index].range);
		this.tourProgress = { stop: tour.index + 1, of: tour.stops.length };
	}

	/** The voice finished a stop: highlight the next and have it narrated, or
	 * wrap up after the last. */
	protected advanceTour(): void {
		const tour = this.tour;
		if (!tour || tour.paused) return;
		if (tour.index + 1 < tour.stops.length) {
			tour.index += 1;
			this.applyTourStop();
			const stop = tour.stops[tour.index];
			const point = stop.point.trim().replace(/[.!?]+$/, '');
			this.tourNudge(
				`Tour stop ${tour.index + 1} of ${tour.stops.length}${point ? `: ${point}` : ''}. ${TOUR_STOP_NOTE}`
			);
		} else {
			this.tour = undefined;
			this.tourProgress = undefined;
			this.tourNudge(
				'That was the last stop. Wrap up in one sentence and ask whether they want to dig into any of the stops.'
			);
		}
	}
}
