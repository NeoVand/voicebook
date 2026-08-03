/**
 * Voice assistant session state: one realtime conversation about the open
 * document. Builds the marker-annotated context, holds the WebRTC session,
 * and turns the model's tool calls into highlight/scroll actions — which the
 * reader page provides via assigned callbacks, mirroring
 * player.onSegmentChange.
 *
 * Interaction model (Wispr-Flow-like): the microphone is closed by default.
 * Holding the chip — or Space, anywhere in the reader — opens it for one
 * question (manual turn commit — the model can never hear itself).
 * Double-tap locks hands-free listening with semantic VAD. A tap opens the
 * chip's options menu; ending happens there or on the caption pill.
 */
import { SvelteSet } from 'svelte/reactivity';
import {
	assistantTools,
	buildAssistantInstructions,
	describePassageLocation,
	parseAssistantToolCall,
	readPassageText,
	type AssistantInstructions,
	type PassageRange,
	type ReaderFocus,
	type TourStop
} from '$lib/domain/assistant-context';
import type { NormalizedDocument } from '$lib/domain/types';
import { playChime } from '$lib/services/assistant-chimes';
import {
	connectRealtime,
	mintRealtimeSecret,
	RealtimeError,
	type RealtimeChannel
} from '$lib/services/openai-realtime';
import { player } from './player.svelte';
import { providersState } from './providers.svelte';

export type AssistantStatus = 'idle' | 'connecting' | 'live' | 'error';
export type AssistantMode = 'ptt' | 'handsFree';

/** One turn in the conversation transcript, spoken or typed. */
export interface AssistantChatMessage {
	id: string;
	role: 'user' | 'assistant';
	/** How the words traveled: 'voice' turns come from audio (assistant voice
	 * transcripts; user turns as a spoken-question marker), 'text' turns from
	 * the typed chat. */
	channel: 'voice' | 'text';
	text: string;
	/** Still streaming in. */
	pending?: boolean;
}

interface FunctionCallItem {
	type?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
}

/** Local voice detection while the assistant speaks in hold-to-talk: the
 * WebRTC track stays muted, but an analysis-only clone watches for the
 * reader's voice so speaking over the assistant interrupts it. The RMS
 * threshold sits above echo-cancelled speaker bleed; sustained-speech and
 * trailing-silence windows are in 50 ms ticks. */
const VOICE_TICK_MS = 50;
const VOICE_RMS_THRESHOLD = 0.02;
const VOICE_START_TICKS = 5;
const VOICE_END_TICKS = 14;

function microphoneErrorMessage(error: unknown): string {
	const name = error instanceof DOMException ? error.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError') {
		return "Microphone access was blocked. Allow it in the browser's site settings.";
	}
	if (name === 'NotFoundError' || name === 'OverconstrainedError') {
		return 'No microphone was found on this device.';
	}
	return 'The microphone could not be started.';
}

export class RealtimeAssistantState {
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
	/** The typed-chat panel, for when speaking aloud is not an option. */
	chatOpen = $state(false);
	/** The running transcript: typed turns verbatim, voice turns as they are
	 * transcribed. Kept across reconnects; cleared when the document changes. */
	messages = $state<AssistantChatMessage[]>([]);

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

	private channel?: RealtimeChannel;
	private microphone?: MediaStream;
	private audio?: HTMLAudioElement;
	private abort?: AbortController;
	private document?: NormalizedDocument;
	private context?: AssistantInstructions;
	private seenCalls = new SvelteSet<string>();
	private captionItemId = '';
	private textItemId = '';
	private transcriptDocumentId = '';
	/** How the reader last addressed the assistant. Internally-issued
	 * responses (tool follow-ups, tour nudges) answer on the same channel, so
	 * a typed conversation stays silent end to end. */
	private turnChannel: 'voice' | 'text' = 'voice';
	private respondTimer: ReturnType<typeof setTimeout> | undefined;
	private settingsTimer: ReturnType<typeof setTimeout> | undefined;
	private holdActive = false;
	private tour?: { stops: TourStop[]; index: number; paused: boolean };
	/** A narrated tour stop finished generating; advance when audio drains. */
	private advanceAfterAudio = false;
	/** play_section range waiting for the assistant's own audio to drain —
	 * starting the narrator under the assistant's voice doubles the stage. */
	private pendingPlayback?: PassageRange;
	private analysisContext?: AudioContext;
	private analysisClone?: MediaStream;
	private analyser?: AnalyserNode;
	private analysisSamples?: Float32Array<ArrayBuffer>;
	private analysisTimer: ReturnType<typeof setInterval> | undefined;
	private voicedTicks = 0;
	private silentTicks = 0;
	/** The microphone opened itself because the reader spoke over the
	 * assistant; trailing silence sends the turn. */
	private autoListening = false;

