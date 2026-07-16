import { describe, expect, it } from 'vitest';
import {
	buildNarrationMessages,
	DEFAULT_NARRATION_PROMPTS,
	narrationPromptHashes,
	resolveNarrationPrompts,
	sanitizeNarration
} from './narration-prompts';
import { hashNarrationSource, type NarrationConstruct } from './narration';

function construct(overrides: Partial<NarrationConstruct> = {}): NarrationConstruct {
	const source = overrides.source ?? 'E = mc^2';
	const kind = overrides.kind ?? 'math-block';
	return {
		id: 'b1',
		kind,
		blockId: 'b1',
		source,
		sourceHash: hashNarrationSource(kind, source),
		fallbackText: 'An equation is shown here.',
		...overrides
	};
}

describe('buildNarrationMessages', () => {
	it('starts with the system prompt and ends with the live turn', () => {
		const messages = buildNarrationMessages(construct(), '');
		expect(messages[0].role).toBe('system');
		expect(messages[0].content).toContain('text-to-speech');
		expect(messages.at(-1)).toMatchObject({ role: 'user' });
	});

	it('gives equations the deterministic reading and the document context', () => {
		const messages = buildNarrationMessages(construct(), 'the discount factor gamma controls');
		const live = messages.at(-1)!.content;
		expect(live).toContain('E equals m c squared');
		expect(live).toContain('the discount factor gamma controls');
		expect(live).toContain('reply exactly: skip');
	});

	it('sends equations zero-shot (no exemplars to bleed symbol names from)', () => {
		const messages = buildNarrationMessages(construct(), '');
		expect(messages).toHaveLength(2);
	});

	it('renders few-shot exemplars through the active template for rows', () => {
		const messages = buildNarrationMessages(
			construct({
				kind: 'table-row',
				source: 'Name: Alice | Age: 30',
				context: { header: ['Name', 'Age'], row: ['Alice', '30'] }
			}),
			''
		);
		const middle = messages.slice(1, -1);
		expect(middle.length).toBeGreaterThanOrEqual(2);
		expect(middle.map((m) => m.role)).toEqual(
			middle.map((_, i) => (i % 2 === 0 ? 'user' : 'assistant'))
		);
		expect(middle[0].content).toContain('covering every column');
		expect(messages.at(-1)!.content).toContain('columns Name, Age');
	});

	it('applies user template overrides to exemplars and the live turn', () => {
		const messages = buildNarrationMessages(
			construct({ kind: 'mermaid', source: 'flowchart LR\nA-->B' }),
			'',
			{ overrides: { mermaid: 'Describe {{type}}: {{source}}' } }
		);
		expect(messages.at(-1)!.content).toBe('Describe a flowchart: flowchart LR\nA-->B');
		expect(messages[1].content).toMatch(/^Describe a flowchart: /);
	});

	it('names the detected diagram type in the mermaid prompt', () => {
		const messages = buildNarrationMessages(
			construct({ kind: 'mermaid', source: 'sequenceDiagram\nA->>B: hi' }),
			''
		);
		expect(messages.at(-1)!.content).toContain('draws a sequence diagram');
	});

	it('truncates very long mermaid sources', () => {
		const messages = buildNarrationMessages(
			construct({ kind: 'mermaid', source: `flowchart LR\n${'A --> B\n'.repeat(400)}` }),
			''
		);
		expect(messages.at(-1)!.content).toContain('%% diagram continues');
		expect(messages.at(-1)!.content.length).toBeLessThan(2200);
	});

	it('appends the strict suffix on retry', () => {
		const messages = buildNarrationMessages(construct(), '', { strict: true });
		expect(messages.at(-1)!.content).toMatch(/words only, one or two short sentences\.$/);
	});
});

describe('prompt hashing', () => {
	it('is stable for identical prompts and changes with overrides', () => {
		expect(narrationPromptHashes()).toEqual(narrationPromptHashes({}));
		const edited = narrationPromptHashes({ 'math-block': 'different template {{reading}}' });
		expect(edited['math-block']).not.toBe(narrationPromptHashes()['math-block']);
		expect(edited['table-row']).toBe(narrationPromptHashes()['table-row']);
		// Editing the shared system prompt invalidates every kind.
		const system = narrationPromptHashes({ system: 'be terse' });
		expect(system.mermaid).not.toBe(narrationPromptHashes().mermaid);
	});

	it('resolves overrides on top of defaults', () => {
		const prompts = resolveNarrationPrompts({ mermaid: 'custom' });
		expect(prompts.mermaid).toBe('custom');
		expect(prompts['math-block']).toBe(DEFAULT_NARRATION_PROMPTS['math-block']);
	});
});

