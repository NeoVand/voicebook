import { describe, expect, it } from 'vitest';
import {
	NARRATION_SLOT,
	blockPositions,
	blockTimeline,
	constructsInWindow,
	documentContextFor,
	prioritizeQueue
} from './narration-queue';
import { hashNarrationSource, type NarrationConstruct } from './narration';
import type { DocumentBlock, SpeechSegment } from './types';

function makeBlock(id: string, kind: DocumentBlock['kind'], text: string): DocumentBlock {
	return { id, kind, text, speak: true, anchor: {} };
}

function construct(id: string, blockId: string): NarrationConstruct {
	return {
		id,
		kind: 'math-block',
		blockId,
		source: id,
		sourceHash: hashNarrationSource('math-block', id),
		fallbackText: 'An equation is shown here.'
	};
}

describe('prioritizeQueue', () => {
	const blocks = [
		makeBlock('b0', 'paragraph', 'intro'),
		makeBlock('b1', 'math', 'x'),
		makeBlock('b2', 'paragraph', 'middle'),
		makeBlock('b3', 'math', 'y'),
		makeBlock('b4', 'math', 'z')
	];
	const positions = blockPositions(blocks);
	const queue = [construct('b1', 'b1'), construct('b3', 'b3'), construct('b4', 'b4')];

	it('moves constructs at or after the playhead to the front, stably', () => {
		expect(prioritizeQueue(queue, positions, 'b2').map((c) => c.id)).toEqual(['b3', 'b4', 'b1']);
	});

	it('keeps document order with no playhead or unknown playhead', () => {
		expect(prioritizeQueue(queue, positions, undefined).map((c) => c.id)).toEqual([
			'b1',
			'b3',
			'b4'
		]);
		expect(prioritizeQueue(queue, positions, 'missing').map((c) => c.id)).toEqual([
			'b1',
			'b3',
			'b4'
		]);
	});
});

describe('documentContextFor', () => {
	const blocks = [
		makeBlock('b0', 'heading', 'Losses'),
		makeBlock('b1', 'paragraph', 'The loss combines a data term with a ridge penalty:'),
		makeBlock('b2', 'code', 'ignore me'),
		makeBlock('b3', 'math', '\\sum x')
	];

	it('collects preceding prose around the slot, skipping non-prose blocks', () => {
		const context = documentContextFor(blocks, construct('b3', 'b3'));
		expect(context).toBe(
			`Losses The loss combines a data term with a ridge penalty: ${NARRATION_SLOT}`
		);
	});

	it('trims the preceding prose to its limit (nearest text wins)', () => {
		const context = documentContextFor(blocks, construct('b3', 'b3'), { before: 20, after: 0 });
		const [before] = context.split(NARRATION_SLOT);
		expect(before.trim().length).toBeLessThanOrEqual(20);
		expect(before.trim().endsWith('penalty:')).toBe(true);
	});

	it('puts the following prose after the slot (symbol definitions)', () => {
		const withFollowing = [
			...blocks,
			makeBlock('b4', 'paragraph', 'where the discount factor gamma controls future reward.')
		];
		const context = documentContextFor(withFollowing, construct('b3', 'b3'));
		expect(context).toBe(
			`Losses The loss combines a data term with a ridge penalty: ${NARRATION_SLOT} ` +
				'where the discount factor gamma controls future reward.'
		);
	});

	it('surrounds every construct kind, not only equations', () => {
		const withFollowing = [
			...blocks,
			makeBlock('b4', 'paragraph', 'Larger models score higher across the board.')
		];
		const row: NarrationConstruct = { ...construct('b2', 'b2'), kind: 'table-row' };
		const context = documentContextFor(withFollowing, row);
		expect(context).toContain(NARRATION_SLOT);
		expect(context).toContain('Larger models score higher');
	});

	it('returns empty for an unknown block', () => {
		expect(documentContextFor(blocks, construct('b9', 'b9'))).toBe('');
	});
});

function passage(id: string, blockId: string, estimatedDuration: number): SpeechSegment {
	return {
		id,
		blockId,
		text: id,
		normalizedText: id,
		start: 0,
		end: id.length,
		words: [],
		estimatedDuration,
		anchor: {}
	};
}

describe('blockTimeline', () => {
	it('places each block at the listening time of its first passage', () => {
		const blocks = [
			makeBlock('a', 'paragraph', 'a'),
			makeBlock('figure', 'paragraph', ''),
			makeBlock('b', 'math', 'x'),
			makeBlock('c', 'paragraph', 'c')
		];
		const timeline = blockTimeline(blocks, [
			passage('a:0', 'a', 10),
			passage('a:1', 'a', 5),
			passage('b:0', 'b', 4),
			passage('c:0', 'c', 6)
		]);
		expect(timeline.get('a')).toBe(0);
		expect(timeline.get('b')).toBe(15);
		expect(timeline.get('c')).toBe(19);
		// No passages of its own: it sits where the block before it does.
		expect(timeline.get('figure')).toBe(0);
	});
});

describe('constructsInWindow', () => {
	// Ten equations a minute of listening apart: b0 at 0 s … b9 at 540 s.
	const blocks = Array.from({ length: 10 }, (_, index) => makeBlock(`b${index}`, 'math', 'x'));
	const timeline = blockTimeline(
		blocks,
		blocks.map((block) => passage(`${block.id}:0`, block.id, 60))
	);
	const all = blocks.map((block) => construct(block.id, block.id));
	const ids = (list: NarrationConstruct[]) => list.map((item) => item.id);

	it('takes only what is within reach of the reader, nearest first', () => {
		const picked = constructsInWindow(all, timeline, {
			focusBlockIds: ['b4'],
			aheadSeconds: 150,
			behindSeconds: 60
		});
		// b4–b6 lie ahead; b3 is a minute behind and ranks after them.
		expect(ids(picked)).toEqual(['b4', 'b5', 'b6', 'b3']);
	});

	it('starts at the top when nothing is known about the reader', () => {
		const picked = constructsInWindow(all, timeline, {
			focusBlockIds: ['unknown'],
			aheadSeconds: 90,
			behindSeconds: 0
		});
		expect(ids(picked)).toEqual(['b0', 'b1']);
	});

	it('joins the windows of the playhead and the passage on screen', () => {
		const picked = constructsInWindow(all, timeline, {
			focusBlockIds: ['b1', 'b8'],
			aheadSeconds: 60,
			behindSeconds: 0
		});
		expect(ids(picked)).toEqual(['b1', 'b8', 'b2', 'b9']);
	});

	it('skips constructs whose block is not in the document', () => {
		const picked = constructsInWindow([construct('gone', 'missing'), ...all], timeline, {
			focusBlockIds: ['b0'],
			aheadSeconds: 0,
			behindSeconds: 0
		});
		expect(ids(picked)).toEqual(['b0']);
	});
});