	get active(): boolean {
		return this.status === 'connecting' || this.status === 'live';
	}

	/** Press-and-hold: talk while held. Starts the session on first use. */
	async beginTalking(doc: NormalizedDocument): Promise<void> {
		this.holdActive = true;
		if (this.status === 'idle' || this.status === 'error') {
			this.mode = 'ptt';
			await this.start(doc);
			return;
		}
		if (this.status === 'live') {
			if (!this.microphone) {
				// A typed-chat session has no ears — rebuild it with one. The
				// transcript stays; the conversation memory starts fresh.
				await this.restartWithMicrophone(doc);
				return;
			}
			this.openHeldMicrophone();
		}
	}

	private async restartWithMicrophone(doc: NormalizedDocument): Promise<void> {
		const mode = this.mode;
		this.stop();
		this.mode = mode;
		await this.start(doc, false);
	}

	/** Quiet the assistant without opening the microphone: cut the current
	 * answer and pause any tour — the session stays live in standby. */
	hush(): void {
		if (this.status !== 'live') return;
		this.pauseTour();
		this.pendingPlayback = undefined;
		this.channel?.send({ type: 'response.cancel' });
		this.channel?.send({ type: 'output_audio_buffer.clear' });
	}

	/** Release: close the microphone and ask for the answer. */
	stopTalking(): void {
		this.holdActive = false;
		if (this.status !== 'live' || this.mode !== 'ptt' || !this.listening) return;
		this.setMicrophoneOpen(false);
		playChime('release');
		this.channel?.send({ type: 'input_audio_buffer.commit' });
		this.channel?.send({ type: 'response.create' });
	}