describe('sanitizeNarration', () => {
	it('passes clean prose through', () => {
		expect(sanitizeNarration('A flowchart of the deployment pipeline.', 'mermaid')).toBe(
			'A flowchart of the deployment pipeline.'
		);
	});

	it('strips think blocks, preambles, wrapping quotes, and markdown', () => {
		expect(
			sanitizeNarration(
				'<think>reasoning about it</think>Sure, here is the narration: "The **sum** of x."',
				'table-row'
			)
		).toBe('The sum of x.');
	});

	it('drops everything after the first blank line', () => {
		expect(sanitizeNarration('The sum of x.\n\nNote: I chose to…', 'table-row')).toBe(
			'The sum of x.'
		);
	});

	it('rejects output containing math or diagram notation', () => {
		expect(sanitizeNarration('', 'table-row')).toBeNull();
		expect(sanitizeNarration('   \n \n ', 'table-row')).toBeNull();
		expect(sanitizeNarration('\\sum of x sub i', 'table-row')).toBeNull();
		expect(sanitizeNarration('L equals x + y', 'table-row')).toBeNull();
		expect(sanitizeNarration('x squared (that is, x times x)', 'table-row')).toBeNull();
		expect(sanitizeNarration('A --> B --> C', 'mermaid')).toBeNull();
		expect(sanitizeNarration('accuracy of 71.4%', 'table-row')).toBeNull();
		expect(sanitizeNarration('= 1 2 3', 'table-row')).toBeNull();
	});

	it('allows plain words with digits and hyphens', () => {
		expect(sanitizeNarration('The accuracy is 71.4 percent for x-axis values.', 'table-row')).toBe(
			'The accuracy is 71.4 percent for x-axis values.'
		);
	});

	it('transliterates Unicode Greek and math symbols to words', () => {
		expect(sanitizeNarration('a parameter θ and a factor λ', 'mermaid')).toBe(
			'a parameter theta and a factor lambda'
		);
		expect(sanitizeNarration('roughly a × b at most c', 'mermaid')).toBe(
			'roughly a times b at most c'
		);
		// Notation-dump Unicode (sums, integrals) still rejects.
		expect(sanitizeNarration('the value ∑ over i', 'mermaid')).toBeNull();
	});

	it('keeps only well-formed "Here …" meaning sentences for equations', () => {
		expect(sanitizeNarration('Here gamma is the discount factor.', 'math-block')).toBe(
			'Here gamma is the discount factor.'
		);
		// Extra rambling is cut at the first sentence.
		expect(
			sanitizeNarration('Here G sub t is the return. Also worth noting that…', 'math-block')
		).toBe('Here G sub t is the return.');
		// Skips, vacuous compliance, and summaries reject (reading-only wins).
		expect(sanitizeNarration('skip', 'math-block')).toBeNull();
		expect(sanitizeNarration('Here we discuss the symbols used.', 'math-block')).toBeNull();
		expect(sanitizeNarration('The equation describes a model.', 'math-block')).toBeNull();
	});

	it('shapes inline math output as a spliceable phrase', () => {
		expect(sanitizeNarration('pi of a given s.', 'math-inline')).toBe('pi of a given s');
		expect(sanitizeNarration(`${'very long phrase '.repeat(10)}end`, 'math-inline')).toBeNull();
	});

	it('truncates over-long output at a sentence boundary', () => {
		const sentence = 'This sentence is repeated to grow well past the cap. ';
		const out = sanitizeNarration(sentence.repeat(12), 'table-row');
		expect(out).not.toBeNull();
		expect(out!.length).toBeLessThanOrEqual(200);
		expect(out!.endsWith('.')).toBe(true);
	});

	it('truncates capless-sentence output at a word boundary', () => {
		const out = sanitizeNarration(`${'word '.repeat(80)}end`, 'image');
		expect(out).not.toBeNull();
		expect(out!.length).toBeLessThanOrEqual(200);
		expect(out!.endsWith(' ')).toBe(false);
	});
});
