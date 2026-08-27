import { describe, expect, it } from 'vitest';
import {
	alignWordStreams,
	chunkText,
	matchKey,
	mergeWordRects,
	pageWordBoxes,
	placeSegments,
	segmentsForPage,
	type PageWordBox,
	type PlaceableSegment
} from './pdf-layout';
import type { SpeechSegment } from './types';

/** Word boxes for a run of words laid out on one line, 10pt apart per
 * character — enough geometry for the merge and hit-test rules to bite. */
function line(text: string, y: number, startX = 0): PageWordBox[] {
	const boxes: PageWordBox[] = [];
	let x = startX;
	for (const word of text.split(' ')) {
		boxes.push({ text: word, x, y, width: word.length * 10, height: 12 });
		x += word.length * 10 + 5;
	}
	return boxes;
}

function words(text: string): Array<{ text: string; start: number; end: number }> {
	return [...text.matchAll(/\S+/g)].map((match) => ({
		text: match[0],
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length
	}));
}

function placeable(id: string, text: string, extra: Partial<PlaceableSegment> = {}) {
	return { id, text, words: words(text), page: 1, ...extra };
}

describe('matchKey', () => {
	it('folds the differences between a page and its extraction', () => {
		expect(matchKey('Attention,')).toBe('attention');
		// The page sets a ligature where the markdown carries two letters.
		expect(matchKey('ﬁgures')).toBe(matchKey('figures'));
		expect(matchKey('Café')).toBe('cafe');
		expect(matchKey('“quoted”')).toBe('quoted');
	});

	it('is empty for text carrying no letters or digits', () => {
		expect(matchKey('—')).toBe('');
		expect(matchKey('·')).toBe('');
	});
});

describe('pageWordBoxes', () => {
	it('drops rotated stamps, which are not prose', () => {
		const boxes = pageWordBoxes([
			{ text: 'arXiv:1706', x: 14, y: 380, width: 22, height: 160, rotation: 270 },
			{ text: 'Abstract', x: 100, y: 70, width: 50, height: 12, rotation: 0 }
		]);
		expect(boxes.map((box) => box.text)).toEqual(['Abstract']);
	});

	it('falls back to the item box when a parse emitted no word boxes', () => {
		const boxes = pageWordBoxes([
			{ text: 'one two', x: 10, y: 20, width: 60, height: 12 },
			{ text: '   ', x: 10, y: 40, width: 5, height: 12 }
		]);
		expect(boxes).toEqual([{ text: 'one two', x: 10, y: 20, width: 60, height: 12 }]);
	});

	it('prefers word boxes when the parse emitted them', () => {
		const boxes = pageWordBoxes([
			{
				text: 'one two',
				x: 10,
				y: 20,
				width: 60,
				height: 12,
				words: [
					{ text: 'one', x: 10, y: 20, width: 25, height: 12 },
					{ text: 'two', x: 40, y: 20, width: 25, height: 12 }
				]
			}
		]);
		expect(boxes.map((box) => box.text)).toEqual(['one', 'two']);
	});
});

describe('chunkText', () => {
	it('keys whitespace-separated chunks and remembers where they came from', () => {
		expect(chunkText('The Transformer, again')).toEqual([
			{ key: 'the', start: 0, end: 3 },
			{ key: 'transformer', start: 4, end: 16 },
			{ key: 'again', start: 17, end: 22 }
		]);
	});

	it('drops chunks that carry no evidence', () => {
		expect(chunkText('a — b').map((chunk) => chunk.key)).toEqual(['a', 'b']);
	});
});

