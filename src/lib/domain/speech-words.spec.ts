import { describe, expect, it } from 'vitest';
import { normalizeForSpeech, spokenWordSpans, wordsFor } from './speech-words';
import { segmentBlocks } from './segmenter';
import type { DocumentBlock } from './types';

/** The contract everything hangs on: display word spans must line up
 * index-for-index with the tokens of the normalized (spoken) text, because
 * the player pairs `segment.words[i]` with `timing.words[i]`. */
function expectAligned(text: string) {
	const spans = spokenWordSpans(text);
	const spoken = wordsFor(normalizeForSpeech(text));
	expect(spans.map((span) => span.text)).toEqual(spoken.map((word) => word.text));
}

describe('spoken word spans', () => {
	it('aligns with the spoken tokens for plain prose', () => {
		expectAligned('First sentence. Second sentence!');
		expectAligned("Voicebook's calm reader — now with em dashes.");
	});

	it('aligns when URLs are replaced by their spoken pointer', () => {
		expectAligned('Read https://www.example.com/deep/path now.');
		expectAligned('See www.arxiv.org/abs/2301.001, then continue.');
		expectAligned('Both https://a.io/x and https://b.io/y work.');
		expectAligned('Trailing link https://example.com/page.');
	});

	it('aligns for decimals, times, and dotted names', () => {
		expectAligned('Pi is roughly 3.14159 at 10:30 a.m.');
		expectAligned('Node.js reads vite.config.ts fine.');
	});

	it('maps every spoken link word to the whole displayed URL', () => {
		const text = 'Read https://example.com/docs now.';
		const spans = spokenWordSpans(text);
		const urlStart = text.indexOf('https://');
		const urlEnd = text.indexOf(' now.');
		const linkWords = spans.filter((span) => span.start === urlStart);
		expect(linkWords.map((span) => span.text)).toEqual(['a', 'link', 'in', 'the', 'document']);
		expect(linkWords.every((span) => span.end === urlEnd)).toBe(true);
		// Surrounding words still map to themselves.
		expect(spans[0]).toMatchObject({ text: 'Read', start: 0, end: 4 });
		expect(spans.at(-1)).toMatchObject({ text: 'now', start: urlEnd + 1 });
	});

	it('keeps display offsets monotonic so position remapping stays stable', () => {
		const spans = spokenWordSpans('Before www.example.com/a after, and https://b.io/c end.');
		for (let index = 1; index < spans.length; index += 1) {
			expect(spans[index].start).toBeGreaterThanOrEqual(spans[index - 1].start);
		}
	});
});

describe('segment words match synthesized timing tokens', () => {
	function paragraph(text: string): DocumentBlock {
		return { id: 'b0', kind: 'paragraph', text, speak: true, anchor: {} };
	}

	it('holds for paragraphs containing URLs and decimals', () => {
		const texts = [
			'The docs live at https://example.com/handbook for reference.',
			'Pi is 3.14 and e is 2.718 in this table.',
			'Plain words only here.'
		];
		for (const text of texts) {
			for (const segment of segmentBlocks([paragraph(text)])) {
				expect(segment.words.map((word) => word.text)).toEqual(
					wordsFor(segment.normalizedText).map((word) => word.text)
				);
			}
		}
	});
});
