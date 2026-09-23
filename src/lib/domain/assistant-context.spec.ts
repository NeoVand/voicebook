import { describe, expect, it } from 'vitest';
import type { DocumentBlock, NormalizedDocument, SpeechSegment } from './types';
import {
	assistantTools,
	brainTools,
	buildAssistantInstructions,
	describePassageLocation,
	parseAssistantToolCall,
	readPassageText,
	readSectionOutput,
	searchDocumentOutput,
	shouldFollowUpAfterTools
} from './assistant-context';
import { buildDocumentMap } from './document-map';

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
	return base(blocks, segments, overrides);
}

/** A document whose constructs narrate — the model must still see sources. */
function constructDoc(): NormalizedDocument {
	const math: DocumentBlock = { ...block('m1', 'math'), text: 'E = mc^2' };
	const table: DocumentBlock = {
		...block('t1'),
		table: {
			align: [null, null],
			header: [
				{ text: 'Whale', inlines: [] },
				{ text: 'Range km', inlines: [] }
			],
			rows: [
				[
					{ text: 'Humpback', inlines: [] },
					{ text: '8000', inlines: [] }
				]
			]
		}
	};
	const blocks = [block('p1'), math, table];
	const segments = [
		segment('p1:s0', 'p1', 'Energy relates to mass.'),
		segment('m1:n0', 'm1', 'Energy equals mass times the speed of light squared.'),
		segment('t1:n0', 't1', 'Humpbacks range eight thousand kilometres.')
	];
	return base(blocks, segments, {});
}

