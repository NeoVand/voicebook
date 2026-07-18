import { describe, expect, it } from 'vitest';
import type { DocumentBlock, SpeechSegment } from './types';
import { blockForPage, pageCount, pageForSegmentIndex, pageStartMap } from './pages';

function block(id: string, page?: number, parentId?: string): DocumentBlock {
	return {
		id,
		kind: 'paragraph',
		text: id,
		anchor: page === undefined ? {} : { page },
		speak: true,
		...(parentId ? { parentId } : {})
	} as DocumentBlock;
}

function segment(id: string, page?: number): SpeechSegment {
	return {
		id,
		blockId: id,
		text: id,
		normalizedText: id,
		start: 0,
		end: 1,
		words: [],
		estimatedDuration: 1,
		anchor: page === undefined ? {} : { page }
	};
}

describe('pageStartMap', () => {
	it('marks the first top-level block of each new page, tolerating gaps', () => {
		const starts = pageStartMap([
			block('b0', 1),
			block('b1', 1),
			block('b2', 2),
			block('b3'),
			block('b4', 5)
		]);
		expect([...starts.entries()]).toEqual([
			['b0', 1],
			['b2', 2],
			['b4', 5]
		]);
	});

	it('ignores decreasing pages and child blocks', () => {
		const starts = pageStartMap([
			block('b0', 2),
			block('b1', 1),
			block('b2', 3, 'b0'),
			block('b3', 3)
		]);
		expect([...starts.keys()]).toEqual(['b0', 'b3']);
	});

	it('is empty for documents without page anchors', () => {
		expect(pageStartMap([block('b0'), block('b1')]).size).toBe(0);
	});
});

describe('pageCount', () => {
	it('returns the highest page or undefined', () => {
		expect(pageCount([block('b0', 1), block('b1', 7), block('b2', 3)])).toBe(7);
		expect(pageCount([block('b0')])).toBeUndefined();
	});
});

describe('blockForPage', () => {
	const blocks = [block('b0', 1), block('b1', 2), block('b2', 4), block('b3', 4)];

	it('finds the first block at the page', () => {
		expect(blockForPage(blocks, 2)?.id).toBe('b1');
	});

	it('lands on the next page across gaps and clamps out-of-range targets', () => {
		expect(blockForPage(blocks, 3)?.id).toBe('b2');
		expect(blockForPage(blocks, 99)?.id).toBe('b2');
		expect(blockForPage(blocks, -5)?.id).toBe('b0');
	});

	it('returns undefined for unpaged documents', () => {
		expect(blockForPage([block('b0')], 1)).toBeUndefined();
	});
});

describe('pageForSegmentIndex', () => {
	const segments = [segment('s0', 1), segment('s1'), segment('s2', 3), segment('s3')];

	it('reads the segment anchor directly', () => {
		expect(pageForSegmentIndex(segments, 2)).toBe(3);
	});

	it('backfills from the nearest earlier paged segment', () => {
		expect(pageForSegmentIndex(segments, 1)).toBe(1);
		expect(pageForSegmentIndex(segments, 3)).toBe(3);
	});

	it('clamps past-the-end indexes and handles unpaged documents', () => {
		expect(pageForSegmentIndex(segments, 99)).toBe(3);
		expect(pageForSegmentIndex([segment('s0')], 0)).toBeUndefined();
		expect(pageForSegmentIndex([], 0)).toBeUndefined();
	});
});
