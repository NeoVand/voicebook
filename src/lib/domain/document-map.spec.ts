import { describe, expect, it } from 'vitest';
import {
	MAP_PART_WORDS,
	buildDocumentMap,
	mapSection,
	mapText,
	sectionAt,
	tidyMath,
	type DocumentMap
} from './document-map';
import type { DocumentBlock, NormalizedDocument, OutlineEntry, SpeechSegment } from './types';

interface BlockSpec {
	id: string;
	kind?: DocumentBlock['kind'];
	text: string;
	level?: number;
	extra?: Partial<DocumentBlock>;
}

/** One passage per block; two words take a second to hear. */
function documentOf(
	specs: BlockSpec[],
	overrides: Partial<NormalizedDocument> = {}
): NormalizedDocument {
	const blocks: DocumentBlock[] = specs.map((spec) => ({
		id: spec.id,
		kind: spec.kind ?? 'paragraph',
		text: spec.text,
		speak: true,
		anchor: {},
		...(spec.level ? { level: spec.level } : {}),
		...spec.extra
	}));
	const segments: SpeechSegment[] = specs.map((spec) => ({
		id: `${spec.id}:s0`,
		blockId: spec.id,
		text: spec.text,
		normalizedText: spec.text,
		start: 0,
		end: spec.text.length,
		words: [],
		estimatedDuration: spec.text.split(/\s+/).length / 2,
		anchor: {}
	}));
	const outline: OutlineEntry[] = specs
		.filter((spec) => spec.kind === 'heading')
		.map((spec) => ({
			id: `o-${spec.id}`,
			blockId: spec.id,
			title: spec.text,
			level: spec.level ?? 1
		}));
	return {
		id: 'doc',
		fingerprint: 'fp',
		title: 'Signals',
		sourceName: 'signals.md',
		sourceKind: 'markdown',
		mimeType: 'text/markdown',
		language: 'en',
		createdAt: 0,
		updatedAt: 0,
		blocks,
		segments,
		outline,
		warnings: [],
		includeCode: true,
		...overrides
	};
}

const words = (count: number, word = 'wave') => Array.from({ length: count }, () => word).join(' ');

const signals = () =>
	documentOf([
		{ id: 'lead', text: 'Signals carry information through time.' },
		{ id: 'h1', kind: 'heading', text: 'Fourier analysis', level: 1 },
		{ id: 'p1', text: 'Any periodic signal is a sum of sines.' },
		{ id: 'm1', kind: 'math', text: 'E = mc^2' },
		{ id: 'h2', kind: 'heading', text: 'Sampling', level: 2 },
		{ id: 'p2', text: 'Sample at twice the highest frequency.' }
	]);