function base(
	blocks: DocumentBlock[],
	segments: SpeechSegment[],
	overrides: Partial<NormalizedDocument>
): NormalizedDocument {
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
		expect(built.mode).toBe('whole');
		expect(built.map).toBeUndefined();
		expect(built.segmentCount).toBe(5);
		expect(built.instructions).toContain('=== DOCUMENT: Whale Song ===');
		expect(built.instructions).toContain('# ⟦0⟧ Whale Song');
		expect(built.instructions).toContain('⟦1⟧ Whales sing across ocean basins. ⟦2⟧ Their songs');
		expect(built.instructions).toContain('## ⟦3⟧ Migration');
		expect(built.instructions).toContain('=== OUTLINE ===\n- Whale Song ⟦0⟧\n  - Migration ⟦3⟧');
	});

	it('sends a document too long to carry whole as a map, never half of it', () => {
		const built = buildAssistantInstructions(doc(), { inlineBudget: 120 });
		expect(built.mode).toBe('map');
		expect(built.map?.sections.map((section) => section.title)).toEqual([
			'Whale Song',
			'Migration'
		]);
		expect(built.instructions).toContain('instead of its full text you have its MAP');
		expect(built.instructions).toContain('=== MAP: Whale Song ===');
		expect(built.instructions).toContain('S2 Migration ⟦3–4⟧');
		expect(built.instructions).toContain('Opens: Humpbacks migrate toward the poles each summer.');
		expect(built.instructions).not.toContain('=== DOCUMENT:');
		expect(built.instructions).not.toContain('⟦2⟧ Their songs travel');
	});

	it('gives the map the abstract and reader state, and leaves section notes to the map', () => {
		const built = buildAssistantInstructions(
			doc({
				study: {
					nodes: [
						{
							id: 'study:h2',
							blockId: 'h2',
							title: 'Migration',
							level: 2,
							status: 'ready',
							summary: 'Humpbacks head poleward in summer.',
							sourceHash: 'x',
							updatedAt: 1
						}
					],
					abstract: 'Songs and journeys of whales.',
					abstractStatus: 'ready',
					promptVersion: 1,
					updatedAt: 1
				},
				memories: [
					{
						id: 'm1',
						text: 'Reader wants the migration data revisited.',
						blockId: 'h2',
						origin: 'assistant',
						createdAt: 1,
						updatedAt: 1
					}
				]
			}),
			{ inlineBudget: 120 }
		);
		expect(built.instructions).toContain('=== ABSTRACT ===\nSongs and journeys of whales.');
		expect(built.instructions).toContain('=== READER STATE ===');
		expect(built.instructions).toContain('Note: Humpbacks head poleward in summer.');
		expect(built.instructions).not.toContain('=== STUDY NOTES ===');
		expect(built.instructions.indexOf('=== READER STATE ===')).toBeLessThan(
			built.instructions.indexOf('=== MAP:')
		);
	});

	it('exposes construct sources alongside their spoken descriptions', () => {
		const built = buildAssistantInstructions(constructDoc());
		expect(built.instructions).toContain('[equation] E = mc^2\n⟦1⟧ Energy equals mass');
		expect(built.instructions).toContain(
			'[table]\n| Whale | Range km |\n| --- | --- |\n| Humpback | 8000 |\n⟦2⟧ Humpbacks range'
		);
	});

	it('omits the outline section for documents without one', () => {
		const built = buildAssistantInstructions(doc({ outline: [] }));
		expect(built.instructions).not.toContain('=== OUTLINE ===');
	});

	it('carries the study layer ahead of the document when it is ready', () => {
		const bare = buildAssistantInstructions(doc());
		expect(bare.instructions).not.toContain('=== STUDY NOTES ===');
		const built = buildAssistantInstructions(
			doc({
				study: {
					nodes: [
						{
							id: 'study:h2',
							blockId: 'h2',
							title: 'Migration',
							level: 2,
							status: 'ready',
							summary: 'Humpbacks head poleward in summer.',
							sourceHash: 'x',
							updatedAt: 1
						}
					],
					abstract: 'Songs and journeys of whales.',
					abstractStatus: 'ready',
					promptVersion: 1,
					updatedAt: 1
				}
			})
		);
		expect(built.instructions).toContain('STUDY NOTES section below carries');
		expect(built.instructions).toContain(
			'=== STUDY NOTES ===\nAbstract: Songs and journeys of whales.'
		);
		expect(built.instructions).toContain('- ⟦3⟧ Migration — Humpbacks head poleward in summer.');
		expect(built.instructions.indexOf('=== STUDY NOTES ===')).toBeLessThan(
			built.instructions.indexOf('=== DOCUMENT:')
		);
	});

	it('carries reader state when past sessions left notes', () => {
		const bare = buildAssistantInstructions(doc());
		expect(bare.instructions).not.toContain('=== READER STATE ===');
		const built = buildAssistantInstructions(
			doc({
				memories: [
					{
						id: 'm1',
						text: 'Reader wants the migration data revisited.',
						blockId: 'h2',
						origin: 'assistant',
						createdAt: 1,
						updatedAt: 1
					}
				]
			})
		);
		expect(built.instructions).toContain('=== READER STATE ===');
		expect(built.instructions).toContain('- ⟦3⟧ Reader wants the migration data revisited.');
	});
});

describe('brain instructions', () => {
	it('writes for the ear and leaves the greeting to the voice', () => {
		const built = buildAssistantInstructions(doc(), { role: 'brain' });
		expect(built.instructions).toContain('What you write is heard, not read.');
		expect(built.instructions).toContain('no markdown, lists, headings');
		expect(built.instructions).not.toContain('When the conversation begins, greet the reader');
		expect(built.instructions).toContain('=== DOCUMENT: Whale Song ===');
	});

	it('reads a long document through the map like the voice does', () => {
		const built = buildAssistantInstructions(doc(), { role: 'brain', inlineBudget: 120 });
		expect(built.mode).toBe('map');
		expect(built.instructions).toContain('What you write is heard, not read.');
		expect(built.instructions).toContain('=== MAP: Whale Song ===');
	});
});

