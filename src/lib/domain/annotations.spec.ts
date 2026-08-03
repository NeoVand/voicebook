import { describe, expect, it } from 'vitest';
import type { DocumentAnnotation, DocumentBlock, NormalizedDocument, SpeechSegment } from './types';
import { annotationForRange, annotationSegments, rescueAnnotations } from './annotations';

function block(id: string, text: string, kind: DocumentBlock['kind'] = 'paragraph'): DocumentBlock {
	return { id, kind, text, speak: true, anchor: {} };
}

/** Segments a block's text on '. ' boundaries with true char offsets, the way
 * the segmenter would. */
function segmentize(target: DocumentBlock): SpeechSegment[] {
	const parts = target.text.split(/(?<=\.)\s+/);
	const segments: SpeechSegment[] = [];
	let cursor = 0;
	parts.forEach((part, index) => {
		const start = target.text.indexOf(part, cursor);
		const end = start + part.length;
		cursor = end;
		segments.push({
			id: `${target.id}:s${index}`,
			blockId: target.id,
			text: part,
			normalizedText: part,
			start,
			end,
			words: [],
			estimatedDuration: 1,
			anchor: {}
		});
	});
	return segments;
}

function doc(blocks: DocumentBlock[]): NormalizedDocument {
	return {
		id: 'doc',
		fingerprint: 'f',
		title: 'Whale Song',
		sourceName: 'whales.md',
		sourceKind: 'markdown',
		mimeType: 'text/markdown',
		language: 'en',
		createdAt: 0,
		updatedAt: 0,
		blocks,
		segments: blocks.flatMap(segmentize),
		outline: [],
		warnings: [],
		includeCode: false
	};
}

const whaleDoc = () =>
	doc([
		block('b0', 'Whale Song', 'heading'),
		block('b1', 'Whales sing across ocean basins. Their songs travel for thousands of miles.'),
		block('b2', 'Humpbacks migrate toward the poles each summer. Calves follow their mothers.')
	]);

describe('annotationForRange', () => {
	it('snaps a single segment to its block character range', () => {
		const book = whaleDoc();
		const annotation = annotationForRange(
			book,
			{ startIndex: 2, endIndex: 2 },
			{
				createdBy: 'reader'
			}
		);
		expect(annotation).toMatchObject({
			start: { blockId: 'b1', offset: 33 },
			end: { blockId: 'b1', offset: 75 },
			excerpt: 'Their songs travel for thousands of miles.',
			createdBy: 'reader'
		});
		expect(annotation?.note).toBeUndefined();
	});

	it('spans blocks and keeps a note, trimmed', () => {
		const book = whaleDoc();
		const annotation = annotationForRange(
			book,
			{ startIndex: 1, endIndex: 3 },
			{
				createdBy: 'assistant',
				note: '  Compare with sonar section  '
			}
		);
		expect(annotation).toMatchObject({
			start: { blockId: 'b1', offset: 0 },
			end: { blockId: 'b2', offset: 47 },
			note: 'Compare with sonar section'
		});
		expect(annotation?.excerpt).toContain('Whales sing');
		expect(annotation?.excerpt).toContain('poles each summer.');
	});

	it('clamps runaway excerpts around a marker', () => {
		const long = `${'Verse of the deep sea choir continues without pause. '.repeat(20)}It ends here.`;
		const book = doc([block('b0', long)]);
		const range = { startIndex: 0, endIndex: book.segments.length - 1 };
		const annotation = annotationForRange(book, range, { createdBy: 'reader' });
		expect(annotation?.excerpt.length).toBeLessThanOrEqual(400);
		expect(annotation?.excerpt).toContain('…');
		expect(annotation?.excerpt.endsWith('It ends here.')).toBe(true);
	});

	it('returns undefined for an unresolvable range', () => {
		const book = whaleDoc();
		expect(
			annotationForRange(book, { startIndex: 90, endIndex: 91 }, { createdBy: 'reader' })
		).toBeUndefined();
	});
});

