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
	type PassageRange
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

interface FunctionCallItem {
	type?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
}

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

	/** Assigned by the reader page (and cleared on unmount). */
	onShowPassage?: (range: PassageRange) => void;
	onClearHighlight?: () => void;

	private channel?: RealtimeChannel;
	private microphone?: MediaStream;
	private audio?: HTMLAudioElement;
	private abort?: AbortController;
	private document?: NormalizedDocument;
	private context?: AssistantInstructions;
	private seenCalls = new SvelteSet<string>();
	private captionItemId = '';
	private respondTimer: ReturnType<typeof setTimeout> | undefined;
	private holdActive = false;

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
		if (this.status === 'live') this.openHeldMicrophone();
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

	/** Double-tap or the menu row: lock or unlock hands-free listening. */
	toggleHandsFree(doc: NormalizedDocument): void {
		if (this.status === 'idle' || this.status === 'error') {
			this.mode = 'handsFree';
			void this.start(doc);
			return;
		}
		if (this.status === 'live') this.setHandsFree(this.mode !== 'handsFree');
		else this.mode = 'handsFree';
	}

	private async start(doc: NormalizedDocument): Promise<void> {
		if (this.active) return;
		this.errorMessage = '';
		this.status = 'connecting';
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
			let microphone: MediaStream;
			try {
				microphone = await navigator.mediaDevices.getUserMedia({
					audio: { echoCancellation: true, noiseSuppression: true }
				});
			} catch (error) {
				throw new RealtimeError(microphoneErrorMessage(error));
			}
			if (abort.signal.aborted) {
				for (const track of microphone.getTracks()) track.stop();
				return;
			}
			this.microphone = microphone;
			// Closed until the reader holds the chip (or hands-free engages).
			this.setMicrophoneOpen(false);

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
			// carry the document and the opening line to say.
			this.channel.send({ type: 'response.create' });
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
		this.channel?.close();
		this.channel = undefined;
		for (const track of this.microphone?.getTracks() ?? []) track.stop();
		this.microphone = undefined;
		if (this.audio) {
			this.audio.srcObject = null;
			this.audio.remove();
			this.audio = undefined;
		}
		this.document = undefined;
		this.context = undefined;
		this.seenCalls.clear();
		this.captionItemId = '';
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
		if (this.mode !== 'ptt' || this.listening || this.status !== 'live') return;
		if (this.speaking) {
			// Holding the chip is the barge-in: cut the answer, then listen.
			this.channel?.send({ type: 'response.cancel' });
			this.channel?.send({ type: 'output_audio_buffer.clear' });
		}
		this.channel?.send({ type: 'input_audio_buffer.clear' });
		this.setMicrophoneOpen(true);
		playChime('listen');
	}

	private setHandsFree(on: boolean): void {
		this.mode = on ? 'handsFree' : 'ptt';
		if (this.status !== 'live') return;
		this.applyTurnDetection();
		this.setMicrophoneOpen(on);
		playChime(on ? 'handsFreeOn' : 'handsFreeOff');
	}

	/** Hands-free lets the server take turns (semantic VAD); hold-to-talk
	 * commits turns manually, so the model can never hear itself. */
	private applyTurnDetection(): void {
		this.channel?.send({
			type: 'session.update',
			session: {
				type: 'realtime',
				audio: {
					input: {
						turn_detection: this.mode === 'handsFree' ? { type: 'semantic_vad' } : null
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
				break;
			}
			case 'output_audio_buffer.started':
				this.speaking = true;
				break;
			case 'output_audio_buffer.stopped':
			case 'output_audio_buffer.cleared':
				this.speaking = false;
				break;
			case 'input_audio_buffer.speech_started':
				// Hands-free barge-in; the server cuts the response itself.
				this.speaking = false;
				break;
			case 'response.output_item.done':
				this.handleFunctionCall(event.item as FunctionCallItem);
				break;
			case 'response.done': {
				const output =
					((event.response as { output?: FunctionCallItem[] })?.output as FunctionCallItem[]) ?? [];
				for (const item of output) this.handleFunctionCall(item);
				this.speaking = false;
				break;
			}
			case 'error':
				console.warn('[voice assistant] realtime error event', event.error ?? event);
				break;
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
		// One response even when a turn made several calls: nudge after the
		// last output instead of answering each one.
		if (this.respondTimer) clearTimeout(this.respondTimer);
		this.respondTimer = setTimeout(() => {
			this.respondTimer = undefined;
			this.channel?.send({ type: 'response.create' });
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
		this.onShowPassage?.(call.range);
		const location = describePassageLocation(doc, call.range);
		return location ? { ok: true, under_heading: location } : { ok: true };
	}
}

export const realtimeAssistant = new RealtimeAssistantState();