describe('brainTools', () => {
	it('walks through with the voice, but cannot point word by word', () => {
		const names = brainTools(true).map((tool) => tool.name);
		expect(names).not.toContain('point_at');
		expect(names).toEqual(
			expect.arrayContaining(['plan_tour', 'continue_tour', 'show_passage', 'read_section'])
		);
		expect(brainTools(true).some((tool) => 'async' in tool)).toBe(false);
	});

	it('runs the screen-only tools async for typed chat, which has no voice to pace a tour', () => {
		const tools = brainTools(false, { typed: true });
		expect(tools.map((tool) => tool.name)).not.toContain('plan_tour');
		expect(tools.filter((tool) => tool.async).map((tool) => tool.name)).toEqual([
			'show_passage',
			'clear_highlight',
			'add_highlight',
			'add_note',
			'save_memory',
			'play_section'
		]);
		expect(tools.find((tool) => tool.name === 'get_reader_focus')?.async).toBeUndefined();
	});
});

describe('assistantTools', () => {
	it('offers the reading tools only with a map', () => {
		expect(assistantTools(false).map((tool) => tool.name)).toEqual([
			'show_passage',
			'point_at',
			'clear_highlight',
			'get_reader_focus',
			'plan_tour',
			'continue_tour',
			'add_highlight',
			'add_note',
			'save_memory',
			'web_research',
			'play_section'
		]);
		expect(assistantTools(true).map((tool) => tool.name)).toEqual([
			'show_passage',
			'point_at',
			'clear_highlight',
			'get_reader_focus',
			'plan_tour',
			'continue_tour',
			'add_highlight',
			'add_note',
			'save_memory',
			'web_research',
			'play_section',
			'read_section',
			'search_document',
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

	it('parses play_section like a passage range', () => {
		const result = parseAssistantToolCall(doc(), 'play_section', '{"start_segment":1}');
		expect(result.call).toEqual({ name: 'play_section', range: { startIndex: 1, endIndex: 1 } });
	});

	it('parses add_highlight like a passage range', () => {
		const result = parseAssistantToolCall(
			doc(),
			'add_highlight',
			'{"start_segment":4,"end_segment":2}'
		);
		expect(result.call).toEqual({ name: 'add_highlight', range: { startIndex: 2, endIndex: 4 } });
	});

	it('parses add_note with its text, and rejects a missing note', () => {
		const result = parseAssistantToolCall(
			doc(),
			'add_note',
			'{"start_segment":1,"note":"  Ask about sonar interference  "}'
		);
		expect(result.call).toEqual({
			name: 'add_note',
			range: { startIndex: 1, endIndex: 1 },
			text: 'Ask about sonar interference'
		});
		expect(parseAssistantToolCall(doc(), 'add_note', '{"start_segment":1}').error).toContain(
			'note'
		);
		expect(
			parseAssistantToolCall(doc(), 'add_note', '{"start_segment":1,"note":"   "}').error
		).toContain('note');
	});

	it('parses save_memory, dropping an out-of-range anchor instead of failing', () => {
		const anchored = parseAssistantToolCall(
			doc(),
			'save_memory',
			'{"note":"  Reader connected songs to sonar.  ","segment":2}'
		);
		expect(anchored.call).toEqual({
			name: 'save_memory',
			text: 'Reader connected songs to sonar.',
			segment: 2
		});
		const unanchored = parseAssistantToolCall(
			doc(),
			'save_memory',
			'{"note":"Keep this","segment":99}'
		);
		expect(unanchored.call).toEqual({ name: 'save_memory', text: 'Keep this' });
		expect(parseAssistantToolCall(doc(), 'save_memory', '{"note":"  "}').error).toContain('note');
	});

	it('parses web_research and requires a query', () => {
		const result = parseAssistantToolCall(
			doc(),
			'web_research',
			'{"query":"  How has whale-song research changed since 2024?  "}'
		);
		expect(result.call).toEqual({
			name: 'web_research',
			query: 'How has whale-song research changed since 2024?'
		});
		expect(parseAssistantToolCall(doc(), 'web_research', '{}').error).toContain('query');
	});

	it('parses clear_highlight regardless of arguments', () => {
		expect(parseAssistantToolCall(doc(), 'clear_highlight', '').call).toEqual({
			name: 'clear_highlight'
		});
	});

	it('parses plan_tour stops, ordering reversed ranges and clamping notes', () => {
		const result = parseAssistantToolCall(
			doc(),
			'plan_tour',
			JSON.stringify({
				stops: [
					{ start_segment: 2, end_segment: 1, point: 'songs carry far' },
					{ start_segment: 4, end_segment: 4, point: 'x'.repeat(300) }
				]
			})
		);
		expect(result.call).toEqual({
			name: 'plan_tour',
			stops: [
				{ range: { startIndex: 1, endIndex: 2 }, point: 'songs carry far' },
				{ range: { startIndex: 4, endIndex: 4 }, point: 'x'.repeat(200) }
			]
		});
	});

	it('rejects empty, oversized, and out-of-range tour plans', () => {
		expect(parseAssistantToolCall(doc(), 'plan_tour', '{"stops":[]}').error).toBe(
			'plan_tour needs a non-empty stops array.'
		);
		const many = JSON.stringify({
			stops: Array.from({ length: 9 }, () => ({ start_segment: 0, end_segment: 0, point: '' }))
		});
		expect(parseAssistantToolCall(doc(), 'plan_tour', many).error).toBe('Plan at most 8 stops.');
		expect(
			parseAssistantToolCall(doc(), 'plan_tour', '{"stops":[{"start_segment":7}]}').error
		).toBe('Every stop needs segment numbers from 0 to 4.');
	});

	it('parses continue_tour regardless of arguments', () => {
		expect(parseAssistantToolCall(doc(), 'continue_tour', '').call).toEqual({
			name: 'continue_tour'
		});
	});

	it('parses point_at and rejects out-of-range segments', () => {
		expect(parseAssistantToolCall(doc(), 'point_at', '{"segment":3}').call).toEqual({
			name: 'point_at',
			segment: 3
		});
		expect(parseAssistantToolCall(doc(), 'point_at', '{"segment":9}').error).toBe(
			'point_at needs a segment number from 0 to 4.'
		);
	});

	it('parses get_reader_focus regardless of arguments', () => {
		expect(parseAssistantToolCall(doc(), 'get_reader_focus', '').call).toEqual({
			name: 'get_reader_focus'
		});
	});

	it('parses the reading tools', () => {
		expect(parseAssistantToolCall(doc(), 'read_section', '{"section":" S2 "}').call).toEqual({
			name: 'read_section',
			section: 'S2'
		});
		expect(
			parseAssistantToolCall(doc(), 'read_section', '{"section":2,"from_segment":4}').call
		).toEqual({ name: 'read_section', section: '2', fromSegment: 4 });
		expect(parseAssistantToolCall(doc(), 'read_section', '{}').error).toMatch(/section handle/);
		expect(parseAssistantToolCall(doc(), 'search_document', '{"query":" krill "}').call).toEqual({
			name: 'search_document',
			query: 'krill'
		});
		expect(parseAssistantToolCall(doc(), 'search_document', '{"query":""}').error).toMatch(
			/non-empty query/
		);
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

	it('includes construct sources in fetched passages', () => {
		const passage = readPassageText(constructDoc(), { startIndex: 1, endIndex: 1 });
		expect(passage.text).toBe(
			'[equation] E = mc^2\n⟦1⟧ Energy equals mass times the speed of light squared.'
		);
	});

	it('stops at the character limit and flags the cut', () => {
		const passage = readPassageText(doc(), { startIndex: 0, endIndex: 4 }, 60);
		expect(passage.truncated).toBe(true);
		expect(passage.lastIndex).toBe(1);
		expect(passage.text).toContain('⟦0⟧ Whale Song');
		expect(passage.text).not.toContain('Humpbacks');
	});
});

describe('readSectionOutput', () => {
	const whales = doc();
	const map = buildDocumentMap(whales);

	it('reads a whole section with its markers', () => {
		expect(readSectionOutput(whales, map, 's2')).toEqual({
			section: 'S2 Migration',
			passages: '⟦3⟧–⟦4⟧ of ⟦3⟧–⟦4⟧',
			text: '⟦3⟧ Migration\n\n⟦4⟧ Humpbacks migrate toward the poles each summer.'
		});
	});

	it('pages through a long section and says where to continue', () => {
		const first = readSectionOutput(whales, map, 'S1', undefined, 60);
		expect(first).toMatchObject({ passages: '⟦0⟧–⟦1⟧ of ⟦0⟧–⟦2⟧', continue_from: 2 });
		expect(first.note).toContain('from_segment 2');
		const rest = readSectionOutput(whales, map, 'S1', 2);
		expect(rest).toMatchObject({ passages: '⟦2⟧–⟦2⟧ of ⟦0⟧–⟦2⟧' });
		expect(rest).not.toHaveProperty('continue_from');
		expect(rest.text).toMatch(/^⟦2⟧ Their songs/);
	});

	it('still returns a single passage longer than a page', () => {
		const output = readSectionOutput(whales, map, 'S2', 4, 10);
		expect(output).toMatchObject({ passages: '⟦4⟧–⟦4⟧ of ⟦3⟧–⟦4⟧' });
		expect(output.text).toBe('⟦4⟧ Humpbacks migrate toward the poles each summer.');
	});

	it('starts over when from_segment falls outside the section', () => {
		expect(readSectionOutput(whales, map, 'S2', 1)).toMatchObject({
			passages: '⟦3⟧–⟦4⟧ of ⟦3⟧–⟦4⟧'
		});
	});

	it('names the valid handles for an unknown section', () => {
		expect(readSectionOutput(whales, map, 'S9')).toEqual({
			error: 'There is no section "S9". Use an S-number from the map, S1 to S2.'
		});
	});
});

describe('searchDocumentOutput', () => {
	const whales = doc();
	const map = buildDocumentMap(whales);

	it('places each hit on the map', () => {
		expect(searchDocumentOutput(whales, map, 'humpbacks migrating')).toEqual({
			results: [
				{
					section: 'S2 Migration',
					passages: '⟦4⟧',
					text: '⟦4⟧ Humpbacks migrate toward the poles each summer.'
				},
				{ section: 'S2 Migration', passages: '⟦3⟧', text: '⟦3⟧ Migration' }
			]
		});
	});

	it('says so when nothing matches', () => {
		expect(searchDocumentOutput(whales, map, 'submarine')).toMatchObject({ results: [] });
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

describe('shouldFollowUpAfterTools', () => {
	it('stays quiet when a mark the reader can see was already spoken for', () => {
		// Regression: the model says "Okay, I've added that note" in the very
		// response that calls add_note, and the follow-up said it all over
		// again — one action, two confirmations.
		expect(shouldFollowUpAfterTools([{ name: 'add_note' }], true)).toBe(false);
		expect(
			shouldFollowUpAfterTools([{ name: 'add_highlight' }, { name: 'save_memory' }], true)
		).toBe(false);
	});

	it('answers a silent call, because nothing has been said yet', () => {
		expect(shouldFollowUpAfterTools([{ name: 'add_note' }], false)).toBe(true);
		expect(shouldFollowUpAfterTools([{ name: 'show_passage' }], false)).toBe(true);
	});

	it('answers whenever a result is the point, spoken for or not', () => {
		for (const name of ['read_passage', 'get_reader_focus', 'plan_tour', 'show_passage']) {
			expect(shouldFollowUpAfterTools([{ name }], true)).toBe(true);
		}
		// A mixed turn follows its answering half.
		expect(shouldFollowUpAfterTools([{ name: 'add_note' }, { name: 'read_passage' }], true)).toBe(
			true
		);
	});

	it('answers a failure even when success was already claimed', () => {
		expect(shouldFollowUpAfterTools([{ name: 'add_note', failed: true }], true)).toBe(true);
	});

	it('leaves the stage to the narrator after play_section', () => {
		expect(shouldFollowUpAfterTools([{ name: 'play_section' }], false)).toBe(false);
		expect(shouldFollowUpAfterTools([{ name: 'play_section' }], true)).toBe(false);
	});

	it('lets a slow tool answer from its own result instead', () => {
		expect(shouldFollowUpAfterTools([{ name: 'web_research', pending: true }], false)).toBe(false);
	});

	it('says nothing extra after a response that called nothing', () => {
		expect(shouldFollowUpAfterTools([], false)).toBe(false);
	});
});