describe('annotationSegments', () => {
	it('covers exactly the segments intersecting the anchors', () => {
		const book = whaleDoc();
		const annotation = annotationForRange(
			book,
			{ startIndex: 2, endIndex: 3 },
			{
				createdBy: 'reader'
			}
		)!;
		expect(annotationSegments(book, annotation).map((segment) => segment.id)).toEqual([
			'b1:s1',
			'b2:s0'
		]);
	});

	it('covers every segment of blocks strictly inside the range', () => {
		const book = whaleDoc();
		const annotation = annotationForRange(
			book,
			{ startIndex: 0, endIndex: 4 },
			{
				createdBy: 'reader'
			}
		)!;
		expect(annotationSegments(book, annotation)).toHaveLength(5);
	});

	it('paints nothing for orphaned or unresolvable annotations', () => {
		const book = whaleDoc();
		const annotation = annotationForRange(
			book,
			{ startIndex: 1, endIndex: 1 },
			{
				createdBy: 'reader'
			}
		)!;
		expect(annotationSegments(book, { ...annotation, orphaned: true })).toEqual([]);
		expect(
			annotationSegments(book, { ...annotation, start: { blockId: 'gone', offset: 0 } })
		).toEqual([]);
	});
});

describe('rescueAnnotations', () => {
	const annotate = (book: NormalizedDocument, startIndex: number, endIndex: number) =>
		annotationForRange(book, { startIndex, endIndex }, { createdBy: 'reader' })!;

	it('passes untouched annotations through by identity', () => {
		const book = whaleDoc();
		const annotation = annotate(book, 1, 2);
		const rescued = rescueAnnotations([annotation], book.blocks);
		expect(rescued?.[0]).toBe(annotation);
	});

	it('re-anchors when block ids shift but the text survives', () => {
		const book = whaleDoc();
		const annotation = annotate(book, 3, 3);
		const reparsed = doc([
			block('b0', 'Whale Song', 'heading'),
			block('b1', 'A new editorial preamble arrived in this revision.'),
			block('b2', 'Whales sing across ocean basins. Their songs travel for thousands of miles.'),
			block('b3', 'Humpbacks  migrate\ntoward the poles each summer. Calves follow their mothers.')
		]);
		const rescued = rescueAnnotations([annotation], reparsed.blocks)!;
		expect(rescued[0].orphaned).toBeUndefined();
		expect(rescued[0].start.blockId).toBe('b3');
		expect(annotationSegments(reparsed, rescued[0]).map((segment) => segment.id)).toEqual([
			'b3:s0'
		]);
	});

	it('orphans annotations whose text is gone, and restores them when it returns', () => {
		const book = whaleDoc();
		const annotation = annotate(book, 4, 4);
		const without = doc([block('b0', 'Whale Song', 'heading')]);
		const orphaned = rescueAnnotations([annotation], without.blocks)!;
		expect(orphaned[0].orphaned).toBe(true);
		const restored = rescueAnnotations(orphaned, book.blocks)!;
		expect(restored[0].orphaned).toBeUndefined();
		expect(annotationSegments(book, restored[0]).map((segment) => segment.id)).toEqual(['b2:s1']);
	});

	it('re-anchors a multi-block annotation across shifted block ids', () => {
		const book = whaleDoc();
		const annotation = annotate(book, 1, 4);
		const reparsed = doc([
			block('b0', 'Whale Song', 'heading'),
			block('b1', 'A new editorial preamble arrived in this revision.'),
			block('b2', 'Whales sing across ocean basins. Their songs travel for thousands of miles.'),
			block('b3', 'Humpbacks  migrate\ntoward the poles each summer. Calves follow their mothers.')
		]);
		const rescued = rescueAnnotations([annotation], reparsed.blocks)!;
		expect(rescued[0].orphaned).toBeUndefined();
		expect(rescued[0].start).toMatchObject({ blockId: 'b2', offset: 0 });
		expect(rescued[0].end.blockId).toBe('b3');
		expect(annotationSegments(reparsed, rescued[0])).toHaveLength(4);
	});

	it('orphans a long annotation whose tail text disappeared', () => {
		const book = whaleDoc();
		const annotation = annotate(book, 1, 3);
		const truncated = doc([
			block('b0', 'Whale Song', 'heading'),
			block('b1', 'Whales sing across ocean basins. Their songs travel for thousands of miles.')
		]);
		const rescued = rescueAnnotations([annotation], truncated.blocks)!;
		expect(rescued[0].orphaned).toBe(true);
	});

	it('keeps empty and absent inputs as they are', () => {
		expect(rescueAnnotations(undefined, whaleDoc().blocks)).toBeUndefined();
		const empty: DocumentAnnotation[] = [];
		expect(rescueAnnotations(empty, whaleDoc().blocks)).toBe(empty);
	});
});
