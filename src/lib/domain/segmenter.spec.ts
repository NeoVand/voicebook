import { describe, expect, it } from 'vitest';
import {
	estimateDuration,
	MAX_SEGMENT_CHARS,
	normalizeForSpeech,
	refreshDocumentSegments,
	segmentBlocks,
	segmentsEqual,
	wordsFor
} from './segmenter';
import { hashNarrationSource } from './narration';
import type { DocumentBlock, NarrationEntry, NormalizedDocument } from './types';

function block(overrides: Partial<DocumentBlock> = {}): DocumentBlock {
	return {
		id: 'b0',
		kind: 'paragraph',
		text: 'First sentence. Second sentence!',
		speak: true,
		anchor: { page: 2 },
		...overrides
	};
}

describe('speech segmentation', () => {
	it('never speaks link text — every URL becomes a pointer to the document', () => {
		expect(normalizeForSpeech(' Read   https://www.example.com/deep/path now. ')).toBe(
			'Read a link in the document now.'
		);
		expect(normalizeForSpeech('Read http://% now')).toBe('Read a link in the document now');
		expect(normalizeForSpeech('See www.arxiv.org/abs/2301.001, then continue.')).toBe(
			'See a link in the document, then continue.'
		);
		expect(normalizeForSpeech('Clone github.com/NeoVand/voicebook today.')).toBe(
			'Clone a link in the document today.'
		);
		expect(normalizeForSpeech('Both https://a.io/x and https://b.io/y work.')).toBe(
			'Both a link in the document and a link in the document work.'
		);
		// Dotted names without a path are prose, not links.
		expect(normalizeForSpeech('Node.js reads vite.config.ts fine.')).toBe(
			'Node.js reads vite.config.ts fine.'
		);
	});

	it('keeps exact sentence and source boundaries', () => {
		const segments = segmentBlocks([block()]);
		expect(segments).toHaveLength(2);
		expect(segments.map((segment) => segment.text)).toEqual([
			'First sentence.',
			'Second sentence!'
		]);
		expect(segments[1].start).toBe(16);
		expect(segments[1].anchor).toMatchObject({ page: 2, start: 16, end: 32 });
	});

	it('keeps headings and list items whole', () => {
		const segments = segmentBlocks([
			block({ id: 'heading', kind: 'heading', text: 'A title. With punctuation.' }),
			block({ id: 'list', kind: 'list-item', text: 'One useful item. Still one unit.' })
		]);
		expect(segments).toHaveLength(2);
		expect(segments[0].blockId).toBe('heading');
		expect(segments[1].text).toContain('Still one unit');
	});

	it('skips non-speaking content and code unless enabled', () => {
		const code = block({ kind: 'code', text: 'const answer = 42;', speak: false });
		const silent = block({ id: 'silent', speak: false });
		expect(segmentBlocks([code, silent])).toEqual([]);
		expect(segmentBlocks([code], true)).toHaveLength(1);
	});

	it('splits unusually long sentences at clause boundaries', () => {
		const firstClause = 'A'.repeat(170);
		const secondClause = 'B'.repeat(160);
		const segments = segmentBlocks([block({ text: `${firstClause}, ${secondClause}.` })]);
		expect(segments).toHaveLength(2);
		expect(segments[0].text.endsWith(',')).toBe(true);
		expect(segments.every((segment) => segment.text.length <= MAX_SEGMENT_CHARS)).toBe(true);
		expect(segmentBlocks([block({ text: 'X'.repeat(900) })])).toHaveLength(4);
	});

	it('refreshes oversized stored passages and preserves semantic anchors', () => {
		const blocks = [block({ text: `${'Alpha '.repeat(60)}, ${'Beta '.repeat(60)}.` })];
		const oldSegments = segmentBlocks(blocks)
			.map((segment, index, all) =>
				index === 0
					? {
							...segment,
							id: 'b0:s0',
							text: all.map((part) => part.text).join(' '),
							normalizedText: all.map((part) => part.normalizedText).join(' '),
							end: blocks[0].text.length,
							words: wordsFor(blocks[0].text)
						}
					: segment
			)
			.slice(0, 1);
		const document = {
			id: 'doc',
			fingerprint: 'hash',
			title: 'Book',
			sourceName: 'book.md',
			sourceKind: 'markdown',
			mimeType: 'text/markdown',
			language: 'en',
			createdAt: 1,
			updatedAt: 1,
			blocks,
			segments: oldSegments,
			outline: [],
			playback: { segmentId: 'b0:s0', wordIndex: 45, offset: 10, updatedAt: 1 },
			warnings: [],
			includeCode: false
		} satisfies NormalizedDocument;

		const refreshed = refreshDocumentSegments(document);
		expect(refreshed).not.toBe(document);
		expect(refreshed.segments.length).toBeGreaterThan(1);
		expect(refreshed.segments.every((segment) => segment.text.length <= MAX_SEGMENT_CHARS)).toBe(
			true
		);
		expect(refreshed.segments.some((segment) => segment.id === refreshed.playback?.segmentId)).toBe(
			true
		);
	});

	it('maps word offsets and includes punctuation pauses in estimates', () => {
		expect(wordsFor("Voicebook's calm reader")).toEqual([
			{ text: "Voicebook's", start: 0, end: 11 },
			{ text: 'calm', start: 12, end: 16 },
			{ text: 'reader', start: 17, end: 23 }
		]);
		expect(estimateDuration('One, two.')).toBeGreaterThan(estimateDuration('One two'));
	});

	it('falls back to regular expressions when Intl.Segmenter is unavailable', () => {
		const original = Intl.Segmenter;
		Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });
		try {
			expect(segmentBlocks([block({ text: 'Fallback one. Fallback two?' })])).toHaveLength(2);
			expect(wordsFor("Fallback reader's test")).toEqual([
				{ text: 'Fallback', start: 0, end: 8 },
				{ text: "reader's", start: 9, end: 17 },
				{ text: 'test', start: 18, end: 22 }
			]);
		} finally {
			Object.defineProperty(Intl, 'Segmenter', { value: original, configurable: true });
		}
	});
});