	/**
	 * Send a typed message into the same conversation the voice uses — same
	 * session, same tools, same context. The reply comes back as text only
	 * (shown in the chat panel), so typing works where speaking cannot. A
	 * first typed message starts the session without a microphone and without
	 * the spoken greeting.
	 */
	async sendTyped(doc: NormalizedDocument, rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.status === 'connecting') return;
		if (!this.active) {
			this.mode = 'ptt';
			await this.start(doc, false, false);
			if (this.status !== 'live') return;
		}
		// Typing is a barge-in, like speaking over the assistant: cut the
		// current answer and pause any walkthrough.
		this.pauseTour();
		this.pendingPlayback = undefined;
		if (this.speaking) {
			this.channel?.send({ type: 'response.cancel' });
			this.channel?.send({ type: 'output_audio_buffer.clear' });
		}
		this.turnChannel = 'text';
		this.messages.push({ id: crypto.randomUUID(), role: 'user', channel: 'text', text });
		this.channel?.send({
			type: 'conversation.item.create',
			item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
		});
		this.createResponse();
	}

	/** response.create on the current turn's channel: typed turns ask for
	 * text-only output; spoken turns leave the session's voice default. */
	private createResponse(): void {
		this.channel?.send(
			this.turnChannel === 'text'
				? { type: 'response.create', response: { output_modalities: ['text'] } }
				: { type: 'response.create' }
		);
	}

	/** Double-tap or the menu row: lock or unlock hands-free listening. */
	toggleHandsFree(doc: NormalizedDocument): void {
		if (this.status === 'idle' || this.status === 'error') {
			this.mode = 'handsFree';
			void this.start(doc);
			return;
		}
		if (this.status === 'live') {
			if (!this.microphone) {
				this.mode = 'handsFree';
				void this.restartWithMicrophone(doc);
				return;
			}
			this.setHandsFree(this.mode !== 'handsFree');
		} else this.mode = 'handsFree';
	}

	/** Voice, model, and effort are fixed at mint time — a live session picks
	 * up a change through a quick silent reconnect (same document and mode,
	 * no replayed greeting). Debounced so flipping through voices restarts
	 * once. The conversation memory starts fresh; the settings do not. */
	applyLiveSettings(): void {
		if (!this.active) return;
		if (this.settingsTimer) clearTimeout(this.settingsTimer);
		this.settingsTimer = setTimeout(() => {
			this.settingsTimer = undefined;
			const doc = this.document;
			if (!this.active || !doc) return;
			const mode = this.mode;
			this.stop();
			this.mode = mode;
			void this.start(doc, false);
		}, 600);
	}

	private async start(
		doc: NormalizedDocument,
		greet = true,
		requireMicrophone = true
	): Promise<void> {
		if (this.active) return;
		this.errorMessage = '';
		this.status = 'connecting';
		if (this.transcriptDocumentId !== doc.id) {
			this.transcriptDocumentId = doc.id;
			this.messages = [];
		}
		const abort = new AbortController();
		this.abort = abort;
		try {
			await providersState.initialize();
			const apiKey = providersState.keyFor('openai');
			if (!apiKey) {
				throw new RealtimeError(
					'Add an OpenAI API key under Settings → LLM to talk with your documents.'
				);
			}
			let microphone: MediaStream | undefined;
			try {
				microphone = await navigator.mediaDevices.getUserMedia({
					audio: { echoCancellation: true, noiseSuppression: true }
				});
			} catch (error) {
				// A typed-chat session runs fine without ears; holding to talk
				// later surfaces the microphone problem where it matters.
				if (requireMicrophone) throw new RealtimeError(microphoneErrorMessage(error));
			}
			if (abort.signal.aborted) {
				for (const track of microphone?.getTracks() ?? []) track.stop();
				return;
			}
			this.microphone = microphone;
			// Closed until the reader holds the chip (or hands-free engages).
			this.setMicrophoneOpen(false);
			if (microphone) this.startVoiceDetector(microphone);

			// The assistant and the narration voice cannot share the stage —
			// the microphone would hear the narrator.
			if (player.isPlaying) player.pause();
			player.stopAside();

			this.document = doc;
			this.context = buildAssistantInstructions(doc);
			const model = providersState.realtimeModelId;
			const secret = await mintRealtimeSecret(
				apiKey,
				{
					model,
					voice: providersState.realtimeVoice,
					effort: providersState.realtimeEffort,
					instructions: this.context.instructions,
					tools: assistantTools(this.context.truncated)
				},
				abort.signal
			);

			const audio = document.createElement('audio');
			audio.autoplay = true;
			audio.setAttribute('playsinline', '');
			document.body.append(audio);
			this.audio = audio;

			this.channel = await connectRealtime({
				secret,
				model,
				microphone,
				audio,
				onEvent: (event) => this.handleEvent(event),
				onClosed: () => {
					if (this.active) this.stop('The voice session ended.');
				},
				signal: abort.signal
			});
			this.applyTurnDetection();
			// The greeting draws on the session instructions, which already
			// carry the document and the opening line to say. Settings-change
			// reconnects skip it — hearing "hello again" per voice switch grates.
			if (greet) this.channel.send({ type: 'response.create' });
			this.status = 'live';
			if (this.mode === 'handsFree') {
				this.setMicrophoneOpen(true);
				playChime('handsFreeOn');
			} else if (this.holdActive) {
				this.openHeldMicrophone();
			}
		} catch (error) {
			if (abort.signal.aborted) return;
			this.stop(
				error instanceof RealtimeError
					? error.message
					: 'The voice assistant could not start. Try again.'
			);
		}
	}

	/** End the session; with a message, surface it as the error state. */
	stop(errorText = ''): void {
		if (!this.active && !errorText && this.status === 'idle') return;
		this.abort?.abort();
		this.abort = undefined;
		if (this.respondTimer) clearTimeout(this.respondTimer);
		this.respondTimer = undefined;
		if (this.settingsTimer) clearTimeout(this.settingsTimer);
		this.settingsTimer = undefined;
		this.channel?.close();
		this.channel = undefined;
		for (const track of this.microphone?.getTracks() ?? []) track.stop();
		this.microphone = undefined;
		if (this.audio) {
			this.audio.srcObject = null;
			this.audio.remove();
			this.audio = undefined;
		}
		if (this.analysisTimer) clearInterval(this.analysisTimer);
		this.analysisTimer = undefined;
		for (const track of this.analysisClone?.getTracks() ?? []) track.stop();
		this.analysisClone = undefined;
		void this.analysisContext?.close().catch(() => {});
		this.analysisContext = undefined;
		this.analyser = undefined;
		this.analysisSamples = undefined;
		this.voicedTicks = 0;
		this.silentTicks = 0;
		this.autoListening = false;
		this.tour = undefined;
		this.tourProgress = undefined;
		this.advanceAfterAudio = false;
		this.pendingPlayback = undefined;
		this.document = undefined;
		this.context = undefined;
		this.seenCalls.clear();
		this.captionItemId = '';
		this.textItemId = '';
		this.turnChannel = 'voice';
		this.settleTranscript();
		this.caption = '';
		this.speaking = false;
		this.listening = false;
		this.holdActive = false;
		this.mode = 'ptt';
		this.onClearHighlight?.();
		this.errorMessage = errorText;
		this.status = errorText ? 'error' : 'idle';
	}

	/** Clear a lingering error pill without starting a session. */
	dismissError(): void {
		if (this.status === 'error') {
			this.errorMessage = '';
			this.status = 'idle';
		}
	}

	private openHeldMicrophone(): void {
		if (this.mode !== 'ptt' || this.status !== 'live') return;
		if (this.listening) {
			// The voice detector already opened the microphone; the hold
			// simply takes ownership of the turn.
			this.autoListening = false;
			return;
		}
		this.pauseTour();
		// The reader preempted a queued handoff to the narrator.
		this.pendingPlayback = undefined;
		// An open microphone must not hear the narration voice.
		if (player.isPlaying) player.pause();
		// Holding the chip is the barge-in: cut whatever is playing
		// (cancelling an idle response is a benign, filtered error), then
		// listen.
		this.channel?.send({ type: 'response.cancel' });
		this.channel?.send({ type: 'output_audio_buffer.clear' });
		this.channel?.send({ type: 'input_audio_buffer.clear' });
		this.setMicrophoneOpen(true);
		playChime('listen');
	}

	private setHandsFree(on: boolean): void {
		this.mode = on ? 'handsFree' : 'ptt';
		if (this.status !== 'live') return;
		if (on && player.isPlaying) player.pause();
		this.applyTurnDetection();
		this.setMicrophoneOpen(on);
		playChime(on ? 'handsFreeOn' : 'handsFreeOff');
	}

	/** Hands-free lets the server take turns (semantic VAD, barge-in
	 * explicitly on); hold-to-talk commits turns manually, so the model can
	 * never hear itself. */
	private applyTurnDetection(): void {
		this.channel?.send({
			type: 'session.update',
			session: {
				type: 'realtime',
				audio: {
					input: {
						turn_detection:
							this.mode === 'handsFree'
								? { type: 'semantic_vad', interrupt_response: true, create_response: true }
								: null
					}
				}
			}
		});
	}

	private setMicrophoneOpen(open: boolean): void {
		for (const track of this.microphone?.getTracks() ?? []) track.enabled = open;
		this.listening = open && Boolean(this.microphone);
	}

	/** Append streamed assistant output to the transcript, one message per
	 * response item, voice transcripts and typed replies alike. */
	private streamAssistantText(itemId: string, delta: string, channel: 'voice' | 'text'): void {
		if (!delta) return;
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

	private settleTranscript(): void {
		for (const message of this.messages) {
			if (message.pending) message.pending = false;
		}
	}

	private handleEvent(event: Record<string, unknown>): void {
		const type = event.type as string;
		switch (type) {
			case 'response.output_audio_transcript.delta': {
				const itemId = (event.item_id as string) ?? '';
				if (itemId !== this.captionItemId) {
					this.captionItemId = itemId;
					this.caption = '';
				}
				this.caption += (event.delta as string) ?? '';
				this.speaking = true;
				this.streamAssistantText(itemId, (event.delta as string) ?? '', 'voice');
				break;
			}
			case 'response.output_text.delta':
				this.streamAssistantText(
					(event.item_id as string) ?? '',
					(event.delta as string) ?? '',
					'text'
				);
				break;
			case 'input_audio_buffer.committed':
				this.turnChannel = 'voice';
				this.messages.push({
					id: crypto.randomUUID(),
					role: 'user',
					channel: 'voice',
					text: '(spoken question)'
				});
				break;
			case 'output_audio_buffer.started':
				this.speaking = true;
				break;
			case 'output_audio_buffer.stopped':
				this.speaking = false;
				// The walkthrough advances — and queued playback starts — when
				// the SPEAKER drains, not when generation ends: audio plays out
				// far behind response.done, and acting early puts the app a
				// step ahead of the voice.
				this.startPendingPlayback();
				if (this.advanceAfterAudio) {
					this.advanceAfterAudio = false;
					this.advanceTour();
				}
				break;
			case 'output_audio_buffer.cleared':
				this.speaking = false;
				this.advanceAfterAudio = false;
				this.pendingPlayback = undefined;
				// A cut-off answer stays truncated in the transcript — accurate.
				this.settleTranscript();
				break;
			case 'input_audio_buffer.speech_started':
				// Hands-free barge-in; the server cuts the response itself.
				this.speaking = false;
				this.pauseTour();
				break;
			case 'response.output_item.done':
				this.handleFunctionCall(event.item as FunctionCallItem);
				break;
			case 'response.done': {
				const output =
					((event.response as { output?: FunctionCallItem[] })?.output as FunctionCallItem[]) ?? [];
				for (const item of output) this.handleFunctionCall(item);
				// A pure narration finishing is what advances a walkthrough;
				// responses that called tools drive themselves via the
				// tool-output nudge instead. Generation finishes well before
				// the audio does, so the actual advance waits for the output
				// buffer to drain (`speaking` stays true until then).
				const spoke = output.some((item) => item?.type === 'message');
				const calledTool = output.some((item) => item?.type === 'function_call');
				if (spoke && !calledTool && this.tour && !this.tour.paused) {
					if (this.speaking) this.advanceAfterAudio = true;
					else this.advanceTour();
				}
				// A call-only response produces no audio events at all — start
				// the queued playback here instead of waiting for a drain that
				// will never come.
				if (!this.speaking) this.startPendingPlayback();
				this.settleTranscript();
				break;
			}
			case 'error': {
				const code = ((event.error as { code?: string })?.code ?? '') as string;
				// Cancelling nothing and committing an empty buffer are the
				// expected fallout of eager interruption — not worth noise.
				if (!/cancel|empty/.test(code)) {
					console.warn('[voice assistant] realtime error event', event.error ?? event);
				}
				break;
			}
		}
	}

	private handleFunctionCall(item: FunctionCallItem | undefined): void {
		if (!item || item.type !== 'function_call' || !this.document) return;
		const callId = item.call_id ?? '';
		if (!callId || this.seenCalls.has(callId)) return;
		this.seenCalls.add(callId);
		const output = this.runTool(item.name ?? '', item.arguments ?? '');
		this.channel?.send({
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }
		});
		// After play_section the narration voice has the stage — a follow-up
		// response would talk over it. The output alone closes the call.
		if (item.name === 'play_section') return;
		// One response even when a turn made several calls: nudge after the
		// last output instead of answering each one.
		if (this.respondTimer) clearTimeout(this.respondTimer);
		this.respondTimer = setTimeout(() => {
			this.respondTimer = undefined;
			this.createResponse();
		}, 120);
	}

	private runTool(name: string, argumentsJson: string): Record<string, unknown> {
		const doc = this.document;
		if (!doc) return { error: 'No document is open.' };
		const { call, error } = parseAssistantToolCall(doc, name, argumentsJson);
		if (!call) return { error };
		if (call.name === 'clear_highlight') {
			this.onClearHighlight?.();
			return { ok: true };
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
				note: 'Stop 1 is highlighted. Narrate it briefly; the app advances you when you finish.'
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
			this.onPointAt?.(call.segment);
			return { ok: true };
		}
		if (call.name === 'get_reader_focus') {
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
					text: readPassageText(doc, { startIndex: focus.hovered, endIndex: focus.hovered }, 300)
						.text
				};
			}
			if (focus?.playhead !== undefined) output.playhead_segment = focus.playhead;
			if (!Object.keys(output).length) {
				return { note: 'The reader is not pointing at anything right now.' };
			}
			return output;
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
			// At tool time there is no telling whether spoken audio follows in
			// this response — always queue, and start once the assistant's
			// voice has fully drained.
			this.pendingPlayback = call.range;
			return {
				ok: true,
				note: 'Playback starts when you finish speaking. Stay silent until the reader speaks to you.'
			};
		}
		this.onShowPassage?.(call.range);
		const location = describePassageLocation(doc, call.range);
		return location ? { ok: true, under_heading: location } : { ok: true };
	}

	/* ── Guided walkthroughs ─────────────────────────────────────────────── */

	private pauseTour(): void {
		if (this.tour) this.tour.paused = true;
		this.advanceAfterAudio = false;
	}

	private startPendingPlayback(): void {
		const range = this.pendingPlayback;
		if (!range) return;
		this.pendingPlayback = undefined;
		this.onPlayPassage?.(range);
	}

	private applyTourStop(): void {
		const tour = this.tour;
		if (!tour) return;
		this.onShowPassage?.(tour.stops[tour.index].range);
		this.tourProgress = { stop: tour.index + 1, of: tour.stops.length };
	}

	/** Steer the next response with a system note — per-response
	 * `instructions` would replace the session instructions (and with them
	 * the document), so tours are driven through the conversation instead. */
	private tourSystemNudge(text: string): void {
		if (this.respondTimer) {
			clearTimeout(this.respondTimer);
			this.respondTimer = undefined;
		}
		this.channel?.send({
			type: 'conversation.item.create',
			item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] }
		});
		this.createResponse();
	}

	private advanceTour(): void {
		const tour = this.tour;
		if (!tour || tour.paused) return;
		if (tour.index + 1 < tour.stops.length) {
			tour.index += 1;
			this.applyTourStop();
			const stop = tour.stops[tour.index];
			this.tourSystemNudge(
				`Tour stop ${tour.index + 1} of ${tour.stops.length} is highlighted now` +
					`${stop.point ? `: ${stop.point}` : ''}. Narrate it in a sentence or two.`
			);
		} else {
			this.tour = undefined;
			this.tourProgress = undefined;
			this.tourSystemNudge(
				'That was the last stop. Wrap up in one sentence and ask whether they want to dig into any of the stops.'
			);
		}
	}

	/* ── Local voice detection (interrupt while muted) ───────────────────── */

	private startVoiceDetector(microphone: MediaStream): void {
		try {
			// The clone stays enabled purely for analysis — a disabled track
			// goes silent for every consumer, including WebAudio, so the
			// muted WebRTC track cannot be observed directly.
			const clone = microphone.clone();
			const context = new AudioContext();
			const analyser = context.createAnalyser();
			analyser.fftSize = 1024;
			context.createMediaStreamSource(clone).connect(analyser);
			this.analysisClone = clone;
			this.analysisContext = context;
			this.analyser = analyser;
			this.analysisSamples = new Float32Array(analyser.fftSize);
			this.analysisTimer = setInterval(() => this.pollVoice(), VOICE_TICK_MS);
		} catch {
			// Without local analysis, holding to talk still interrupts.
		}
	}

	private pollVoice(): void {
		const analyser = this.analyser;
		const samples = this.analysisSamples;
		if (!analyser || !samples) return;
		analyser.getFloatTimeDomainData(samples);
		let sum = 0;
		for (let index = 0; index < samples.length; index += 1) {
			sum += samples[index] * samples[index];
		}
		const voiced = Math.sqrt(sum / samples.length) > VOICE_RMS_THRESHOLD;
		if (this.autoListening) {
			if (voiced) this.silentTicks = 0;
			else if ((this.silentTicks += 1) >= VOICE_END_TICKS) this.finishAutoTurn();
			return;
		}
		const armed = this.status === 'live' && this.mode === 'ptt' && this.speaking && !this.listening;
		if (!armed || !voiced) {
			this.voicedTicks = 0;
			return;
		}
		if ((this.voicedTicks += 1) >= VOICE_START_TICKS) this.voiceInterrupt();
	}

	/** The reader spoke over the assistant: cut the answer and listen. */
	private voiceInterrupt(): void {
		this.voicedTicks = 0;
		this.silentTicks = 0;
		this.autoListening = true;
		this.pauseTour();
		this.pendingPlayback = undefined;
		this.channel?.send({ type: 'response.cancel' });
		this.channel?.send({ type: 'output_audio_buffer.clear' });
		this.channel?.send({ type: 'input_audio_buffer.clear' });
		this.setMicrophoneOpen(true);
		playChime('listen');
	}

	private finishAutoTurn(): void {
		this.autoListening = false;
		// A hold that began meanwhile owns the turn and commits on release.
		if (this.status !== 'live' || this.mode !== 'ptt' || !this.listening || this.holdActive) {
			return;
		}
		this.setMicrophoneOpen(false);
		playChime('release');
		this.channel?.send({ type: 'input_audio_buffer.commit' });
		this.channel?.send({ type: 'response.create' });
	}
}

export const realtimeAssistant = new RealtimeAssistantState();