describe('buildDocumentMap', () => {
	it('turns the outline into nested sections with passage ranges, sizes, and a lead', () => {
		const map = buildDocumentMap(signals());
		expect(map.sections.map((section) => [section.id, section.title, section.level])).toEqual([
			['S1', 'Signals', 1],
			['S2', 'Fourier analysis', 1],
			['S3', 'Sampling', 2]
		]);
		expect(map.sections.map((section) => [section.start, section.end])).toEqual([
			[0, 0],
			// A chapter takes in its subsections.
			[1, 5],
			[4, 5]
		]);
		expect(map.sections[1].words).toBe(20);
		expect(map.sections[2].words).toBe(7);
		expect(map.sections[2].seconds).toBe(3.5);
		expect(map.words).toBe(25);
	});

	it('uses a ready study note as the gist, and the opening line otherwise', () => {
		const doc = signals();
		doc.study = {
			nodes: [
				{
					id: 'study:h1',
					blockId: 'h1',
					title: 'Fourier analysis',
					level: 1,
					status: 'ready',
					summary: 'Decomposes signals into frequencies.',
					sourceHash: 'x',
					updatedAt: 0
				}
			],
			abstractStatus: 'pending',
			promptVersion: 2,
			updatedAt: 0
		};
		const [, fourier, sampling] = buildDocumentMap(doc).sections;
		expect(fourier).toMatchObject({ gist: 'Decomposes signals into frequencies.', noted: true });
		// The heading itself is skipped: the opening line is the first prose.
		expect(sampling).toMatchObject({
			gist: 'Sample at twice the highest frequency.',
			noted: false
		});
	});

	it('lists entry points, the reader’s own marks first', () => {
		const doc = documentOf([
			{ id: 'h1', kind: 'heading', text: 'Results', level: 1 },
			{ id: 'm1', kind: 'math', text: 'E = mc^2' },
			{
				id: 't1',
				kind: 'table',
				text: '',
				extra: {
					table: {
						align: [null],
						header: [{ text: 'Species', inlines: [] }],
						rows: [[{ text: 'Humpback', inlines: [] }]]
					}
				}
			},
			{ id: 'c1', kind: 'code', text: 'print(1)', extra: { codeLanguage: 'python' } },
			{ id: 'd1', kind: 'code', text: 'flowchart LR\nA-->B', extra: { codeLanguage: 'mermaid' } },
			{
				id: 'f1',
				text: 'A chart.',
				extra: { inlines: [{ text: '', image: { alt: 'Spectrum of a chord' } }] }
			},
			{ id: 'p1', text: 'The spectrum peaks at the fundamentals.' }
		]);
		doc.annotations = [
			{
				id: 'a1',
				start: { blockId: 'p1', offset: 0 },
				end: { blockId: 'p1', offset: 10 },
				excerpt: 'The spectrum peaks',
				createdBy: 'reader',
				createdAt: 0,
				updatedAt: 0
			},
			{
				id: 'a2',
				start: { blockId: 'm1', offset: 0 },
				end: { blockId: 'm1', offset: 3 },
				excerpt: 'E = mc^2',
				note: 'check the units',
				createdBy: 'reader',
				createdAt: 0,
				updatedAt: 0
			}
		];
		doc.memories = [
			{
				id: 'n1',
				text: 'The chord example clicked.',
				blockId: 'f1',
				origin: 'assistant',
				createdAt: 0,
				updatedAt: 0
			}
		];
		const [results] = buildDocumentMap(doc).sections;
		expect(results.entries.map((entry) => [entry.kind, entry.segment])).toEqual([
			['note', 1],
			['memory', 5],
			['highlight', 6],
			['equation', 1],
			['table', 2],
			['code', 3],
			['diagram', 4],
			['figure', 5]
		]);
		expect(results.entries[3].label).toBe('E = mc^2');
		expect(results.entries[4].label).toBe('columns Species');
		expect(results.entries[7].label).toBe('Spectrum of a chord');
	});

	it('caps entry points and counts the rest', () => {
		const specs: BlockSpec[] = [{ id: 'h1', kind: 'heading', text: 'Identities', level: 1 }];
		for (let index = 0; index < 11; index += 1)
			specs.push({ id: `m${index}`, kind: 'math', text: `x_${index} = a + b` });
		const [section] = buildDocumentMap(documentOf(specs)).sections;
		expect(section.entries).toHaveLength(8);
		expect(section.moreEntries).toBe(3);
	});

	it('splits a long stretch without headings into readable parts', () => {
		const specs: BlockSpec[] = Array.from({ length: 6 }, (_, index) => ({
			id: `p${index}`,
			text: `Paragraph ${index} ${words(900)}`
		}));
		const map = buildDocumentMap(documentOf(specs));
		expect(map.sections.map((section) => section.title)).toEqual([
			'Signals',
			'Signals (part 1 of 3)',
			'Signals (part 2 of 3)',
			'Signals (part 3 of 3)'
		]);
		const [whole, first, second] = map.sections;
		expect([whole.start, whole.end]).toEqual([0, 5]);
		expect(whole.entries).toEqual([]);
		expect([first.start, first.end, first.level]).toEqual([0, 1, 2]);
		expect(first.words).toBeGreaterThanOrEqual(MAP_PART_WORDS);
		expect(second.gist.startsWith('Paragraph 2')).toBe(true);
	});

	it('leaves one long paragraph whole rather than a part of one', () => {
		const map = buildDocumentMap(documentOf([{ id: 'p0', text: words(5_000) }]));
		expect(map.sections.map((section) => section.title)).toEqual(['Signals']);
	});

	it('keeps a chapter’s entry points to its own text, and its parts to its own stretch', () => {
		const map = buildDocumentMap(
			documentOf([
				{ id: 'intro', text: 'A book in chapters.' },
				{ id: 'h1', kind: 'heading', text: 'Chapter', level: 1 },
				{ id: 'm1', kind: 'math', text: 'a^2 + b^2 = c^2' },
				{ id: 'p1', text: words(1_500) },
				{ id: 'p2', text: words(1_500) },
				{ id: 'h2', kind: 'heading', text: 'Section', level: 2 },
				{ id: 'm2', kind: 'math', text: 'e^{i\\pi} + 1 = 0' }
			])
		);
		expect(map.sections.map((section) => [section.title, section.start, section.end])).toEqual([
			['Signals', 0, 0],
			['Chapter', 1, 6],
			['Chapter (part 1 of 2)', 1, 3],
			['Chapter (part 2 of 2)', 4, 4],
			['Section', 5, 6]
		]);
		expect(map.sections.map((section) => section.entries.map((entry) => entry.segment))).toEqual([
			[],
			[],
			[2],
			[],
			[6]
		]);
		// The parts carry the chapter's opening; the chapter row does not repeat it.
		expect(map.sections[1].gist).toBe('');
	});

	it('treats a lone top heading as the title: it holds the intro, and the rest move up', () => {
		const map = buildDocumentMap(
			documentOf([
				{ id: 'title', kind: 'heading', text: 'Signals', level: 1 },
				{ id: 'intro', text: 'An introduction to signals.' },
				{ id: 'h2', kind: 'heading', text: 'Fourier', level: 2 },
				{ id: 'p2', text: 'Sums of sines.' },
				{ id: 'h3', kind: 'heading', text: 'Series', level: 3 },
				{ id: 'p3', text: 'Periodic signals.' }
			])
		);
		expect(
			map.sections.map((section) => [section.title, section.level, section.start, section.end])
		).toEqual([
			['Signals', 1, 0, 1],
			['Fourier', 1, 2, 5],
			['Series', 2, 4, 5]
		]);
		expect(map.sections[0].gist).toBe('An introduction to signals.');
	});

	it('leaves off a title with nothing under it but a web byline', () => {
		const doc = documentOf(
			[
				{ id: 'title', kind: 'heading', text: 'Signals', level: 1 },
				{
					id: 'byline',
					text: 'example.com',
					extra: { inlines: [{ text: 'example.com', marks: ['emphasis'] }] }
				},
				{ id: 'h2', kind: 'heading', text: 'Fourier', level: 2 },
				{ id: 'p2', text: 'Sums of sines.' }
			],
			{ sourceKind: 'web' }
		);
		expect(buildDocumentMap(doc).sections.map((section) => section.title)).toEqual(['Fourier']);
	});

	it('opens a gist with real prose, skipping images, equations, and back matter', () => {
		const doc = documentOf([
			{ id: 'h1', kind: 'heading', text: 'Results', level: 1 },
			{
				id: 'img',
				text: 'Image',
				extra: { inlines: [{ text: 'Image', image: { alt: '' } }] }
			},
			{
				id: 'fig',
				text: '',
				extra: { inlines: [{ text: '', image: { alt: 'A spectrum with two peaks.' } }] }
			},
			{ id: 'caption', text: 'A spectrum with two  peaks.' },
			{ id: 'm1', kind: 'math', text: '\\frac{a}{b} = c' },
			{ id: 'refs', text: 'Smith, J. (1999). Signals.' },
			{ id: 'p1', text: 'The spectrum peaks early.' }
		]);
		doc.segments[1].narration = { constructIds: ['img'], kind: 'construct', pending: false };
		doc.segments[5].role = 'back-matter';
		const [results] = buildDocumentMap(doc).sections;
		expect(results.gist).toBe('The spectrum peaks early.');
	});

	it('points only at places worth pointing at', () => {
		const [section] = buildDocumentMap(
			documentOf([
				{ id: 'h1', kind: 'heading', text: 'Notes', level: 1 },
				{ id: 'm1', kind: 'math', text: '{\\displaystyle \\scriptstyle f(t)}' },
				{ id: 'm2', kind: 'math', text: '{\\displaystyle \\int f(x)\\,dx = 1}' },
				{ id: 'c1', kind: 'code', text: 'Whales in the sea\nGod’s voice obey.' },
				{ id: 'c2', kind: 'code', text: 'fft(x)', extra: { codeLanguage: 'python' } },
				{
					id: 'f1',
					text: 'Two images.',
					extra: {
						inlines: [
							{ text: '', image: { alt: '' } },
							{ text: '', image: { alt: '', title: 'A chord' } }
						]
					}
				}
			])
		).sections;
		expect(section.entries).toEqual([
			{ kind: 'equation', segment: 2, label: '\\int f(x)\\,dx = 1' },
			{ kind: 'code', segment: 4, label: 'python code' },
			{ kind: 'figure', segment: 5, label: 'A chord' }
		]);
	});

	it('marks what the reader has heard and discussed', () => {
		const doc = signals();
		doc.listened = { 'h2:s0': [{ start: 0, end: 1 }], 'p2:s0': [{ start: 0, end: 2 }] };
		doc.conversation = { discussedBlockIds: ['p1'] };
		const [lead, fourier, sampling] = buildDocumentMap(doc).sections;
		expect([lead.heard, lead.discussed]).toEqual([false, false]);
		expect([fourier.heard, fourier.discussed]).toEqual([false, true]);
		expect([sampling.heard, sampling.discussed]).toEqual([true, false]);
	});
});

