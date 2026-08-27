import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ElevenLabsError,
	pcm16ToFloat32,
	synthesizeElevenLabs,
	wordTimingsFromAlignment
} from './elevenlabs';

describe('word timings from character alignment', () => {
	it('groups characters into whitespace-delimited words with span timing', () => {
		const text = 'Hi there';
		const characters = text.split('');
		const starts = characters.map((_, index) => index * 0.1);
		const ends = characters.map((_, index) => index * 0.1 + 0.08);
		const words = wordTimingsFromAlignment({
			characters,
			character_start_times_seconds: starts,
			character_end_times_seconds: ends
		});
		expect(words).toEqual([
			{ word: 'Hi', start: 0, end: expect.closeTo(0.18, 5) },
			{ word: 'there', start: expect.closeTo(0.3, 5), end: expect.closeTo(0.78, 5) }
		]);
	});

	it('ignores leading, trailing, and repeated whitespace', () => {
		const characters = [' ', 'a', ' ', ' ', 'b', ' '];
		const times = characters.map((_, index) => index);
		const words = wordTimingsFromAlignment({
			characters,
			character_start_times_seconds: times,
			character_end_times_seconds: times
		});
		expect(words.map((word) => word.word)).toEqual(['a', 'b']);
	});

	it('tokenizes like the shared word tokenizer, not by whitespace', () => {
		// "well - lit" with a spaced hyphen: whitespace grouping would emit a
		// bare "-" token that has no display-span counterpart and would shift
		// every later highlight; the shared tokenizer skips it.
		const text = 'well - lit';
		const characters = text.split('');
		const times = characters.map((_, index) => index * 0.1);
		const words = wordTimingsFromAlignment({
			characters,
			character_start_times_seconds: times,
			character_end_times_seconds: times
		});
		expect(words.map((word) => word.word)).toEqual(['well', 'lit']);
		expect(words[1].start).toBeCloseTo(0.7, 5);
	});

	it('returns no words for empty alignment', () => {
		expect(
			wordTimingsFromAlignment({
				characters: [],
				character_start_times_seconds: [],
				character_end_times_seconds: []
			})
		).toEqual([]);
	});
});

describe('pcm decoding', () => {
	it('converts little-endian 16-bit samples to normalized floats', () => {
		const samples = new Int16Array([0, 16384, -16384, 32767, -32768]);
		const bytes = new Uint8Array(samples.buffer);
		const audio = pcm16ToFloat32(bytes);
		expect(audio[0]).toBe(0);
		expect(audio[1]).toBeCloseTo(0.5, 3);
		expect(audio[2]).toBeCloseTo(-0.5, 3);
		expect(audio[3]).toBeCloseTo(1, 2);
		expect(audio[4]).toBe(-1);
	});

	it('tolerates a trailing odd byte', () => {
		const bytes = new Uint8Array([0, 64, 7]);
		expect(pcm16ToFloat32(bytes).length).toBe(1);
	});
});

describe('synthesis request', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(): ReturnType<typeof vi.fn> {
		const samples = new Int16Array([0, 128, -128, 0]);
		const bytes = new Uint8Array(samples.buffer);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				audio_base64: btoa(String.fromCharCode(...bytes)),
				alignment: {
					characters: ['H', 'i'],
					character_start_times_seconds: [0, 0.1],
					character_end_times_seconds: [0.1, 0.2]
				}
			})
		}));
		vi.stubGlobal('fetch', fetchMock);
		return fetchMock;
	}

	function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		return JSON.parse(init.body as string) as Record<string, unknown>;
	}

	it('sends the bare model id and omits voice_settings when none are given', async () => {
		const fetchMock = stubFetch();
		const result = await synthesizeElevenLabs({
			apiKey: 'k',
			voiceId: 'v',
			modelId: 'eleven_v3',
			text: 'Hi'
		});
		expect(fetchMock.mock.calls[0][0]).toContain('/v1/text-to-speech/v/with-timestamps');
		expect(bodyOf(fetchMock)).toEqual({ text: 'Hi', model_id: 'eleven_v3' });
		expect(result.timing.confidence).toBe('native');
		expect(result.timing.words.map((word) => word.word)).toEqual(['Hi']);
	});

	it('forwards voice settings verbatim when the user has tuned them', async () => {
		const fetchMock = stubFetch();
		await synthesizeElevenLabs({
			apiKey: 'k',
			voiceId: 'v',
			modelId: 'eleven_v3',
			text: 'Hi',
			voiceSettings: { stability: 1 }
		});
		expect(bodyOf(fetchMock)).toEqual({
			text: 'Hi',
			model_id: 'eleven_v3',
			voice_settings: { stability: 1 }
		});
	});

	it('refuses a passage longer than the model accepts before spending credits', async () => {
		const fetchMock = stubFetch();
		await expect(
			synthesizeElevenLabs({
				apiKey: 'k',
				voiceId: 'v',
				// v3 caps at 5,000 characters where Flash takes 40,000.
				modelId: 'eleven_v3',
				text: 'x'.repeat(5_001)
			})
		).rejects.toThrow(ElevenLabsError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
