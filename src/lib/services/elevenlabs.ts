/**
 * ElevenLabs speech engine: timestamped synthesis mapped onto Voicebook's
 * SynthesisResult (Float32 PCM + word timings), plus voice listing and
 * subscription usage for the settings surface. Calls go directly from this
 * browser to api.elevenlabs.io with the user's own key.
 */
import { wordsFor } from '$lib/domain/speech-words';
import type { TimingMap, WordTiming } from '$lib/domain/types';
import type { SynthesisResult } from './tts-client';
import type { ElevenLabsVoice } from '$lib/domain/provider-catalog';

const API = 'https://api.elevenlabs.io';
const SAMPLE_RATE = 24_000;

export class ElevenLabsError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'ElevenLabsError';
	}
}

function friendly(status: number, detail: string): string {
	if (status === 401 || status === 403)
		return 'The ElevenLabs API key was rejected. Check it under Settings → Voice.';
	if (status === 429) return 'ElevenLabs is rate limiting this key. Try again in a moment.';
	if (status === 422 && /quota|character/i.test(detail))
		return 'This ElevenLabs plan has run out of characters for the month.';
	return `ElevenLabs request failed (${status})${detail ? `: ${detail}` : '.'}`;
}

async function request(path: string, apiKey: string, init: RequestInit = {}): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, {
			...init,
			headers: {
				'xi-api-key': apiKey,
				...(init.body ? { 'content-type': 'application/json' } : {}),
				...init.headers
			}
		});
	} catch (error) {
		if (init.signal?.aborted) throw new ElevenLabsError('The request was cancelled.');
		throw new ElevenLabsError(
			error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
		);
	}
	const data = (await response.json().catch(() => ({}))) as {
		detail?: { message?: string } | string;
	};
	if (!response.ok) {
		const detail = typeof data.detail === 'string' ? data.detail : (data.detail?.message ?? '');
		throw new ElevenLabsError(friendly(response.status, detail), response.status);
	}
	return data;
}

/* ── Word timing from character alignment ────────────────────────────────── */

export interface CharacterAlignment {
	characters: string[];
	character_start_times_seconds: number[];
	character_end_times_seconds: number[];
}

/**
 * Group the character-level alignment into per-word timings using the shared
 * `wordsFor` tokenizer — the exact tokenization behind the segmenter's word
 * spans, so timing entries line up index-for-index with the reader's word
 * highlighter. Pure and unit-tested.
 */
export function wordTimingsFromAlignment(alignment: CharacterAlignment): WordTiming[] {
	// Rebuild the aligned text with per-character times. Entries are usually
	// single characters, but expanding defensively keeps indexes correct if
	// the API ever returns multi-character entries.
	let text = '';
	const starts: number[] = [];
	const ends: number[] = [];
	alignment.characters.forEach((character, index) => {
		const start = alignment.character_start_times_seconds[index] ?? 0;
		const end = alignment.character_end_times_seconds[index] ?? start;
		for (let offset = 0; offset < character.length; offset += 1) {
			starts.push(start);
			ends.push(end);
		}
		text += character;
	});
	return wordsFor(text).map((span) => ({
		word: span.text,
		start: starts[span.start] ?? 0,
		end: ends[span.end - 1] ?? starts[span.start] ?? 0
	}));
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
	const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
	const audio = new Float32Array(samples.length);
	for (let index = 0; index < samples.length; index += 1) {
		audio[index] = samples[index] / 32768;
	}
	return audio;
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/* ── Synthesis ───────────────────────────────────────────────────────────── */

export interface ElevenLabsSynthesisRequest {
	apiKey: string;
	voiceId: string;
	modelId: string;
	text: string;
	signal?: AbortSignal;
}

/**
 * Timestamped synthesis at PCM 24 kHz — drops straight into the player's
 * AudioBuffer/word-highlight pipeline with native timing confidence.
 */
export async function synthesizeElevenLabs(
	options: ElevenLabsSynthesisRequest
): Promise<SynthesisResult> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(90_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const data = (await request(
		`/v1/text-to-speech/${encodeURIComponent(options.voiceId)}/with-timestamps?output_format=pcm_24000`,
		options.apiKey,
		{
			method: 'POST',
			body: JSON.stringify({ text: options.text, model_id: options.modelId }),
			signal
		}
	)) as {
		audio_base64?: string;
		alignment?: CharacterAlignment;
		normalized_alignment?: CharacterAlignment;
	};
	if (!data.audio_base64) throw new ElevenLabsError('ElevenLabs returned no audio.');
	const audio = pcm16ToFloat32(decodeBase64(data.audio_base64));
	const alignment = data.alignment ?? data.normalized_alignment;
	const timing: TimingMap = alignment
		? { confidence: 'native', words: wordTimingsFromAlignment(alignment) }
		: { confidence: 'estimated', words: [] };
	return {
		audio,
		sampleRate: SAMPLE_RATE,
		timing,
		metrics: {
			elapsedMs: performance.now() - started,
			audioDuration: audio.length / SAMPLE_RATE,
			backend: 'cloud'
		}
	};
}

/* ── Account surface ─────────────────────────────────────────────────────── */

export async function listElevenLabsVoices(
	apiKey: string,
	signal?: AbortSignal
): Promise<ElevenLabsVoice[]> {
	const data = (await request('/v1/voices', apiKey, { signal })) as {
		voices?: Array<{
			voice_id: string;
			name?: string;
			preview_url?: string;
			labels?: Record<string, string>;
		}>;
	};
	return (data.voices ?? []).map((voice) => {
		const labels = voice.labels ?? {};
		const description = [labels.gender, labels.accent, labels.age, labels.descriptive]
			.filter(Boolean)
			.join(' · ')
			.replace(/_/g, ' ');
		return {
			id: voice.voice_id,
			name: (voice.name ?? 'Voice').split(' - ')[0].trim(),
			description: description || (voice.name?.split(' - ')[1] ?? ''),
			previewUrl: voice.preview_url
		};
	});
}

export interface ElevenLabsUsage {
	tier: string;
	used: number;
	limit: number;
	resetsAt: Date;
}

export async function elevenLabsUsage(
	apiKey: string,
	signal?: AbortSignal
): Promise<ElevenLabsUsage> {
	const data = (await request('/v1/user/subscription', apiKey, { signal })) as {
		tier?: string;
		character_count?: number;
		character_limit?: number;
		next_character_count_reset_unix?: number;
	};
	return {
		tier: data.tier ?? 'unknown',
		used: data.character_count ?? 0,
		limit: data.character_limit ?? 0,
		resetsAt: new Date((data.next_character_count_reset_unix ?? 0) * 1000)
	};
}