describe('narrated construct segmentation', () => {
	const mathBlock = block({ id: 'b1', kind: 'math', text: '\\int_0^1 x^2 dx', speak: false });

	function readyEntry(constructId: string, text: string, source: string): NarrationEntry {
		return {
			constructId,
			kind: 'math-block',
			status: 'ready',
			text,
			sourceHash: hashNarrationSource('math-block', source),
			promptVersion: 1,
			updatedAt: 1
		};
	}

	it('speaks the deterministic reading for math blocks and marks pending entries', () => {
		const plain = segmentBlocks([mathBlock]);
		expect(plain).toHaveLength(1);
		expect(plain[0]).toMatchObject({
			id: 'b1:n0',
			text: 'The integral from zero to one of x squared d x.',
			narration: { constructIds: ['b1'], kind: 'construct', pending: false }
		});

		const pending = segmentBlocks([mathBlock], false, {
			b1: { ...readyEntry('b1', '', mathBlock.text), status: 'pending', text: undefined }
		});
		expect(pending[0].narration?.pending).toBe(true);
	});

	it('swaps in ready narration text under stable chunk ids', () => {
		const narrated = segmentBlocks([mathBlock], false, {
			b1: readyEntry('b1', 'The integral from zero to one of x squared.', mathBlock.text)
		});
		expect(narrated[0].id).toBe('b1:n0');
		expect(narrated[0].normalizedText).toBe('The integral from zero to one of x squared.');
		expect(narrated[0].narration?.pending).toBe(false);
	});

	it('chunks long narrations into multiple segments over the block range', () => {
		const long = `${'alpha beta gamma, '.repeat(30)}the end.`;
		const segments = segmentBlocks([mathBlock], false, {
			b1: readyEntry('b1', long, mathBlock.text)
		});
		expect(segments.length).toBeGreaterThan(1);
		expect(segments.map((s) => s.id)).toEqual(segments.map((_, i) => `b1:n${i}`));
		expect(segments.every((s) => s.normalizedText.length <= MAX_SEGMENT_CHARS)).toBe(true);
		expect(segments[0].start).toBe(0);
		expect(segments.at(-1)!.end).toBe(mathBlock.text.length);
		// Monotonic subdivision keeps position remapping sane.
		for (let i = 1; i < segments.length; i += 1) {
			expect(segments[i].start).toBeGreaterThanOrEqual(segments[i - 1].start);
		}
	});

	it('narrates tables as a header announcement plus per-row segments', () => {
		const cell = (text: string) => ({ text, inlines: [] });
		const table = block({
			id: 'b2',
			kind: 'table',
			text: 'Name, Age. Alice, 30. Bob, 41',
			table: {
				align: [],
				header: [cell('Name'), cell('Age')],
				rows: [
					[cell('Alice'), cell('30')],
					[cell('Bob'), cell('41')]
				]
			}
		});
		const segments = segmentBlocks([table]);
		expect(segments.map((s) => s.id)).toEqual(['b2:rh:n0', 'b2:r0:n0', 'b2:r1:n0']);
		expect(segments[0].text).toBe('A table with columns: Name, Age.');
		expect(segments[1].text).toBe('Name: Alice. Age: 30.');
		expect(segments[2].text).toBe('Name: Bob. Age: 41.');
		// Row segments anchor to the row's range inside the flattened text.
		expect(table.text.slice(segments[1].start, segments[1].end)).toBe('Alice, 30');
		expect(segments[1].narration).toMatchObject({
			constructIds: ['b2:r0'],
			constructKind: 'table-row',
			pending: false
		});
	});

	it('substitutes inline math in spoken text while keeping display offsets', () => {
		const paragraph = block({
			id: 'b3',
			text: 'The bound is \\sum_{i=0}^{n} x_i for all n. Plain sentence.',
			inlines: [
				{ text: 'The bound is ' },
				{ text: '\\sum_{i=0}^{n} x_i', math: true },
				{ text: ' for all n. Plain sentence.' }
			]
		});
		const segments = segmentBlocks([paragraph]);
		expect(segments).toHaveLength(2);
		// Display slice is untouched; spoken text gets the exact reading.
		expect(segments[0].text).toContain('\\sum');
		expect(segments[0].normalizedText).toBe(
			'The bound is the sum from i equals zero to n of x sub i for all n.'
		);
		expect(segments[0].narration).toMatchObject({ kind: 'inline' });
		// One word entry per SPOKEN word, each carrying a display range: the
		// plain words map to themselves…
		const words = segments[0].words;
		expect(words.map((word) => word.text).join(' ')).toBe(
			'The bound is the sum from i equals zero to n of x sub i for all n'
		);
		const the = words[0];
		expect(segments[0].text.slice(the.start, the.end)).toBe('The');
		// …and every word of the reading lights up the whole math span.
		const mathStart = segments[0].text.indexOf('\\sum');
		const mathEnd = mathStart + '\\sum_{i=0}^{n} x_i'.length;
		const readingWords = words.filter((word) => word.text === 'sum' || word.text === 'zero');
		expect(readingWords).toHaveLength(2);
		for (const word of readingWords) {
			expect(word.start).toBe(mathStart);
			expect(word.end).toBe(mathEnd);
		}
		// Untouched sentences in the same block keep their plain word map.
		expect(segments[1].narration).toBeUndefined();
		expect(segments[1].words.length).toBeGreaterThan(0);
	});

	it('leaves sentences with single-letter math as plain word-highlighted text', () => {
		const paragraph = block({
			id: 'b4',
			text: 'The probability p decays with n steps.',
			inlines: [
				{ text: 'The probability ' },
				{ text: 'p', math: true },
				{ text: ' decays with ' },
				{ text: 'n', math: true },
				{ text: ' steps.' }
			]
		});
		const segments = segmentBlocks([paragraph]);
		expect(segments[0].normalizedText).toBe('The probability p decays with n steps.');
		expect(segments[0].words.length).toBeGreaterThan(0);
		expect(segments[0].narration).toBeUndefined();
	});

	it('compares segments by id, spoken text, and pending state', () => {
		const a = segmentBlocks([mathBlock]);
		const b = segmentBlocks([mathBlock]);
		expect(segmentsEqual(a, b)).toBe(true);
		const swapped = segmentBlocks([mathBlock], false, {
			b1: readyEntry('b1', 'Something new.', mathBlock.text)
		});
		expect(segmentsEqual(a, swapped)).toBe(false);
	});

	it('refreshes segments when narrations arrive and remaps positions', () => {
		const blocks = [
			block({ id: 'b0', text: 'Intro sentence.' }),
			mathBlock,
			block({ id: 'b5', text: 'Outro sentence.' })
		];
		const before = segmentBlocks(blocks);
		const document = {
			id: 'doc',
			fingerprint: 'hash',
			title: 'Book',
			sourceName: 'book.md',
			sourceKind: 'markdown',
			mimeType: 'text/markdown',
			language: 'en',
			createdAt: 1,
			updatedAt: 1,
			blocks,
			segments: before,
			outline: [],
			playback: { segmentId: 'b5:s0', wordIndex: 0, offset: 0, updatedAt: 1 },
			narrations: {
				b1: readyEntry('b1', 'The integral from zero to one of x squared.', mathBlock.text)
			},
			warnings: [],
			includeCode: false
		} satisfies NormalizedDocument;

		const refreshed = refreshDocumentSegments(document);
		expect(refreshed).not.toBe(document);
		expect(refreshed.segments.find((s) => s.id === 'b1:n0')?.normalizedText).toBe(
			'The integral from zero to one of x squared.'
		);
		// Playback position in an unrelated block survives.
		expect(refreshed.playback?.segmentId).toBe('b5:s0');

		// A second refresh with identical narrations is a no-op.
		expect(refreshDocumentSegments(refreshed)).toBe(refreshed);
	});
});
