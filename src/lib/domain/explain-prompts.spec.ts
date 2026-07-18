import { describe, expect, it } from 'vitest';
import {
	assembleExplainContext,
	buildExplainMessages,
	DEFAULT_EXPLAIN_PROMPT,
	sanitizeExplanation
} from './explain-prompts';
import type { DocumentBlock } from './types';

function block(id: string, text: string): DocumentBlock {
	return { id, kind: 'paragraph', text, speak: true, anchor: {} };
}

describe('assembleExplainContext', () => {
	const blocks = [
		block('b0', 'The introduction sets the stage.'),
		block('b1', 'The selected passage lives here.'),
		block('b2', 'A follow-up paragraph continues the thought.'),
		block('b3', 'The conclusion wraps everything up.')
	];

	it('includes the selection blocks and their neighbors', () => {
		const context = assembleExplainContext(blocks, 'b1', 'b1');
		expect(context.before).toContain('The introduction sets the stage.');
		expect(context.before).toContain('The selected passage lives here.');
		expect(context.after).toContain('A follow-up paragraph continues the thought.');
	});

	it('spans multi-block selections without repeating the middle', () => {
		const context = assembleExplainContext(blocks, 'b1', 'b2');
		expect(context.before).toContain('The selected passage lives here.');
		expect(context.after).not.toContain('A follow-up paragraph continues the thought.');
		expect(context.after).toContain('The conclusion wraps everything up.');
	});

	it('clips long context at word boundaries', () => {
		const long = Array.from({ length: 400 }, (_, index) => `word${index}`).join(' ');
		const context = assembleExplainContext(
			[block('b0', long), block('b1', 'Selected.'), block('b2', long)],
			'b1',
			'b1'
		);
		expect(context.before.length).toBeLessThanOrEqual(1200);
		expect(context.after.length).toBeLessThanOrEqual(400);
		expect(context.before.startsWith('word')).toBe(true);
		expect(context.after.endsWith('Selected.')).toBe(false);
		expect(/\S+$/.exec(context.after)?.[0]).toMatch(/^word\d+$/);
	});

	it('returns empty context for unknown blocks', () => {
		expect(assembleExplainContext(blocks, 'missing', 'b1')).toEqual({ before: '', after: '' });
	});
});

describe('buildExplainMessages', () => {
	it('carries the system prompt, context, selection, and question', () => {
		const messages = buildExplainMessages(
			{
				documentTitle: 'Foundations of RL',
				selection: 'The Bellman equation defines optimality.',
				context: { before: 'Earlier prose.', after: 'Later prose.' },
				question: 'Why is it recursive?'
			},
			'CUSTOM SYSTEM'
		);
		expect(messages[0]).toEqual({ role: 'system', content: 'CUSTOM SYSTEM' });
		expect(messages[1].role).toBe('user');
		expect(messages[1].content).toContain('Foundations of RL');
		expect(messages[1].content).toContain('Earlier prose.');
		expect(messages[1].content).toContain('The Bellman equation defines optimality.');
		expect(messages[1].content).toContain('Later prose.');
		expect(messages[1].content).toContain('The listener asks: Why is it recursive?');
	});

	it('uses the default prompt and a generic ask when nothing is provided', () => {
		const messages = buildExplainMessages({
			documentTitle: 'Doc',
			selection: 'Some text.',
			context: { before: '', after: '' },
			question: '   '
		});
		expect(messages[0].content).toBe(DEFAULT_EXPLAIN_PROMPT);
		expect(messages[1].content).toContain('The listener wants this passage explained.');
		expect(messages[1].content).not.toContain('excerpt before');
	});
});

describe('sanitizeExplanation', () => {
	it('strips reasoning tags, markdown, and filler openers', () => {
		const cleaned = sanitizeExplanation(
			'<think>internal chain</think>Sure! **The Bellman equation** says:\n\n- value equals reward\n- plus discounted future value\n\nIt is `recursive` because tomorrow depends on today.'
		);
		expect(cleaned).toBe(
			'The Bellman equation says: value equals reward plus discounted future value It is recursive because tomorrow depends on today.'
		);
	});

	it('drops code fences but keeps the prose around them', () => {
		const cleaned = sanitizeExplanation('The loop repeats.\n```python\nx = 1\n```\nThat is all.');
		expect(cleaned).toContain('The loop repeats.');
		expect(cleaned).toContain('That is all.');
		expect(cleaned).not.toContain('```');
	});

	it('rejects empty or symbol-soup output', () => {
		expect(sanitizeExplanation('   ')).toBeNull();
		expect(sanitizeExplanation('<think>only thoughts</think>')).toBeNull();
		expect(sanitizeExplanation('= + 42 * 7 / ^ _ 99 | 3 % 5 # 1')).toBeNull();
	});
});
