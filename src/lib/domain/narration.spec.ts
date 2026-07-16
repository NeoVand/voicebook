import { describe, expect, it } from 'vitest';
import {
	codeBlockFallback,
	NARRATION_PROMPT_VERSION,
	hashNarrationSource,
	inlineConstructSpans,
	inlineMathFallback,
	mathBlockFallback,
	mermaidFallback,
	narrationConstructs,
	reconcileNarrations,
	serializeTableRow,
	tableHeaderFallback,
	tableRowFallback,
	tableRowRanges
} from './narration';
import type { DocumentBlock, NarrationEntry } from './types';

function makeBlock(partial: Partial<DocumentBlock> & Pick<DocumentBlock, 'id' | 'kind' | 'text'>) {
	return { speak: true, anchor: {}, ...partial } as DocumentBlock;
}

const cell = (text: string) => ({ text, inlines: [] });

describe('hashNarrationSource', () => {
	it('is stable and kind-scoped', () => {
		expect(hashNarrationSource('math-block', 'x^2')).toBe(hashNarrationSource('math-block', 'x^2'));
		expect(hashNarrationSource('math-block', 'x^2')).not.toBe(
			hashNarrationSource('math-inline', 'x^2')
		);
		expect(hashNarrationSource('math-block', 'x^2')).not.toBe(
			hashNarrationSource('math-block', 'x^3')
		);
	});
});

describe('fallbacks', () => {
	it('keeps trivial identifiers verbatim and reads everything else exactly', () => {
		// Single letters keep word highlighting in their sentence.
		expect(inlineMathFallback('p')).toBe('p');
		expect(inlineMathFallback('n')).toBe('n');
		// Everything the converter understands gets the lecturer reading.
		expect(inlineMathFallback('E=mc^2')).toBe('E equals m c squared');
		expect(inlineMathFallback('\\pi(a \\mid s)')).toBe('pi of a given s');
		expect(inlineMathFallback('O(n \\log n)')).toBe('O of n log n');
		expect(inlineMathFallback('s_{t+1}')).toBe('s sub t plus one');
		expect(inlineMathFallback('\\sum_{i=0}^{n} x_i')).toBe(
			'the sum from i equals zero to n of x sub i'
		);
		// Unparseable LaTeX degrades to the neutral placeholder (and the LLM).
		expect(inlineMathFallback('\\begin{matrix} a \\\\ b \\end{matrix}')).toBe('a formula');
	});

	it('reads display equations exactly when possible', () => {
		expect(mathBlockFallback('E = mc^2')).toBe('E equals m c squared.');
		expect(mathBlockFallback('\\unknowncmd{x}')).toBe('An equation is shown here.');
	});

	it('names the mermaid diagram type', () => {
		expect(mermaidFallback('flowchart LR\n A --> B')).toBe('A flowchart is shown here.');
		expect(mermaidFallback('sequenceDiagram\n A->>B: hi')).toBe(
			'A sequence diagram is shown here.'
		);
		expect(mermaidFallback('%% nothing known')).toBe('A diagram is shown here.');
	});

	it('reads short plain-text snippets verbatim and announces real code', () => {
		expect(codeBlockFallback('+1 per second alive\n-100 if eaten', 'txt')).toBe(
			'+1 per second alive -100 if eaten.'
		);
		expect(codeBlockFallback('def mean(xs):\n    return sum(xs) / len(xs)', 'python')).toBe(
			'A python code snippet with 2 lines is shown here.'
		);
		// Symbol-heavy or long plain text announces itself too.
		expect(codeBlockFallback('<<<>>> ||| ### $$$', 'txt')).toBe(
			'A text snippet with 1 line is shown here.'
		);
		expect(codeBlockFallback(`${'many words here '.repeat(20)}end`)).toBe(
			'A text snippet with 1 line is shown here.'
		);
	});

	it('announces table columns and zips rows with headers', () => {
		expect(tableHeaderFallback(['Name', 'Age'])).toBe('A table with columns: Name, Age.');
		expect(tableHeaderFallback([])).toBe('A table follows.');
		expect(tableRowFallback(['Name', 'Age'], ['Alice', '30'])).toBe('Name: Alice. Age: 30.');
		expect(tableRowFallback([], ['Alice', '30'])).toBe('Alice. 30.');
		expect(tableRowFallback(['Name', 'Age'], ['', ''])).toBe('');
		expect(serializeTableRow(['Name', 'Age'], ['Alice', '30'])).toBe('Name: Alice | Age: 30');
	});
});