describe('mapSection and sectionAt', () => {
	const map = buildDocumentMap(signals());

	it('resolves every way a model writes a section handle', () => {
		for (const handle of ['S3', 's3', '§3', '3', ' S3 ', 'S3 Sampling', 'S3: Sampling']) {
			expect(mapSection(map, handle)?.title).toBe('Sampling');
		}
		expect(mapSection(map, 'S9')).toBeUndefined();
		expect(mapSection(map, 'Sampling')).toBeUndefined();
		expect(mapSection(map, '3.5 kHz')).toBeUndefined();
	});

	it('places a passage in its innermost section', () => {
		const nested: DocumentMap = {
			...map,
			sections: [
				{ ...map.sections[1], start: 1, end: 5, level: 1 },
				{ ...map.sections[2], start: 4, end: 5, level: 2 }
			]
		};
		expect(sectionAt(nested, 4)?.title).toBe('Sampling');
		expect(sectionAt(nested, 2)?.title).toBe('Fourier analysis');
		expect(sectionAt(nested, 9)).toBeUndefined();
	});
});

describe('mapText', () => {
	it('renders sections with markers, sizes, gists, and entry points', () => {
		const text = mapText(buildDocumentMap(signals()), 10_000);
		expect(text).toContain('Signals · 3 sections · 25 words');
		expect(text).toContain('S2 Fourier analysis ⟦1–5⟧ · 20 words · under a minute');
		expect(text).toContain('  S3 Sampling ⟦4–5⟧');
		expect(text).toContain('Opens: Any periodic signal is a sum of sines.');
		expect(text).toContain('• equation ⟦3⟧ E = mc^2');
	});

	it('states listening time in minutes and hours', () => {
		const doc = signals();
		doc.segments = doc.segments.map((segment, index) => ({
			...segment,
			estimatedDuration: index === 5 ? 7_140 : 60
		}));
		const text = mapText(buildDocumentMap(doc), 10_000);
		expect(text).toContain('25 words · 2 h 4 min of listening');
		expect(text).toContain('S1 Signals ⟦0–0⟧ · 5 words · 1 min');
		expect(text).toContain('S3 Sampling ⟦4–5⟧ · 7 words · 2 h');
	});

	it('drops detail from the deepest levels first to fit the budget', () => {
		const specs: BlockSpec[] = [];
		for (let chapter = 0; chapter < 30; chapter += 1) {
			specs.push({ id: `c${chapter}`, kind: 'heading', text: `Chapter ${chapter}`, level: 1 });
			specs.push({
				id: `c${chapter}p`,
				text: `Chapter ${chapter} opens with ${words(12, 'detail')}.`
			});
			for (let section = 0; section < 4; section += 1) {
				specs.push({
					id: `c${chapter}s${section}`,
					kind: 'heading',
					text: `Part ${chapter}.${section}`,
					level: 2
				});
				specs.push({
					id: `c${chapter}s${section}m`,
					kind: 'math',
					text: `x^${section} + y^${section}`
				});
			}
		}
		const map = buildDocumentMap(documentOf(specs));
		const roomy = mapText(map, 100_000);
		expect(roomy).toContain('• equation');
		const tight = mapText(map, 4_000);
		expect(tight.length).toBeLessThanOrEqual(4_000);
		expect(tight).not.toContain('• equation');
		expect(tight).toContain('+4 deeper sections');
		const tiny = mapText(map, 600);
		expect(tiny.length).toBeLessThanOrEqual(600);
		expect(tiny).toContain('search_document finds any passage');
	});
});

describe('tidyMath', () => {
	it('unwraps display styles, nested braces and all, and drops word joiners', () => {
		expect(
			tidyMath('where (\u2060 {\\displaystyle {\\widehat {f}}(\\xi )} \u2060) and {\\textstyle x}')
		).toBe('where ( {\\widehat {f}}(\\xi ) ) and x');
	});

	it('respects escaped braces and leaves an unclosed wrapper alone', () => {
		expect(tidyMath('{\\displaystyle \\{a\\}}')).toBe('\\{a\\}');
		expect(tidyMath('{\\displaystyle a + {b')).toBe('{\\displaystyle a + {b');
	});
});
