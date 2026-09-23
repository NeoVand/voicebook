import { describe, expect, it } from 'vitest';
import { searchDocument, searchTokens, stem } from './document-search';
import type { DocumentBlock, NormalizedDocument, SpeechSegment } from './types';

type Spec = {
	id: string;
	kind?: DocumentBlock['kind'];
	passages: string[];
} & Partial<DocumentBlock>;

function documentOf(specs: Spec[]): NormalizedDocument {
	const blocks: DocumentBlock[] = specs.map(({ passages, ...block }) => ({
		kind: 'paragraph',
		text: passages.join(' '),
		speak: true,
		anchor: {},
		...block
	}));
	const segments: SpeechSegment[] = specs.flatMap((spec) =>
		spec.passages.map((text, index) => ({
			id: `${spec.id}:s${index}`,
			blockId: spec.id,
			text,
			normalizedText: text,
			start: 0,
			end: text.length,
			words: [],
			estimatedDuration: 1,
			anchor: {}
		}))
	);
	return {
		id: 'doc',
		fingerprint: 'fp',
		title: 'Whales',
		sourceName: 'whales.md',
		sourceKind: 'markdown',
		mimeType: 'text/markdown',
		language: 'en',
		createdAt: 0,
		updatedAt: 0,
		blocks,
		segments,
		outline: [],
		warnings: [],
		includeCode: true
	};
}

describe('stem', () => {
	it('lets the forms of a word meet', () => {
		for (const family of [
			['migrate', 'migrates', 'migrated', 'migrating', 'migration', 'migrations'],
			['compute', 'computer', 'computers', 'computed', 'computing'],
			['study', 'studies', 'studied'],
			['whale', 'whales'],
			['run', 'running', 'runner'],
			['stop', 'stopped', 'stopping'],
			['breed', 'breeding', 'breeds'],
			['water', 'waters']
		]) {
			expect(new Set(family.map(stem)), family.join(' ')).toHaveProperty('size', 1);
		}
	});

	it('leaves short words, numbers, and -ss, -us, -is endings alone', () => {
		for (const word of ['sing', 'thing', 'glass', 'virus', 'analysis', '1990s', 'need']) {
			expect(stem(word)).toBe(word);
		}
		expect(stem('falling')).toBe('fall');
	});
});

describe('searchTokens', () => {
	it('folds case and accents, drops stopwords, and stems', () => {
		expect(searchTokens('The Cafés of the Studies are open, and the glass is full')).toEqual([
			'caf',
			'study',
			'open',
			'glass',
			'full'
		]);
	});

	it('keeps numbers and drops single letters', () => {
		expect(searchTokens('a 52 Hz call, x')).toEqual(['52', 'hz', 'call']);
	});
});

describe('searchDocument', () => {
	const whales = () =>
		documentOf([
			{ id: 'h1', kind: 'heading', passages: ['Migration routes'] },
			{
				id: 'p1',
				passages: [
					'Humpbacks travel thousands of kilometres each year.',
					'Their migration follows the coastline south to warm breeding waters.'
				]
			},
			{ id: 'p2', passages: ['Blue whales sing at very low frequencies.'] },
			{ id: 'p3', passages: ['The loneliest whale sings at 52 hertz, far above the blue whale.'] },
			{
				id: 't1',
				kind: 'table',
				passages: ['A table with columns Species and Length.'],
				table: {
					align: [null, null],
					header: [
						{ text: 'Species', inlines: [] },
						{ text: 'Length', inlines: [] }
					],
					rows: [
						[
							{ text: 'Narwhal', inlines: [] },
							{ text: '5 m', inlines: [] }
						]
					]
				}
			},
			{
				id: 'c1',
				kind: 'code',
				passages: ['A python code snippet with 1 line is shown here.'],
				codeLanguage: 'python',
				text: 'estimate_population(sightings)'
			}
		]);

	it('ranks the passages that match best, with their markers and a snippet', () => {
		const hits = searchDocument(whales(), 'where do humpbacks migrate for breeding?');
		expect(hits[0]).toMatchObject({ blockId: 'p1', start: 1, end: 2, snippetSegment: 2 });
		expect(hits[0].snippet).toBe(
			'Their migration follows the coastline south to warm breeding waters.'
		);
	});

	it('weighs headings, so a section title outranks a passing mention', () => {
		const hits = searchDocument(whales(), 'migration');
		expect(hits.map((hit) => hit.blockId)).toEqual(['h1', 'p1']);
	});

	it('boosts the query words side by side, stopwords and punctuation aside', () => {
		const doc = documentOf([
			{ id: 'a', passages: ['Water speed depends on sound temperature.'] },
			{ id: 'b', passages: ['The speed of sound depends on water temperature.'] }
		]);
		const [first, second] = searchDocument(doc, 'Speed of sound?');
		expect(first.blockId).toBe('b');
		expect(first.score).toBeCloseTo(second.score * 1.5, 1);
	});

	it('finds a paraphrase through its stem', () => {
		expect(searchDocument(whales(), 'migrating humpback')[0]?.blockId).toBe('p1');
	});

	it('ranks references below the body', () => {
		const doc = documentOf([
			{ id: 'ref', passages: ['Payne, R. Songs of humpback whales.'] },
			{ id: 'body', passages: ['Payne recorded the songs of humpback whales.'] }
		]);
		doc.segments[0].role = 'back-matter';
		expect(searchDocument(doc, 'humpback songs').map((hit) => hit.blockId)).toEqual([
			'body',
			'ref'
		]);
	});

	it('finds table cells and code identifiers that are never spoken', () => {
		expect(searchDocument(whales(), 'narwhal')[0]?.blockId).toBe('t1');
		expect(searchDocument(whales(), 'estimate_population')[0]?.blockId).toBe('c1');
	});

	it('returns nothing for a query of only stopwords, or no match', () => {
		expect(searchDocument(whales(), 'what is the')).toEqual([]);
		expect(searchDocument(whales(), 'submarine')).toEqual([]);
	});

	it('limits the hits', () => {
		expect(searchDocument(whales(), 'whale', 1)).toHaveLength(1);
	});

	it('clips a long passage around the first match', () => {
		const long = `${'Filler words about nothing in particular. '.repeat(20)}The krill swarm is dense. ${'More filler follows here. '.repeat(20)}`;
		const [hit] = searchDocument(documentOf([{ id: 'p1', passages: [long] }]), 'krill');
		expect(hit.snippet.startsWith('…')).toBe(true);
		expect(hit.snippet.endsWith('…')).toBe(true);
		expect(hit.snippet).toContain('The krill swarm is dense.');
		expect(hit.snippet.length).toBeLessThanOrEqual(242);
	});

	it('reindexes when the passages are rebuilt', () => {
		const doc = whales();
		expect(searchDocument(doc, 'krill')).toEqual([]);
		const blue = doc.segments.find((segment) => segment.blockId === 'p2')!;
		doc.segments = [...doc.segments, { ...blue, id: 'p2:s1', text: 'Krill feed them.' }];
		expect(searchDocument(doc, 'krill')[0]?.blockId).toBe('p2');
	});
});