describe('alignWordStreams', () => {
	it('maps each expected word onto the page word it came from', () => {
		const alignment = alignWordStreams(
			['the', 'dominant', 'sequence', 'transduction', 'models'],
			['dominant', 'sequence', 'transduction']
		);
		expect([...alignment]).toEqual([1, 2, 3]);
	});

	it('skips page words the spoken layer never says', () => {
		const alignment = alignWordStreams(
			['figure', '1', 'the', 'transformer', 'model', 'architecture'],
			['the', 'transformer']
		);
		expect([...alignment]).toEqual([2, 3]);
	});

	it('reports nothing for expected words the page does not have', () => {
		const alignment = alignWordStreams(['alpha', 'gamma'], ['alpha', 'beta', 'gamma']);
		expect([...alignment]).toEqual([0, -1, 1]);
	});

	it('accepts the fragment a hyphenated line break leaves behind', () => {
		const alignment = alignWordStreams(
			['achieves', 'englishto', 'translation'],
			['achieves', 'englishtogerman', 'translation']
		);
		expect([...alignment]).toEqual([0, 1, 2]);
	});

	it('resumes after a long stretch that belongs to only one side', () => {
		// The page's table, which the spoken layer narrates in its own words —
		// charged per word, this gap would end the alignment here.
		const page = [
			'opening',
			'sentence',
			...Array.from({ length: 60 }, (_, index) => `cell${index}`),
			'closing',
			'sentence'
		];
		const alignment = alignWordStreams(page, ['opening', 'sentence', 'closing', 'sentence']);
		expect([...alignment]).toEqual([0, 1, 62, 63]);
	});

	it('never reorders: a repeated phrase matches the run in sequence', () => {
		const alignment = alignWordStreams(['a', 'b', 'a', 'b'], ['a', 'b']);
		for (let index = 1; index < alignment.length; index += 1) {
			expect(alignment[index]).toBeGreaterThan(alignment[index - 1]);
		}
	});

	it('gives up rather than guessing on an oversized page', () => {
		const huge = Array.from({ length: 2100 }, (_, index) => `w${index}`);
		expect([...alignWordStreams(huge, huge)].every((value) => value === -1)).toBe(true);
	});
});

describe('mergeWordRects', () => {
	it('merges a run of boxes on one line into a single rectangle', () => {
		const boxes = line('one two three', 100);
		const last = boxes[boxes.length - 1];
		expect(mergeWordRects(boxes)).toEqual([
			{ x: 0, y: 100, width: last.x + last.width, height: 12 }
		]);
	});

	it('starts a new rectangle on the next line', () => {
		const merged = mergeWordRects([...line('one two', 100), ...line('three', 120)]);
		expect(merged).toHaveLength(2);
		expect(merged[1]).toEqual({ x: 0, y: 120, width: 50, height: 12 });
	});

	it('breaks at a column jump rather than sweeping across the gutter', () => {
		const merged = mergeWordRects([
			{ x: 40, y: 100, width: 40, height: 12 },
			{ x: 300, y: 100, width: 40, height: 12 },
			{ x: 40, y: 100, width: 40, height: 12 }
		]);
		expect(merged).toHaveLength(2);
	});
});

