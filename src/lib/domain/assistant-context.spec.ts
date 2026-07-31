import { describe, expect, it } from 'vitest';
import type { DocumentBlock, NormalizedDocument, SpeechSegment } from './types';
import {
	assistantTools,
	buildAssistantInstructions,
	describePassageLocation,
	parseAssistantToolCall,
	readPassageText
} from './assistant-context';

function block(
	id: string,
	kind: DocumentBlock['kind'] = 'paragraph',
	level?: number
): DocumentBlock {
	return { id, kind, text: id, speak: true, anchor: {}, ...(level ? { level } : {}) };
}

function segment(id: string, blockId: string, text: string): SpeechSegment {
	return {
		id,
		blockId,
		text,
		normalizedText: text,
		start: 0,
		end: text.length,
		words: [],
		estimatedDuration: 1,
		anchor: {}
	};
}

function doc(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
	const blocks = [block('h1', 'heading', 1), block('p1'), block('h2', 'heading', 2), block('p2')];
	const segments = [
		segment('h1:s0', 'h1', 'Whale Song'),
		segment('p1:s0', 'p1', 'Whales sing across ocean basins.'),
		segment('p1:s1', 'p1', 'Their songs travel for thousands of miles.'),
		segment('h2:s0', 'h2', 'Migration'),
		segment('p2:s0', 'p2', 'Humpbacks migrate toward the poles each summer.')
	];
	return {
		id: 'doc',
		fingerprint: 'fp',
		title: 'Whale Song',
		sourceName: 'whales.md',
		sourceKind: 'markdown',
		mimeType: 'text/markdown',
		language: 'en',
		createdAt: 0,
		updatedAt: 0,
		blocks,
		segments,
		outline: [
			{ id: 'o1', blockId: 'h1', title: 'Whale Song', level: 1 },
			{ id: 'o2', blockId: 'h2', title: 'Migration', level: 2 }
		],
		warnings: [],
		includeCode: true,
		...overrides
	};
}

describe('buildAssistantInstructions', () => {
	it('serializes the document with markers, heading levels, and the outline', () => {
		const built = buildAssistantInstructions(doc());
		expect(built.truncated).toBe(false);
		expect(built.segmentCount).toBe(5);
		expect(built.instructions).toContain('=== DOCUMENT: Whale Song ===');
		expect(built.instructions).toContain('# ⟦0⟧ Whale Song');
		expect(built.instructions).toContain('⟦1⟧ Whales sing across ocean basins. ⟦2⟧ Their songs');
		expect(built.instructions).toContain('## ⟦3⟧ Migration');
		expect(built.instructions).toContain('=== OUTLINE ===\n- Whale Song ⟦0⟧\n  - Migration ⟦3⟧');
	});

	it('cuts at a segment boundary and points the model at read_passage', () => {
		const built = buildAssistantInstructions(doc(), 120);
		expect(built.truncated).toBe(true);
		expect(built.instructions).toContain('# ⟦0⟧ Whale Song');
		expect(built.instructions).not.toContain('Humpbacks migrate');
		expect(built.instructions).toMatch(/Passages ⟦\d⟧ through ⟦4⟧ are omitted/);
	});

	it('omits the outline section for documents without one', () => {
		const built = buildAssistantInstructions(doc({ outline: [] }));
		expect(built.instructions).not.toContain('=== OUTLINE ===');
	});
});

describe('assistantTools', () => {
	it('offers read_passage only for truncated documents', () => {
		expect(assistantTools(false).map((tool) => tool.name)).toEqual([
			'show_passage',
			'clear_highlight'
		]);
		expect(assistantTools(true).map((tool) => tool.name)).toEqual([
			'show_passage',
			'clear_highlight',
			'read_passage'
		]);
	});
});

describe('parseAssistantToolCall', () => {
	it('parses show_passage and orders a reversed range', () => {
		const result = parseAssistantToolCall(
			doc(),
			'show_passage',
			'{"start_segment":3,"end_segment":1}'
		);
		expect(result.call).toEqual({ name: 'show_passage', range: { startIndex: 1, endIndex: 3 } });
	});

	it('treats a missing end_segment as a single segment', () => {
		const result = parseAssistantToolCall(doc(), 'show_passage', '{"start_segment":4}');
		expect(result.call).toEqual({ name: 'show_passage', range: { startIndex: 4, endIndex: 4 } });
	});

	it('parses clear_highlight regardless of arguments', () => {
		expect(parseAssistantToolCall(doc(), 'clear_highlight', '').call).toEqual({
			name: 'clear_highlight'
		});
	});

	it('rejects malformed JSON, unknown tools, and out-of-range segments', () => {
		expect(parseAssistantToolCall(doc(), 'show_passage', '{oops').error).toBe(
			'The arguments were not valid JSON.'
		);
		expect(parseAssistantToolCall(doc(), 'open_chapter', '{}').error).toBe(
			'Unknown tool "open_chapter".'
		);
		expect(parseAssistantToolCall(doc(), 'show_passage', '{"start_segment":9}').error).toBe(
			'Segment numbers run 0 through 4.'
		);
		expect(parseAssistantToolCall(doc(), 'show_passage', '{"start_segment":-1}').error).toBe(
			'start_segment and end_segment must be whole numbers from 0 to 4.'
		);
	});
});

describe('readPassageText', () => {
	it('returns marked text with paragraph breaks between blocks', () => {
		const passage = readPassageText(doc(), { startIndex: 1, endIndex: 3 });
		expect(passage.truncated).toBe(false);
		expect(passage.text).toBe(
			'⟦1⟧ Whales sing across ocean basins. ⟦2⟧ Their songs travel for thousands of miles.\n\n⟦3⟧ Migration'
		);
	});

	it('stops at the character limit and flags the cut', () => {
		const passage = readPassageText(doc(), { startIndex: 0, endIndex: 4 }, 60);
		expect(passage.truncated).toBe(true);
		expect(passage.text).toContain('⟦0⟧ Whale Song');
		expect(passage.text).not.toContain('Humpbacks');
	});
});

describe('describePassageLocation', () => {
	it('names the nearest heading at or before the passage', () => {
		expect(describePassageLocation(doc(), { startIndex: 4, endIndex: 4 })).toBe('Migration');
		expect(describePassageLocation(doc(), { startIndex: 1, endIndex: 2 })).toBe('Whale Song');
	});

	it('returns an empty string without an outline', () => {
		expect(describePassageLocation(doc({ outline: [] }), { startIndex: 1, endIndex: 1 })).toBe('');
	});
});
