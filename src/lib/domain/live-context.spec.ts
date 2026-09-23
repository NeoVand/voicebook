import { describe, expect, it } from 'vitest';
import {
	SEED_CHAR_BUDGET,
	SEED_MESSAGE_LIMIT,
	brainChatInput,
	buildLiveVoiceInstructions,
	documentSketch,
	liveGreeting,
	liveSeedInput,
	typedExchangeNote,
	typedQuestionNote
} from './live-context';
import type { DocumentBlock, NormalizedDocument, SpeechSegment } from './types';

function documentOf(
	headings: string[],
	overrides: Partial<NormalizedDocument> = {}
): NormalizedDocument {
	const blocks: DocumentBlock[] = [];
	const segments: SpeechSegment[] = [];
	headings.forEach((title, index) => {
		for (const [id, kind, text] of [
			[`h${index}`, 'heading', title],
			[`p${index}`, 'paragraph', `About ${title}.`]
		] as const) {
			blocks.push({
				id,
				kind,
				text,
				speak: true,
				anchor: {},
				level: kind === 'heading' ? 2 : undefined
			});
			segments.push({
				id: `${id}:s0`,
				blockId: id,
				text,
				normalizedText: text,
				start: 0,
				end: text.length,
				words: [],
				estimatedDuration: 300,
				anchor: {}
			});
		}
	});
	return {
		id: 'doc',
		fingerprint: 'fp',
		title: 'Whale Song',
		sourceName: 'whales.md',
		sourceKind: 'web',
		mimeType: 'text/markdown',
		language: 'en',
		createdAt: 0,
		updatedAt: 0,
		blocks,
		segments,
		outline: headings.map((title, index) => ({
			id: `o${index}`,
			blockId: `h${index}`,
			title,
			level: 2
		})),
		warnings: [],
		includeCode: false,
		...overrides
	};
}

describe('documentSketch', () => {
	it('says what the document is, how long it runs, and what it covers', () => {
		expect(documentSketch(documentOf(['Songs', 'Migration', 'Feeding']))).toBe(
			'"Whale Song" is a web article, about 30 minutes of listening. Its sections: Songs; Migration; Feeding.'
		);
	});

	it('counts the sections that do not fit', () => {
		const titles = Array.from(
			{ length: 400 },
			(_, index) => `A fairly long section title ${index}`
		);
		const sketch = documentSketch(documentOf(titles));
		expect(sketch.length).toBeLessThan(2_300);
		expect(sketch).toMatch(/; and \d+ more\.$/);
	});

	it('skips the list for a document without sections', () => {
		expect(documentSketch(documentOf(['Only']))).toBe(
			'"Whale Song" is a web article, about 10 minutes of listening.'
		);
	});
});

describe('buildLiveVoiceInstructions', () => {
	it('follows the Live template and keeps the document itself with the brain', () => {
		const doc = documentOf(['Songs', 'Migration']);
		const instructions = buildLiveVoiceInstructions(doc);
		for (const heading of [
			'Backchannel policy:',
			'Interruption policy:',
			'Delegation policy:',
			'Backend tools:',
			'Delegate to the backend when:',
			'Do not delegate to the backend when:'
		]) {
			expect(instructions).toContain(heading);
		}
		expect(instructions).toContain('Its sections: Songs; Migration.');
		expect(instructions).not.toContain('About Songs.');
		expect(instructions).toContain('use English');
		// Far inside the voice's 16,384-token limit.
		expect(instructions.length).toBeLessThan(6_000);
	});

	it('opens in the document language', () => {
		const doc = documentOf(['Chants'], { language: 'fr' });
		expect(buildLiveVoiceInstructions(doc)).toContain('use French');
		expect(liveGreeting(doc)).toContain('Greet the reader now in French');
	});
});

describe('liveSeedInput', () => {
	it('carries finished turns in order, merging a speaker’s consecutive turns', () => {
		expect(
			liveSeedInput([
				{ role: 'user', text: 'What do whales sing about?' },
				{ role: 'assistant', text: 'Mostly about finding mates.' },
				{ role: 'assistant', text: 'Humpbacks especially.' },
				{ role: 'user', text: '  ' },
				{ role: 'user', text: 'Still typing', pending: true }
			])
		).toEqual([
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'What do whales sing about?' }]
			},
			{
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'output_text', text: 'Mostly about finding mates.\nHumpbacks especially.' }
				]
			}
		]);
	});

	it('keeps the newest turns within Live’s limits', () => {
		const many = Array.from({ length: 300 }, (_, index) => ({
			role: index % 2 ? ('assistant' as const) : ('user' as const),
			text: `turn ${index}`
		}));
		const seeded = liveSeedInput(many);
		expect(seeded).toHaveLength(SEED_MESSAGE_LIMIT);
		expect(seeded.at(-1)?.content[0].text).toBe('turn 299');

		const long = liveSeedInput([
			{ role: 'user', text: 'first question' },
			{ role: 'assistant', text: 'x'.repeat(SEED_CHAR_BUDGET * 2) }
		]);
		expect(long).toHaveLength(1);
		expect(long[0].content[0].text.length).toBe(SEED_CHAR_BUDGET);
		expect(long[0].content[0].text.startsWith('…')).toBe(true);
	});
});

describe('typed-chat notes', () => {
	it('mirror what the reader typed to the voice, clipped to an append', () => {
		expect(typedQuestionNote('Why do they sing?')).toContain('"Why do they sing?"');
		expect(typedQuestionNote('x'.repeat(5_000)).length).toBeLessThan(1_400);
		const note = typedExchangeNote('Why?', 'Because.');
		expect(note).toContain('"Why?"');
		expect(note).toContain('"Because."');
	});
});

describe('brainChatInput', () => {
	it('sends the recent conversation and marks the turn as typed', () => {
		const input = brainChatInput([
			{ role: 'assistant', text: 'Hello! Ask me anything about Whale Song.' },
			{ role: 'user', text: 'Why do whales sing?' },
			{ role: 'assistant', text: 'To find mates.' },
			{ role: 'user', text: 'And the blue whale?' }
		]);
		expect(input.map((item) => item.role)).toEqual(['user', 'assistant', 'user', 'developer']);
		expect(input[2].content).toBe('And the blue whale?');
		expect(input.at(-1)?.content).toContain('typed their last message');
	});

	it('drops the oldest turns past the budget but always keeps the question', () => {
		const input = brainChatInput(
			[
				{ role: 'user', text: 'old question '.repeat(20) },
				{ role: 'assistant', text: 'old answer '.repeat(20) },
				{ role: 'user', text: 'x'.repeat(500) }
			],
			300
		);
		expect(input.map((item) => item.role)).toEqual(['user', 'developer']);
		expect(input[0].content).toBe('x'.repeat(500));
	});
});