describe('placeSegments', () => {
	const page = [
		...line('The dominant sequence transduction models are based on', 100),
		...line('complex recurrent or convolutional neural networks.', 120),
		...line('We propose a new simple network architecture.', 140)
	];

	it('places a passage over the words it was extracted from', () => {
		const [placement] = placeSegments(
			page,
			[placeable('s1', 'We propose a new simple network architecture.')],
			1
		);
		expect(placement.segmentId).toBe('s1');
		expect(placement.coverage).toBe(1);
		const third = line('We propose a new simple network architecture.', 140);
		const last = third[third.length - 1];
		expect(placement.rects).toEqual([{ x: 0, y: 140, width: last.x + last.width, height: 12 }]);
	});

	it('boxes each word of the passage separately', () => {
		const [placement] = placeSegments(page, [placeable('s1', 'We propose a new')], 1);
		expect(placement.wordRects.map((rect) => rect?.x)).toEqual(
			line('We propose a new', 140).map((box) => box.x)
		);
	});

	it('leaves a hole for a word the page does not carry', () => {
		const [placement] = placeSegments(page, [placeable('s1', 'We hereby propose a new')], 1);
		expect(placement.wordRects[1]).toBeUndefined();
		expect(placement.wordRects[0]).toBeDefined();
		expect(placement.wordRects[2]).toBeDefined();
	});

	it('refuses a passage that only brushed the page', () => {
		expect(
			placeSegments(page, [placeable('s1', 'Entirely unrelated prose about a cat')], 1)
		).toEqual([]);
	});

	it('keeps passages in document order across the page', () => {
		const placements = placeSegments(
			page,
			[
				placeable('s1', 'The dominant sequence transduction models'),
				placeable('s2', 'We propose a new simple network architecture.')
			],
			1
		);
		expect(placements.map((placement) => placement.segmentId)).toEqual(['s1', 's2']);
		expect(placements[0].rects[0].y).toBeLessThan(placements[1].rects[0].y);
	});

	it('looks for what the page prints when that differs from what is spoken', () => {
		const table = [
			...line('Layer Type Complexity per Layer', 200),
			...line('Self-Attention Onnd Restricted', 220)
		];
		// The row is narrated with its header labels folded in; only its cells
		// are on the page.
		const spoken = 'Layer Type: Self-Attention. Complexity per Layer: Onnd.';
		// Spoken as-is, the header labels pull the row up onto the header line.
		const [narrated] = placeSegments(table, [placeable('row', spoken)], 1);
		expect(narrated.rects[0].y).toBe(200);
		const [placement] = placeSegments(
			table,
			[placeable('row', spoken, { matchText: 'Self-Attention Onnd Restricted' })],
			1
		);
		expect(placement.rects[0].y).toBe(220);
		// The words being spoken are not the words on the page.
		expect(placement.wordRects.every((rect) => rect === undefined)).toBe(true);
	});

	it('finds a run of rows once its neighbours have staked out the region', () => {
		const withTable = [
			...line('Opening sentence above the table', 100),
			...line('Alpha ninety Beta eighty', 130),
			...line('Gamma seventy Delta sixty', 150),
			...line('Closing sentence below the table', 180)
		];
		const placements = placeSegments(
			withTable,
			[
				placeable('s1', 'Opening sentence above the table'),
				placeable('r1', 'Alpha ninety Beta eighty'),
				placeable('r2', 'Gamma seventy Delta sixty'),
				placeable('s2', 'Closing sentence below the table')
			],
			1
		);
		expect(placements.map((placement) => placement.segmentId)).toEqual(['s1', 'r1', 'r2', 's2']);
		expect(placements[1].rects[0].y).toBe(130);
		expect(placements[2].rects[0].y).toBe(150);
	});

	it('has nothing to say about a page with no words', () => {
		expect(placeSegments([], [placeable('s1', 'anything')], 1)).toEqual([]);
	});
});

describe('segmentsForPage', () => {
	function segment(id: string, text: string, page: number, blockId = 'b1'): SpeechSegment {
		return {
			id,
			blockId,
			text,
			normalizedText: text,
			start: 0,
			end: text.length,
			words: words(text),
			estimatedDuration: 1,
			anchor: { page }
		};
	}

	it('is empty when nothing is anchored to the page', () => {
		expect(segmentsForPage([segment('s1', 'one', 1)], 4)).toEqual([]);
	});

	it('reaches into the neighbouring pages for passages that straddle the break', () => {
		const segments = [
			segment('before', 'a sentence ending the previous page', 1),
			segment('own', 'a sentence of its own', 2),
			segment('after', 'a sentence opening the next page', 3)
		];
		expect(segmentsForPage(segments, 2).map((entry) => entry.id)).toEqual([
			'before',
			'own',
			'after'
		]);
	});

	it('stops spilling once the word budget runs out', () => {
		const long = Array.from({ length: 80 }, (_, index) =>
			segment(`p1-${index}`, 'ten words here that fill up the spill budget fast', 1)
		);
		const ids = segmentsForPage([...long, segment('own', 'the page itself', 2)], 2).map(
			(entry) => entry.id
		);
		expect(ids).toContain('own');
		expect(ids).not.toContain('p1-0');
	});

	it('carries the construct source through as what to look for on the page', () => {
		const row = segment('row', 'Layer Type: Self-Attention.', 2);
		row.start = 4;
		row.end = 22;
		const placeables = segmentsForPage([row], 2, new Map([['b1', 'xxx Self-Attention Onnd xxx']]));
		expect(placeables[0].matchText).toBe('Self-Attention Onn');
	});

	it('leaves plain prose alone, so its words keep their boxes', () => {
		const prose = segment('prose', 'a sentence of its own', 2);
		const placeables = segmentsForPage([prose], 2, new Map([['b1', 'a sentence of its own']]));
		expect(placeables[0].matchText).toBeUndefined();
	});
});
