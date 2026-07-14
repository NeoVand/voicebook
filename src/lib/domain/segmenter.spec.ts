import { describe, expect, it } from 'vitest';
import {
	estimateDuration,
	MAX_SEGMENT_CHARS,
	normalizeForSpeech,
	refreshDocumentSegments,
	segmentBlocks,
	wordsFor
} from './segmenter';
import type { DocumentBlock, NormalizedDocument } from './types';

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
	it('normalizes spacing and speaks URL hosts instead of paths', () => {
		expect(normalizeForSpeech(' Read   https://www.example.com/deep/path now. ')).toBe(
			'Read example.com now.'
		);
		expect(normalizeForSpeech('Read http://% now')).toBe('Read link now');
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
			bookmarks: [
				{
					id: 'mark',
					documentId: 'doc',
					segmentId: 'b0:s0',
					wordIndex: 45,
					excerpt: 'Alpha',
					label: 'Alpha',
					note: '',
					createdAt: 1
				}
			],
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
		expect(refreshed.playback?.segmentId).toBe(refreshed.bookmarks[0].segmentId);
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
