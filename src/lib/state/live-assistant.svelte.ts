/**
 * The GPT-Live engine. A full-duplex voice talks with the reader and hands
 * anything about the document to a GPT-6 brain (Responses delegation): the
 * brain holds the document — whole, or as its map with reading tools — and
 * every tool, and the voice speaks what it writes. Tool calls arrive nested
 * in `response.event`; the app runs them against the page and continues the
 * brain's response.
 *
 * The voice sends no speaking events, so the app measures its audio itself.
 * Hold-to-talk mutes and unmutes the session's input; hands-free leaves it
 * open and lets the voice take turns. Typed questions go straight to the
 * brain when no voice session is running — and a voice session that starts
 * later is seeded with the typed conversation. Two quiet minutes hang up, and
 * so does handing the stage to the narrator; the next hold picks up where the
 * conversation left off.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { brainTools, buildAssistantInstructions } from '$lib/domain/assistant-context';
import {
	brainChatInput,
	buildLiveVoiceInstructions,
	liveGreeting,
	liveSeedInput,
	typedExchangeNote,
	typedQuestionNote
} from '$lib/domain/live-context';
import { LIVE_MODEL } from '$lib/domain/provider-catalog';
import type { NormalizedDocument } from '$lib/domain/types';
import { playChime } from '$lib/services/assistant-chimes';
import { AudioActivityMonitor } from '$lib/services/audio-activity';
import { BrainChatError, runBrainTurn } from '$lib/services/brain-chat';
import { acquireMicrophone } from '$lib/services/microphone';
import { connectLive, LiveError, type LiveConnection } from '$lib/services/openai-live';
import {
	AssistantSession,
	microphoneErrorMessage,
	type AssistantChatMessage
} from './assistant-session.svelte';
import { player } from './player.svelte';
import { providersState } from './providers.svelte';
import { readerChrome } from './reader-chrome.svelte';

/** Two quiet minutes and the session hangs up: GPT-Live bills every second
 * it is open, listening or not. */
export const IDLE_HANGUP_MS = 120_000;
/** A pause this long ends one spoken turn in the transcript. */
const TURN_GAP_MS = 1_500;
/** The voice counts as quiet after this much silence — the end of a
 * sentence, not a breath. */
const VOICE_QUIET_MS = 700;
/** How loud the voice plays while the reader holds to talk over it. */
const DUCKED_VOLUME = 0.25;
/** play_section with no spoken lead-in: start the narrator after this. */
const PLAYBACK_FALLBACK_MS = 1_500;
/** A walkthrough stop whose narration never became speech still moves on. */
const TOUR_FALLBACK_MS = 6_000;
/** The voice has said a stop once this share of its narration's words is
 * spoken (it paraphrases, often a little shorter)… */
const TOUR_SPOKEN_SHARE = 0.6;
/** …and it has then been quiet a little longer than a breath. */
const TOUR_SETTLE_MS = 600;
/** Fewer words than this from the reader is a backchannel ("mm-hmm", "okay"),
 * not an interruption of a walkthrough. */
const TOUR_INTERRUPT_WORDS = 3;

interface BackendCall {
	callId: string;
	output: Promise<Record<string, unknown>>;
}

