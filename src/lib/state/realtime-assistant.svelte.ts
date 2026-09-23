/**
 * The GPT Realtime engine: one speech-to-speech conversation about the open
 * document. Builds the marker-annotated context, holds the WebRTC session,
 * and turns the model's tool calls into highlight/scroll actions through the
 * shared AssistantSession.
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
	shouldFollowUpAfterTools,
	type SettledToolCall
} from '$lib/domain/assistant-context';
import type { NormalizedDocument } from '$lib/domain/types';
import { playChime } from '$lib/services/assistant-chimes';
import { acquireMicrophone } from '$lib/services/microphone';
import {
	connectRealtime,
	mintRealtimeSecret,
	RealtimeError,
	type RealtimeChannel
} from '$lib/services/openai-realtime';
import { AssistantSession, microphoneErrorMessage } from './assistant-session.svelte';
import { player } from './player.svelte';
import { providersState } from './providers.svelte';
import { readerChrome } from './reader-chrome.svelte';

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

export class RealtimeAssistantState extends AssistantSession {
	private channel?: RealtimeChannel;
	private microphone?: MediaStream;
	private audio?: HTMLAudioElement;
	private abort?: AbortController;
	private seenCalls = new SvelteSet<string>();
	/** Calls still waiting on a slow tool, and calls whose tool came back with
	 * an error — both decide whether a finished response gets a follow-up. */
	private pendingCalls = new SvelteSet<string>();
	private failedCalls = new SvelteSet<string>();
	private captionItemId = '';
	/** How the reader last addressed the assistant. Internally-issued
	 * responses (tool follow-ups, tour nudges) answer on the same channel, so
	 * a typed conversation stays silent end to end. */
	private turnChannel: 'voice' | 'text' = 'voice';
	private respondTimer: ReturnType<typeof setTimeout> | undefined;
	private settingsTimer: ReturnType<typeof setTimeout> | undefined;
	private holdActive = false;
	/** A narrated tour stop finished generating; advance when audio drains. */
	private advanceAfterAudio = false;
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

	/** response.create on the current turn's channel. Spoken turns always leave
	 * the session's voice default; a typed turn only asks for text-only output
	 * when the composer's speaker toggle is off — otherwise typing gets an
	 * answer out loud, with the transcript still landing in the panel. */
	private createResponse(): void {
		// Every path that asks for a reply — a typed turn, a tool-output nudge,
		// a tour prompt — starts the wait indicator here.
		this.activity = 'thinking';
		this.channel?.send(
			this.turnChannel === 'text' && !readerChrome.spokenChatReplies
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
		this.adoptTranscript(doc);
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
				microphone = await acquireMicrophone();
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
					tools: assistantTools(this.context.mode === 'map')
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
		this.advanceAfterAudio = false;
		this.seenCalls.clear();
		this.pendingCalls.clear();
		this.failedCalls.clear();
		this.captionItemId = '';
		this.turnChannel = 'voice';
		this.holdActive = false;
		this.resetSession(errorText);
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

	protected setHandsFree(on: boolean): void {
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
				this.activity = '';
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
				// A response the reader cut off is not owed a follow-up.
				const finished = (event.response as { status?: string })?.status === 'completed';
				if (finished && shouldFollowUpAfterTools(this.settledCalls(output), spoke)) {
					this.scheduleResponseNudge();
				}
				// A call-only response produces no audio events at all — start
				// the queued playback here instead of waiting for a drain that
				// will never come.
				if (!this.speaking) this.startPendingPlayback();
				// A response that only called web_research completes while the
				// search is still running — the indicator must survive it.
				if (this.activity !== 'searching') this.activity = '';
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

	/** Runs the tool and closes the call. Whether the assistant then gets a
	 * turn to speak about it is decided once the whole response is in, by
	 * `followUpAfterTools` — deciding here would mean asking for a reply
	 * before knowing whether the same response already gave one. */
	private handleFunctionCall(item: FunctionCallItem | undefined): void {
		if (!item || item.type !== 'function_call' || !this.document) return;
		const callId = item.call_id ?? '';
		if (!callId || this.seenCalls.has(callId)) return;
		this.seenCalls.add(callId);
		const output = this.runTool(item.name ?? '', item.arguments ?? '');
		if (output instanceof Promise) {
			// A slow tool (web research) sends its output when it lands — the
			// model waits on the open call. A session that ended or reconnected
			// meanwhile drops the result on the floor.
			const channel = this.channel;
			this.pendingCalls.add(callId);
			void output.then((resolved) => {
				this.pendingCalls.delete(callId);
				if (!channel || this.channel !== channel) return;
				this.sendToolOutput(callId, resolved);
				// The answer only exists now, so this one always gets a turn.
				this.scheduleResponseNudge();
			});
			return;
		}
		if ('error' in output) this.failedCalls.add(callId);
		this.sendToolOutput(callId, output);
	}

	/** The response's tool calls, tagged with what running them produced, for
	 * `shouldFollowUpAfterTools`. */
	private settledCalls(output: FunctionCallItem[]): SettledToolCall[] {
		return output
			.filter((item) => item?.type === 'function_call')
			.map((item) => ({
				name: item.name ?? '',
				pending: this.pendingCalls.has(item.call_id ?? ''),
				failed: this.failedCalls.has(item.call_id ?? '')
			}));
	}

	private sendToolOutput(callId: string, output: Record<string, unknown>): void {
		this.channel?.send({
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }
		});
	}

	/** One response even when a turn made several calls: nudge after the last
	 * output instead of answering each one. */
	private scheduleResponseNudge(): void {
		if (this.respondTimer) clearTimeout(this.respondTimer);
		this.respondTimer = setTimeout(() => {
			this.respondTimer = undefined;
			this.createResponse();
		}, 120);
	}

	/* ── Guided walkthroughs ─────────────────────────────────────────────── */

	protected override pauseTour(): void {
		super.pauseTour();
		this.advanceAfterAudio = false;
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