describe('tableRowRanges', () => {
	it('locates each row inside the importer-flattened text', () => {
		const table = {
			align: [],
			header: [cell('Name'), cell('Age')],
			rows: [
				[cell('Alice'), cell('30')],
				[cell('Bob'), cell('41')]
			]
		};
		// Matches addTable(): cells joined ', ', rows joined '. '.
		const text = 'Name, Age. Alice, 30. Bob, 41';
		const ranges = tableRowRanges(text, table);
		expect(text.slice(ranges.header!.start, ranges.header!.end)).toBe('Name, Age');
		expect(text.slice(ranges.rows[0]!.start, ranges.rows[0]!.end)).toBe('Alice, 30');
		expect(text.slice(ranges.rows[1]!.start, ranges.rows[1]!.end)).toBe('Bob, 41');
	});

	it('returns null for rows it cannot locate without breaking later rows', () => {
		const table = {
			align: [],
			header: [cell('Name')],
			rows: [[cell('MISSING')], [cell('Bob')]]
		};
		const ranges = tableRowRanges('Name. Bob', table);
		expect(ranges.rows[0]).toBeNull();
		expect(ranges.rows[1]).not.toBeNull();
	});
});

describe('inlineConstructSpans', () => {
	it('assigns stable ids and offsets to math and image runs', () => {
		const block = makeBlock({
			id: 'b3',
			kind: 'paragraph',
			text: 'The rate O(n) grows. Image',
			inlines: [
				{ text: 'The rate ' },
				{ text: 'O(n)', math: true },
				{ text: ' grows. ' },
				{ text: 'Image', image: { alt: '' } }
			]
		});
		const spans = inlineConstructSpans(block);
		expect(spans).toHaveLength(2);
		expect(spans[0]).toMatchObject({ id: 'b3:m0', kind: 'math-inline', start: 9, end: 13 });
		expect(spans[1]).toMatchObject({ id: 'b3:img0', kind: 'image', eligible: false });
	});

	it('bails out when block text does not match the run concatenation', () => {
		const block = makeBlock({
			id: 'b4',
			kind: 'paragraph',
			text: 'different',
			inlines: [{ text: 'other', math: true }]
		});
		expect(inlineConstructSpans(block)).toEqual([]);
	});
});

describe('narrationConstructs', () => {
	const blocks: DocumentBlock[] = [
		makeBlock({ id: 'b0', kind: 'math', text: '\\sum x_i', speak: false }),
		makeBlock({ id: 'b1', kind: 'mermaid', text: 'flowchart LR\nA-->B', speak: false }),
		makeBlock({
			id: 'b2',
			kind: 'table',
			text: 'Name, Age. Alice, 30',
			table: {
				align: [],
				header: [cell('Name'), cell('Age')],
				rows: [[cell('Alice'), cell('30')]]
			}
		}),
		makeBlock({
			id: 'b3',
			kind: 'paragraph',
			text: 'It is O(n) fast. Chart',
			inlines: [
				{ text: 'It is ' },
				{ text: 'O(n)', math: true },
				{ text: ' fast. ' },
				{ text: 'Chart', image: { alt: 'Chart', title: 'Loss curve' } }
			]
		}),
		makeBlock({
			id: 'b4',
			kind: 'paragraph',
			text: 'Image',
			inlines: [{ text: 'Image', image: { alt: '' } }]
		})
	];

	it('enumerates LLM-eligible constructs in document order', () => {
		const constructs = narrationConstructs(blocks);
		expect(constructs.map((c) => c.id)).toEqual(['b0', 'b1', 'b2:r0', 'b3:img0']);
		expect(constructs.map((c) => c.kind)).toEqual(['math-block', 'mermaid', 'table-row', 'image']);
		// Inline math, alt-less images (b4), and table headers are
		// deterministic-only — never sent to the LLM.
		expect(constructs.find((c) => c.id === 'b3:m0')).toBeUndefined();
		expect(constructs.find((c) => c.id === 'b4:img0')).toBeUndefined();
		expect(constructs.find((c) => c.id === 'b2:rh')).toBeUndefined();
	});

	it('carries context for prompting', () => {
		const constructs = narrationConstructs(blocks);
		const row = constructs.find((c) => c.id === 'b2:r0')!;
		expect(row.source).toBe('Name: Alice | Age: 30');
		expect(row.context?.header).toEqual(['Name', 'Age']);
		const image = constructs.find((c) => c.id === 'b3:img0')!;
		expect(image.source).toBe('Chart — Loss curve');
	});
});