function countWords(text: string): number {
	return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function closedMessage(reason: string): string {
	if (reason === 'expired') return 'The voice session reached its time limit.';
	if (reason === 'content') return 'A safety filter ended the voice session.';
	return 'The voice connection was lost.';
}

export class LiveAssistantState extends AssistantSession {
	private connection?: LiveConnection;
	private microphone?: MediaStream;
	private audio?: HTMLAudioElement;
	private abort?: AbortController;
	/** Bumped per session, so a late event from a closed one is ignored. */
	private generation = 0;
	/** Commands wait for `session.started`. */
	private started = false;
	private queued: Record<string, unknown>[] = [];
	private greetOnStart = false;
	private sessionVoice = '';
	private holdActive = false;
	/** The microphone opened itself because the reader spoke over the voice
	 * in hold-to-talk; trailing silence closes it again. */
	private autoListening = false;
	private voiceMonitor?: AudioActivityMonitor;
	private readerMonitor?: AudioActivityMonitor;
	private readerClone?: MediaStream;
	/** Backend responses → the function calls each is waiting on. */
	private responseCalls = new SvelteMap<string, BackendCall[]>();
	private currentResponseId = '';
	/** Brain responses still running, or waiting on tool outputs to
	 * continue — the lead-in to a playback may yet come from one. */
	private brainBusy = 0;
	private continuations = 0;
	private seenCalls = new SvelteSet<string>();
	private pendingTools = 0;
	private lastActivityAt = 0;
	private idleTimer: ReturnType<typeof setInterval> | undefined;
	private settingsTimer: ReturnType<typeof setTimeout> | undefined;
	private trackTimer: ReturnType<typeof setTimeout> | undefined;
	private playbackTimer: ReturnType<typeof setTimeout> | undefined;
	/** The voice was asked to stop; its audio stays muted until it does. */
	private hushed = false;
	private hushTimer: ReturnType<typeof setTimeout> | undefined;
	/** Transcript grouping: the growing turn of each speaker. */
	private readerTurn?: AssistantChatMessage;
	private lastReaderEnd = -Infinity;
	private voiceUtterance = '';
	private lastVoiceEnd = -Infinity;
	private readerSpokeSinceVoice = true;
	/** A silent typed turn in flight. */
	private typedAbort?: AbortController;
	/** A walkthrough stop's narration is done: move on once the voice has
	 * said it. */
	private advanceWhenQuiet = false;
	private tourTimer: ReturnType<typeof setTimeout> | undefined;
	/** How far the voice has got through a stop: words it has spoken in all,
	 * the count when the stop's narration was written, and that narration's
	 * length. The voice speaks well behind the brain, and pauses mid-sentence,
	 * so a quiet moment alone does not mean the stop is done. */
	private voiceWords = 0;
	private stopWordsBase = 0;
	private stopWords = 0;
	/** The brain's words in the response under way. */
	private brainText = '';
	private tourQuietTimer: ReturnType<typeof setTimeout> | undefined;

	/* ── Commands ────────────────────────────────────────────────────────── */

	async beginTalking(doc: NormalizedDocument): Promise<void> {
		this.holdActive = true;
		this.touch();
		if (this.status === 'idle' || this.status === 'error') {
			this.mode = 'ptt';
			// No greeting: the reader is already talking.
			await this.start(doc, false);
			return;
		}
		if (this.status === 'live') this.openHeldMicrophone();
	}

	stopTalking(): void {
		this.holdActive = false;
		if (this.status !== 'live' || this.mode !== 'ptt' || !this.listening) return;
		this.touch();
		this.setMicrophoneOpen(false);
		playChime('release');
	}

	/** Quiet the voice without opening the microphone. GPT-Live has no way to
	 * cancel speech, so its audio is muted here and it is told to stop. */
	hush(): void {
		if (this.status !== 'live') return;
		this.pauseTour();
		this.pendingPlayback = undefined;
		if (!this.speaking) return;
		this.silenceVoice();
		this.send({
			type: 'session.instructions.append',
			delegation_id: null,
			content:
				'The reader asked you to stop. Stop talking now and wait quietly until they speak to you again.'
		});
	}

	async sendTyped(doc: NormalizedDocument, rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text || this.status === 'connecting') return;
		this.touch();
		this.pauseTour();
		this.pendingPlayback = undefined;
		this.adoptTranscript(doc);
		this.messages.push({ id: crypto.randomUUID(), role: 'user', channel: 'text', text });
		if (this.status === 'live' && readerChrome.spokenChatReplies) {
			// Into the conversation: the brain answers and the voice says it,
			// after whatever it is saying now. The voice cannot see the chat,
			// so it is told what was typed.
			this.send({
				type: 'session.thinking.append',
				delegation_id: null,
				content: typedQuestionNote(text)
			});
			this.send({
				type: 'response.item.create',
				item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
			});
			this.send({ type: 'response.create' });
			this.activity = 'thinking';
			return;
		}
		await this.answerTyped(doc, text);
	}

	toggleHandsFree(doc: NormalizedDocument): void {
		this.touch();
		if (this.status === 'idle' || this.status === 'error') {
			this.mode = 'handsFree';
			void this.start(doc, true);
			return;
		}
		if (this.status === 'live') this.setHandsFree(this.mode !== 'handsFree');
		else this.mode = 'handsFree';
	}

	/** The brain's model and effort change in place; a new voice needs a new
	 * session, which picks up the conversation where it was. */
	applyLiveSettings(): void {
		if (!this.active) return;
		if (this.settingsTimer) clearTimeout(this.settingsTimer);
		this.settingsTimer = setTimeout(() => {
			this.settingsTimer = undefined;
			const doc = this.document;
			if (!this.active || !doc) return;
			if (providersState.liveVoice !== this.sessionVoice) {
				const mode = this.mode;
				this.stop();
				this.mode = mode;
				void this.start(doc, false);
				return;
			}
			this.send({
				type: 'session.update',
				session: {
					delegation: {
						type: 'responses',
						responses: {
							model: providersState.liveBrainModel,
							reasoning: { effort: providersState.liveBrainEffort }
						}
					}
				}
			});
		}, 600);
	}

	stop(errorText = ''): void {
		// A typed answer in flight belongs to the conversation being left.
		this.typedAbort?.abort();
		this.typedAbort = undefined;
		if (!this.active && !errorText && this.status === 'idle') return;
		this.generation += 1;
		this.abort?.abort();
		this.abort = undefined;
		for (const timer of [
			this.settingsTimer,
			this.trackTimer,
			this.playbackTimer,
			this.hushTimer,
			this.tourTimer,
			this.tourQuietTimer
		]) {
			if (timer) clearTimeout(timer);
		}
		this.settingsTimer = this.trackTimer = this.playbackTimer = this.hushTimer = undefined;
		this.tourTimer = this.tourQuietTimer = undefined;
		this.advanceWhenQuiet = false;
		this.voiceWords = this.stopWordsBase = this.stopWords = 0;
		this.brainText = '';
		if (this.idleTimer) clearInterval(this.idleTimer);
		this.idleTimer = undefined;
		// Graceful close runs on its own: the session finalizes its usage
		// while everything local is already released.
		void this.connection?.close();
		this.connection = undefined;
		for (const track of this.microphone?.getTracks() ?? []) track.stop();
		this.microphone = undefined;
		this.voiceMonitor?.stop();
		this.voiceMonitor = undefined;
		this.readerMonitor?.stop();
		this.readerMonitor = undefined;
		for (const track of this.readerClone?.getTracks() ?? []) track.stop();
		this.readerClone = undefined;
		if (this.audio) {
			this.audio.srcObject = null;
			this.audio.remove();
			this.audio = undefined;
		}
		this.started = false;
		this.queued = [];
		this.responseCalls.clear();
		this.currentResponseId = '';
		this.brainBusy = 0;
		this.continuations = 0;
		this.seenCalls.clear();
		this.pendingTools = 0;
		this.holdActive = false;
		this.autoListening = false;
		this.hushed = false;
		this.readerTurn = undefined;
		this.lastReaderEnd = -Infinity;
		this.voiceUtterance = '';
		this.lastVoiceEnd = -Infinity;
		this.readerSpokeSinceVoice = true;
		this.resetSession(errorText);
	}

	/* ── Session lifecycle ───────────────────────────────────────────────── */

	private async start(doc: NormalizedDocument, greet: boolean): Promise<void> {
		if (this.active) return;
		this.errorMessage = '';
		this.status = 'connecting';
		this.adoptTranscript(doc);
		const abort = new AbortController();
		this.abort = abort;
		const generation = ++this.generation;
		try {
			await providersState.initialize();
			const apiKey = providersState.keyFor('openai');
			if (!apiKey) {
				throw new LiveError(
					'Add an OpenAI API key under Settings → LLM to talk with your documents.'
				);
			}
			let microphone: MediaStream;
			try {
				microphone = await acquireMicrophone();
			} catch (error) {
				throw new LiveError(microphoneErrorMessage(error));
			}
			if (abort.signal.aborted) {
				for (const track of microphone.getTracks()) track.stop();
				return;
			}
			this.microphone = microphone;
			// Closed until the reader holds the chip or hands-free engages.
			if (this.mode === 'ptt' && !this.holdActive) this.setTrackEnabled(false);

			// The voice and the narrator cannot share the stage — the
			// microphone would hear the narrator.
			if (player.isPlaying) player.pause();
			player.stopAside();

			this.document = doc;
			this.context = buildAssistantInstructions(doc, { role: 'brain' });
			this.greetOnStart = greet;
			this.sessionVoice = providersState.liveVoice;
			this.started = false;
			this.queued = [];

			const audio = document.createElement('audio');
			audio.autoplay = true;
			audio.setAttribute('playsinline', '');
			document.body.append(audio);
			this.audio = audio;

			this.connection = await connectLive({
				apiKey,
				session: {
					model: LIVE_MODEL,
					instructions: buildLiveVoiceInstructions(doc),
					voice: this.sessionVoice,
					input: liveSeedInput(this.messages),
					brain: {
						model: providersState.liveBrainModel,
						instructions: this.context.instructions,
						tools: brainTools(this.context.mode === 'map'),
						effort: providersState.liveBrainEffort
					}
				},
				microphone,
				audio,
				onRemoteStream: (stream) => {
					if (generation === this.generation) this.watchVoice(stream);
				},
				onEvent: (event) => {
					if (generation === this.generation) this.handleEvent(event);
				},
				onClosed: () => {
					if (generation === this.generation && this.active) {
						this.stop('The voice connection was lost.');
					}
				},
				signal: abort.signal
			});
			this.status = 'live';
			this.touch();
			this.idleTimer = setInterval(() => this.checkIdle(), 5_000);
			this.watchReader(microphone);
		} catch (error) {
			if (abort.signal.aborted) return;
			this.stop(
				error instanceof LiveError
					? error.message
					: 'The voice assistant could not start. Try again.'
			);
		}
	}

	private send(event: Record<string, unknown>): void {
		if (!this.connection) return;
		if (!this.started) this.queued.push(event);
		else this.connection.send(event);
	}

	private handleEvent(event: Record<string, unknown>): void {
		switch (event.type as string) {
			case 'session.started':
				this.onStarted();
				break;
			case 'session.input_transcript.delta':
				this.onReaderWords(
					(event.delta as string) ?? '',
					Number(event.start_ms),
					Number(event.end_ms)
				);
				break;
			case 'session.output_transcript.delta':
				this.onVoiceWords(
					(event.delta as string) ?? '',
					Number(event.start_ms),
					Number(event.end_ms)
				);
				break;
			case 'session.delegation.created':
				this.touch();
				if (this.activity !== 'searching') this.activity = 'thinking';
				break;
			case 'response.event':
				this.onBackendEvent((event.event as Record<string, unknown>) ?? {});
				break;
			case 'session.closed':
				if (this.active) this.stop(closedMessage((event.reason as string) ?? ''));
				break;
			case 'error': {
				const error = (event.error ?? event) as { code?: string; message?: string };
				console.warn('[voice assistant] GPT-Live error event', error);
				break;
			}
		}
	}

	private onStarted(): void {
		this.started = true;
		const queued = this.queued;
		this.queued = [];
		for (const event of queued) this.connection?.send(event);
		// Hold-to-talk starts muted; hands-free, or a hold already underway,
		// listens from the first moment.
		this.setMicrophoneOpen(this.mode === 'handsFree' || this.holdActive);
		if (this.mode === 'handsFree') playChime('handsFreeOn');
		else if (this.holdActive) playChime('listen');
		const doc = this.document;
		if (this.greetOnStart && doc) {
			this.send({
				type: 'session.instructions.append',
				delegation_id: null,
				content: liveGreeting(doc)
			});
		}
	}

	/** Two quiet minutes: hang up. The transcript stays, and the next session
	 * starts from it. */
	private checkIdle(): void {
		if (this.status !== 'live') return;
		if (this.holdActive || this.speaking || this.pendingTools || this.pendingPlayback) return;
		if (Date.now() - this.lastActivityAt < IDLE_HANGUP_MS) return;
		playChime('handsFreeOff');
		this.stop();
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
	}

	/* ── Microphone and voice ────────────────────────────────────────────── */

	private openHeldMicrophone(): void {
		if (this.mode !== 'ptt' || this.status !== 'live') return;
		if (this.listening) {
			// The reader's voice already opened it; the hold takes the turn.
			this.autoListening = false;
			return;
		}
		this.pauseTour();
		this.pendingPlayback = undefined;
		if (player.isPlaying) player.pause();
		// The reader is about to talk over the voice: turn it down until it
		// yields (it stops on its own once it hears them).
		if (this.speaking && this.audio) this.audio.volume = DUCKED_VOLUME;
		this.setMicrophoneOpen(true);
		playChime('listen');
	}

	protected setHandsFree(on: boolean): void {
		this.mode = on ? 'handsFree' : 'ptt';
		if (this.status !== 'live') return;
		if (on && player.isPlaying) player.pause();
		this.setMicrophoneOpen(on);
		playChime(on ? 'handsFreeOn' : 'handsFreeOff');
	}

	/** Mute is the session's own input switch; the local track follows it, so
	 * no audio leaves the device while the reader is not talking. */
	private setMicrophoneOpen(open: boolean): void {
		if (!this.microphone) {
			this.listening = false;
			return;
		}
		if (this.trackTimer) clearTimeout(this.trackTimer);
		this.trackTimer = undefined;
		// Before the session starts there is nothing to switch — onStarted
		// applies whatever state the reader left it in.
		if (this.started) {
			this.connection?.send({
				type: open ? 'session.input_audio.unmute' : 'session.input_audio.mute'
			});
		}
		if (open) this.setTrackEnabled(true);
		// The last syllable is still on its way: let it go first.
		else this.trackTimer = setTimeout(() => this.setTrackEnabled(false), 250);
		this.listening = open;
	}

	private setTrackEnabled(enabled: boolean): void {
		for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = enabled;
	}

	/** The voice's own audio says when it speaks. */
	private watchVoice(stream: MediaStream): void {
		this.voiceMonitor?.stop();
		this.voiceMonitor = new AudioActivityMonitor(stream, {
			threshold: 0.008,
			startMs: 100,
			endMs: VOICE_QUIET_MS,
			onChange: (active) => {
				this.speaking = active;
				this.touch();
				if (active) return;
				if (this.audio) this.audio.volume = 1;
				if (this.hushed) this.unsilenceVoice();
				// Queued playback starts once the voice has drained — and so
				// does the next walkthrough stop.
				this.startPendingPlayback();
				this.advanceTourIfDone();
			}
		});
	}

	/** In hold-to-talk the reader can still interrupt by just speaking: an
	 * analysis-only clone of the microphone listens while the voice talks. */
	private watchReader(microphone: MediaStream): void {
		try {
			const clone = microphone.clone();
			// A disabled track is silent to every consumer — the clone stays on.
			for (const track of clone.getAudioTracks()) track.enabled = true;
			this.readerClone = clone;
			this.readerMonitor = new AudioActivityMonitor(clone, {
				threshold: 0.02,
				startMs: 250,
				endMs: 700,
				onChange: (active) => this.onReaderSound(active)
			});
		} catch {
			// Without it, holding to talk still interrupts.
		}
	}

	private onReaderSound(active: boolean): void {
		if (active) {
			const armed =
				this.status === 'live' && this.mode === 'ptt' && this.speaking && !this.listening;
			if (!armed) return;
			this.autoListening = true;
			this.touch();
			if (this.audio) this.audio.volume = DUCKED_VOLUME;
			this.setMicrophoneOpen(true);
			playChime('listen');
			return;
		}
		if (!this.autoListening) return;
		this.autoListening = false;
		// A hold that began meanwhile owns the turn and closes it on release.
		if (this.status !== 'live' || this.mode !== 'ptt' || !this.listening || this.holdActive) return;
		this.setMicrophoneOpen(false);
		playChime('release');
	}

	private silenceVoice(): void {
		if (!this.audio) return;
		this.audio.muted = true;
		this.hushed = true;
		if (this.hushTimer) clearTimeout(this.hushTimer);
		// Never stay muted for good, even if the voice misses the request.
		this.hushTimer = setTimeout(() => this.unsilenceVoice(), 10_000);
	}

	private unsilenceVoice(): void {
		if (this.hushTimer) clearTimeout(this.hushTimer);
		this.hushTimer = undefined;
		this.hushed = false;
		if (this.audio) this.audio.muted = false;
	}

	/* ── Transcripts ─────────────────────────────────────────────────────── */

	private onReaderWords(delta: string, startMs: number, endMs: number): void {
		if (!delta) return;
		this.touch();
		// The voice speaking ends the reader's turn (readerTurn is cleared).
		const turn = this.readerTurn;
		if (turn && startMs - this.lastReaderEnd < TURN_GAP_MS && this.messages.at(-1) === turn) {
			turn.text += delta;
		} else {
			this.messages.push({
				id: crypto.randomUUID(),
				role: 'user',
				channel: 'voice',
				text: delta.trimStart()
			});
			// Keep the proxy the array hands back, not the object pushed.
			this.readerTurn = this.messages.at(-1);
		}
		this.lastReaderEnd = Number.isFinite(endMs) ? endMs : startMs;
		this.readerSpokeSinceVoice = true;
		// Talking over a walkthrough pauses it; a backchannel does not.
		const words = countWords(this.readerTurn?.text ?? '');
		if (this.tour && !this.tour.paused && words >= TOUR_INTERRUPT_WORDS) this.pauseTour();
	}

	private onVoiceWords(delta: string, startMs: number, endMs: number): void {
		if (!delta) return;
		this.touch();
		const fresh =
			!this.voiceUtterance ||
			this.readerSpokeSinceVoice ||
			startMs - this.lastVoiceEnd >= TURN_GAP_MS;
		if (fresh) {
			this.voiceUtterance = crypto.randomUUID();
			this.caption = '';
			// The previous utterance is finished; a typed reply streaming
			// alongside is not.
			for (const message of this.messages) {
				if (message.pending && message.channel === 'voice') message.pending = false;
			}
		}
		this.readerSpokeSinceVoice = false;
		this.readerTurn = undefined;
		this.caption += fresh ? delta.trimStart() : delta;
		this.voiceWords += countWords(delta);
		this.lastVoiceEnd = Number.isFinite(endMs) ? endMs : startMs;
		this.streamAssistantText(this.voiceUtterance, fresh ? delta.trimStart() : delta, 'voice');
	}

	/* ── The brain ───────────────────────────────────────────────────────── */

	private onBackendEvent(inner: Record<string, unknown>): void {
		const type = inner.type as string;
		const response = inner.response as { id?: string } | undefined;
		if (type === 'response.output_text.delta') {
			this.brainText += (inner.delta as string) ?? '';
			return;
		}
		if (type === 'response.created') {
			this.brainText = '';
			this.brainBusy += 1;
			if (this.continuations) this.continuations -= 1;
			this.currentResponseId = response?.id ?? crypto.randomUUID();
			this.responseCalls.set(this.currentResponseId, []);
			if (this.activity !== 'searching') this.activity = 'thinking';
			return;
		}
		if (type === 'response.output_item.done') {
			const item = inner.item as
				{ type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
			if (item?.type === 'function_call' && item.call_id) this.onBrainCall(item);
			return;
		}
		if (
			type === 'response.completed' ||
			type === 'response.failed' ||
			type === 'response.incomplete' ||
			type === 'response.cancelled'
		) {
			this.brainBusy = Math.max(0, this.brainBusy - 1);
			const id = response?.id ?? this.currentResponseId;
			const calls = this.responseCalls.get(id) ?? [];
			this.responseCalls.delete(id);
			if (!calls.length || type !== 'response.completed') {
				// The brain has answered; the voice takes it from here.
				if (this.activity === 'thinking') this.activity = '';
				this.schedulePlaybackIfSilent();
				this.scheduleTourAdvance();
				return;
			}
			this.continuations += 1;
			void this.continueBrain(calls);
		}
	}

	/** Run a call the moment it lands — the reader sees the highlight before
	 * the words about it — and hold its output for the continuation. */
	private onBrainCall(item: { call_id?: string; name?: string; arguments?: string }): void {
		const callId = item.call_id ?? '';
		if (this.seenCalls.has(callId)) return;
		this.seenCalls.add(callId);
		this.touch();
		if (item.name === 'plan_tour' || item.name === 'continue_tour') {
			// The voice cannot see the tour: without this it asks after every
			// stop whether to go on.
			this.send({
				type: 'session.thinking.append',
				delegation_id: null,
				content:
					'A guided walkthrough is running: the app moves the highlight from stop to stop and the backend narrates each one in turn. Say each narration as it comes, starting straight in — no "let\'s move on" or "next up" between stops, and never ask whether to continue. If the reader interrupts, answer them.'
			});
		}
		this.pendingTools += 1;
		const output = Promise.resolve(this.runTool(item.name ?? '', item.arguments ?? ''))
			.catch((error: unknown) => ({
				error: error instanceof Error ? error.message : 'The tool failed.'
			}))
			.finally(() => {
				this.pendingTools = Math.max(0, this.pendingTools - 1);
			});
		const calls = this.responseCalls.get(this.currentResponseId);
		if (calls) calls.push({ callId, output });
		else this.responseCalls.set(this.currentResponseId, [{ callId, output }]);
	}

	/** The response is done and waits on its calls: return every output,
	 * then continue it. */
	private async continueBrain(calls: BackendCall[]): Promise<void> {
		const generation = this.generation;
		const outputs = await Promise.all(calls.map((call) => call.output));
		if (generation !== this.generation || this.status !== 'live') return;
		this.touch();
		calls.forEach((call, index) => {
			this.send({
				type: 'response.item.create',
				item: {
					type: 'function_call_output',
					call_id: call.callId,
					output: JSON.stringify(outputs[index])
				}
			});
		});
		this.send({ type: 'response.create' });
	}

	/** The narrator takes the stage. The voice would only talk over it —
	 * probed: asked to "read the section", it improvised a reading of its
	 * own over the narrator — and every silent minute still bills, so the
	 * session hangs up; the next hold picks the conversation up again. */
	protected override startPendingPlayback(): void {
		// The brain may still be writing the lead-in; its completion starts
		// playback instead (schedulePlaybackIfSilent).
		if (!this.pendingPlayback || this.brainBusy || this.continuations) return;
		super.startPendingPlayback();
		if (this.active) this.stop();
	}

	/* ── Guided walkthroughs ─────────────────────────────────────────────── */

	/** The next stop is the brain's to narrate: a developer note it answers,
	 * and the voice says. */
	protected tourNudge(text: string): void {
		this.activity = 'thinking';
		this.send({
			type: 'response.item.create',
			item: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }
		});
		this.send({ type: 'response.create' });
	}

	protected override pauseTour(): void {
		super.pauseTour();
		this.advanceWhenQuiet = false;
		for (const timer of [this.tourTimer, this.tourQuietTimer]) if (timer) clearTimeout(timer);
		this.tourTimer = this.tourQuietTimer = undefined;
	}

	/** The brain finished a stop's narration: advance once the voice has said
	 * most of it and paused — or after a while, if it never speaks at all. */
	private scheduleTourAdvance(): void {
		if (!this.tour || this.tour.paused) return;
		this.advanceWhenQuiet = true;
		this.stopWords = countWords(this.brainText);
		this.stopWordsBase = this.voiceWords;
		if (this.tourTimer) clearTimeout(this.tourTimer);
		this.tourTimer = setTimeout(() => {
			this.tourTimer = undefined;
			if (!this.speaking && this.voiceWords === this.stopWordsBase) this.advanceTour();
		}, TOUR_FALLBACK_MS);
	}

	/** Called whenever the voice goes quiet. */
	private advanceTourIfDone(): void {
		if (!this.advanceWhenQuiet || this.brainBusy || this.continuations || this.pendingTools) return;
		if (!this.tour || this.tour.paused) {
			this.advanceWhenQuiet = false;
			return;
		}
		// A pause partway through the narration is a breath, not the end.
		const spoken = this.voiceWords - this.stopWordsBase;
		if (spoken < this.stopWords * TOUR_SPOKEN_SHARE) return;
		if (this.tourQuietTimer) clearTimeout(this.tourQuietTimer);
		this.tourQuietTimer = setTimeout(() => {
			this.tourQuietTimer = undefined;
			if (this.speaking || !this.advanceWhenQuiet || !this.tour || this.tour.paused) return;
			this.advanceWhenQuiet = false;
			if (this.tourTimer) clearTimeout(this.tourTimer);
			this.tourTimer = undefined;
			this.advanceTour();
		}, TOUR_SETTLE_MS);
	}

	/** play_section with nothing to say first: the narrator should not wait
	 * for speech that is not coming. */
	private schedulePlaybackIfSilent(): void {
		if (!this.pendingPlayback) return;
		if (this.playbackTimer) clearTimeout(this.playbackTimer);
		this.playbackTimer = setTimeout(() => {
			this.playbackTimer = undefined;
			if (!this.speaking) this.startPendingPlayback();
		}, PLAYBACK_FALLBACK_MS);
	}

	/* ── Typed chat ──────────────────────────────────────────────────────── */

	/** A typed question answered in text by the brain directly — no voice
	 * session needed. A live voice hears about the exchange; otherwise the
	 * reply is read aloud by the narration voice when spoken replies are on. */
	private async answerTyped(doc: NormalizedDocument, text: string): Promise<void> {
		await providersState.initialize();
		const apiKey = providersState.keyFor('openai');
		if (!apiKey) {
			this.errorMessage = 'Add an OpenAI API key under Settings → LLM to talk with your documents.';
			this.messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				channel: 'text',
				text: this.errorMessage
			});
			return;
		}
		const live = this.status === 'live';
		if (!live) {
			this.document = doc;
			this.context = buildAssistantInstructions(doc, { role: 'brain' });
		}
		const context = this.context ?? buildAssistantInstructions(doc, { role: 'brain' });
		this.typedAbort?.abort();
		const abort = new AbortController();
		this.typedAbort = abort;
		const replyId = crypto.randomUUID();
		this.activity = 'thinking';
		try {
			const reply = await runBrainTurn({
				apiKey,
				model: providersState.liveBrainModel,
				effort: providersState.liveBrainEffort,
				instructions: context.instructions,
				tools: brainTools(context.mode === 'map', { typed: true }),
				input: brainChatInput(this.messages),
				runTool: (name, args) => this.runTool(name, args),
				onText: (delta) => {
					if (!abort.signal.aborted) this.streamAssistantText(replyId, delta, 'text');
				},
				signal: abort.signal
			});
			if (abort.signal.aborted) return;
			this.settleTranscript();
			if (this.status === 'live') {
				this.send({
					type: 'session.thinking.append',
					delegation_id: null,
					content: typedExchangeNote(text, reply)
				});
			} else if (this.pendingPlayback) {
				this.startPendingPlayback();
			} else if (readerChrome.spokenChatReplies && reply.trim()) {
				void player.speakAside(reply);
			}
		} catch (error) {
			if (abort.signal.aborted) return;
			this.messages.push({
				id: crypto.randomUUID(),
				role: 'assistant',
				channel: 'text',
				text:
					error instanceof BrainChatError
						? error.message
						: 'The assistant could not answer. Try again.'
			});
		} finally {
			if (this.typedAbort === abort) {
				this.typedAbort = undefined;
				if (this.activity === 'thinking') this.activity = '';
				if (this.status !== 'live') this.flushConversationFootprint();
			}
		}
	}
}

export const liveAssistant = new LiveAssistantState();
