import { describe, expect, it } from 'vitest';
import { pcm16ToFloat32, wordTimingsFromAlignment } from './elevenlabs';

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