describe('reconcileNarrations', () => {
	const blocks: DocumentBlock[] = [
		makeBlock({ id: 'b0', kind: 'math', text: 'x^2', speak: false })
	];
	const hash = hashNarrationSource('math-block', 'x^2');

	function readyEntry(overrides: Partial<NarrationEntry> = {}): NarrationEntry {
		return {
			constructId: 'b0',
			kind: 'math-block',
			status: 'ready',
			text: 'x squared',
			sourceHash: hash,
			modelId: 'test',
			promptVersion: NARRATION_PROMPT_VERSION,
			updatedAt: 1,
			...overrides
		};
	}

	it('creates pending entries and a queue for new constructs', () => {
		const result = reconcileNarrations(blocks, {});
		expect(result.narrations['b0']?.status).toBe('pending');
		expect(result.queue.map((c) => c.id)).toEqual(['b0']);
		expect(result.changed).toBe(true);
	});

	it('keeps current ready entries out of the queue without change churn', () => {
		const existing = { b0: readyEntry() };
		const result = reconcileNarrations(blocks, existing);
		expect(result.narrations['b0']).toBe(existing['b0']);
		expect(result.queue).toEqual([]);
		expect(result.changed).toBe(false);
	});

	it('re-queues entries invalidated by source or prompt-version changes', () => {
		const staleHash = reconcileNarrations(blocks, {
			b0: readyEntry({ sourceHash: 'deadbeefdeadbeef' })
		});
		expect(staleHash.narrations['b0']?.status).toBe('pending');
		expect(staleHash.queue).toHaveLength(1);

		const staleVersion = reconcileNarrations(blocks, {
			b0: readyEntry({ promptVersion: NARRATION_PROMPT_VERSION - 1 })
		});
		expect(staleVersion.narrations['b0']?.status).toBe('pending');
	});

	it('re-offers failed entries while keeping their status', () => {
		const failed: NarrationEntry = {
			constructId: 'b0',
			kind: 'math-block',
			status: 'failed',
			sourceHash: hash,
			updatedAt: 1
		};
		const result = reconcileNarrations(blocks, { b0: failed });
		expect(result.narrations['b0']?.status).toBe('failed');
		expect(result.queue).toHaveLength(1);
	});

	it('rescues ready narrations across block-id shifts by content hash', () => {
		const shifted = reconcileNarrations(blocks, { b9: readyEntry({ constructId: 'b9' }) });
		expect(shifted.narrations['b0']?.status).toBe('ready');
		expect(shifted.narrations['b0']?.text).toBe('x squared');
		expect(shifted.narrations['b9']).toBeUndefined();
		expect(shifted.queue).toEqual([]);
	});

	it('re-queues ready narrations when the active prompt hash changes', () => {
		const existing = { b0: readyEntry({ promptHash: 'old-prompt' }) };
		const samePrompt = reconcileNarrations(blocks, existing, { 'math-block': 'old-prompt' });
		expect(samePrompt.queue).toEqual([]);
		const editedPrompt = reconcileNarrations(blocks, existing, { 'math-block': 'new-prompt' });
		expect(editedPrompt.narrations['b0']?.status).toBe('pending');
		expect(editedPrompt.queue).toHaveLength(1);
		// Without hashes (caller doesn't track prompts) ready entries survive.
		expect(reconcileNarrations(blocks, existing).queue).toEqual([]);
	});
});
