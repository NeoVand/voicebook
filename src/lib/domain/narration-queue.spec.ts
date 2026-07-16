import { describe, expect, it } from 'vitest';
import { blockPositions, documentContextFor, prioritizeQueue } from './narration-queue';
import { hashNarrationSource, type NarrationConstruct } from './narration';
import type { DocumentBlock } from './types';

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

	it('collects preceding prose, skipping non-prose blocks', () => {
		const context = documentContextFor(blocks, construct('b3', 'b3'));
		expect(context).toBe('Losses The loss combines a data term with a ridge penalty:');
	});

	it('trims to the limit from the end (nearest text wins)', () => {
		const context = documentContextFor(blocks, construct('b3', 'b3'), { before: 20, after: 0 });
		expect(context.length).toBeLessThanOrEqual(20);
		expect(context.endsWith('penalty:')).toBe(true);
	});

	it('appends the prose following a display equation (symbol definitions)', () => {
		const withFollowing = [
			...blocks,
			makeBlock('b4', 'paragraph', 'where the discount factor gamma controls future reward.')
		];
		const context = documentContextFor(withFollowing, construct('b3', 'b3'));
		expect(context).toContain('ridge penalty');
		expect(context).toContain('where the discount factor gamma controls');
	});

	it('returns empty for an unknown block', () => {
		expect(documentContextFor(blocks, construct('b9', 'b9'))).toBe('');
	});
});
