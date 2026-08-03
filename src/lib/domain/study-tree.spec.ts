import { describe, expect, it } from 'vitest';
import type { DocumentBlock, NormalizedDocument, OutlineEntry, SpeechSegment } from './types';
import {
	STUDY_NODE_CAP,
	STUDY_PROMPT_VERSION,
	abstractNeeded,
	abstractSourceHash,
	composeReaderState,
	composeStudyBlock,
	reconcileStudy,
	studyAbstractMessages,
	studySections,
	studySectionMessages
} from './study-tree';

function block(id: string, text: string, kind: DocumentBlock['kind'] = 'paragraph'): DocumentBlock {
	return { id, kind, text, speak: true, anchor: {} };
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

function outlineEntry(blockId: string, title: string, level: number): OutlineEntry {
	return { id: `outline-${blockId}`, blockId, title, level };
}

function doc(overrides: Partial<NormalizedDocument> = {}): NormalizedDocument {
	const blocks = [
		block('b0', 'Whale song carries context before any heading.'),
		block('h1', 'Songs', 'heading'),
		block('b1', 'Males sing in winter. Songs evolve every season.'),
		block('h2', 'Structure', 'heading'),
		block('b2', 'Themes repeat in order.'),
		block('h3', 'Migration', 'heading'),
		block('b3', 'Humpbacks travel to polar waters.')
	];
	const segments = [
		segment('b0:s0', 'b0', 'Whale song carries context before any heading.'),
		segment('h1:s0', 'h1', 'Songs'),
		segment('b1:s0', 'b1', 'Males sing in winter.'),
		segment('b1:s1', 'b1', 'Songs evolve every season.'),
		segment('h2:s0', 'h2', 'Structure'),
		segment('b2:s0', 'b2', 'Themes repeat in order.'),
		segment('h3:s0', 'h3', 'Migration'),
		segment('b3:s0', 'b3', 'Humpbacks travel to polar waters.')
	];
	return {
		id: 'doc',
		fingerprint: 'f',
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
			outlineEntry('h1', 'Songs', 1),
			outlineEntry('h2', 'Structure', 2),
			outlineEntry('h3', 'Migration', 1)
		],
		warnings: [],
		includeCode: false,
		...overrides
	};
}

describe('studySections', () => {
	it('partitions the document with an opening section for lead content', () => {
		const sections = studySections(doc());
		expect(sections.map((section) => section.title)).toEqual([
			'Whale Song',
			'Songs',
			'Structure',
			'Migration'
		]);
		expect(sections[0].text).toContain('before any heading');
		expect(sections[1].text).toContain('Males sing in winter.');
		expect(sections[1].text).not.toContain('Themes repeat');
		expect(sections[3].text).toContain('polar waters');
	});

	it('drops the deepest outline levels first to honor the cap', () => {
		const sections = studySections(doc(), 3);
		// Level 2 folds into its parent; the lead section stays.
		expect(sections.map((section) => section.title)).toEqual(['Whale Song', 'Songs', 'Migration']);
		expect(sections[1].text).toContain('Themes repeat in order.');
	});

	it('summarizes the whole document as one node when there is no outline', () => {
		const sections = studySections(doc({ outline: [] }));
		expect(sections).toHaveLength(1);
		expect(sections[0].title).toBe('Whale Song');
		expect(sections[0].text).toContain('polar waters');
	});

	it('clamps very long sections and marks the cut', () => {
		const long = 'A sentence about whales. '.repeat(600).trim();
		const sections = studySections(
			doc({
				outline: [],
				blocks: [block('b0', long)],
				segments: [segment('b0:s0', 'b0', long)]
			})
		);
		expect(sections[0].text.length).toBeLessThan(long.length);
		expect(sections[0].text.endsWith('(section continues)')).toBe(true);
	});

	it('never yields more nodes than the cap', () => {
		const blocks: DocumentBlock[] = [];
		const segments: SpeechSegment[] = [];
		const outline: OutlineEntry[] = [];
		for (let index = 0; index < 60; index += 1) {
			const id = `h${index}`;
			blocks.push(block(id, `Heading ${index}`, 'heading'));
			segments.push(segment(`${id}:s0`, id, `Heading ${index}`));
			outline.push(outlineEntry(id, `Heading ${index}`, 1));
		}
		const sections = studySections(doc({ blocks, segments, outline }));
		expect(sections.length).toBeLessThanOrEqual(STUDY_NODE_CAP);
	});
});

describe('reconcileStudy', () => {
	const ready = (id: string, sourceHash: string, summary: string) => ({
		id,
		blockId: id.replace('study:', ''),
		title: 'T',
		level: 1,
		status: 'ready' as const,
		summary,
		sourceHash,
		updatedAt: 1
	});

	it('queues every section of a fresh document', () => {
		const sections = studySections(doc());
		const { study, queue, changed } = reconcileStudy(sections, undefined);
		expect(queue).toHaveLength(sections.length);
		expect(changed).toBe(true);
		expect(study.nodes.every((node) => node.status === 'pending')).toBe(true);
		expect(study.promptVersion).toBe(STUDY_PROMPT_VERSION);
	});

	it('keeps ready summaries with matching hashes and queues nothing', () => {
		const sections = studySections(doc());
		const first = reconcileStudy(sections, undefined);
		const filled: typeof first.study = {
			...first.study,
			nodes: first.study.nodes.map((node) => ({
				...node,
				status: 'ready' as const,
				summary: `Summary of ${node.title}`
			}))
		};
		const again = reconcileStudy(sections, filled);
		expect(again.queue).toHaveLength(0);
		expect(again.study.nodes.every((node) => node.status === 'ready')).toBe(true);
	});

	it('rescues summaries by content hash when section ids shift', () => {
		const sections = studySections(doc());
		const target = sections[1];
		const stored = {
			nodes: [ready('study:old-id', target.sourceHash, 'Males sing; songs evolve.')],
			abstractStatus: 'pending' as const,
			promptVersion: STUDY_PROMPT_VERSION,
			updatedAt: 1
		};
		const { study, queue } = reconcileStudy(sections, stored);
		const rescued = study.nodes.find((node) => node.id === target.id);
		expect(rescued?.status).toBe('ready');
		expect(rescued?.summary).toBe('Males sing; songs evolve.');
		expect(queue.map((section) => section.id)).not.toContain(target.id);
	});

	it('requeues everything when the prompt version moves on', () => {
		const sections = studySections(doc());
		const stored = {
			nodes: sections.map((section) => ready(section.id, section.sourceHash, 'Old summary')),
			abstractStatus: 'ready' as const,
			abstract: 'Old abstract',
			promptVersion: STUDY_PROMPT_VERSION - 1,
			updatedAt: 1
		};
		const { study, queue } = reconcileStudy(sections, stored);
		expect(queue).toHaveLength(sections.length);
		expect(study.abstract).toBeUndefined();
	});

	it('keeps the abstract only while its distilled summaries are unchanged', () => {
		const sections = studySections(doc());
		const nodes = sections.map((section) => ({
			...ready(section.id, section.sourceHash, 'Stable'),
			title: section.title,
			level: section.level
		}));
		const stored = {
			nodes,
			abstract: 'The whole document in a paragraph.',
			abstractStatus: 'ready' as const,
			abstractHash: abstractSourceHash(nodes),
			promptVersion: STUDY_PROMPT_VERSION,
			updatedAt: 1
		};
		const kept = reconcileStudy(sections, stored);
		expect(kept.study.abstract).toBe('The whole document in a paragraph.');
		expect(kept.study.abstractStatus).toBe('ready');

		const drifted = reconcileStudy(sections, { ...stored, abstractHash: 'stale' });
		expect(drifted.study.abstract).toBeUndefined();
		expect(drifted.study.abstractStatus).toBe('pending');
	});
});

describe('abstractNeeded', () => {
	it('waits for pending nodes, then asks once summaries settle', () => {
		const sections = studySections(doc());
		const { study } = reconcileStudy(sections, undefined);
		expect(abstractNeeded(study)).toBe(false);
		const settled = {
			...study,
			nodes: study.nodes.map((node, index) => ({
				...node,
				status: index === 0 ? ('failed' as const) : ('ready' as const),
				summary: index === 0 ? undefined : 'Done'
			}))
		};
		expect(abstractNeeded(settled)).toBe(true);
		const withAbstract = {
			...settled,
			abstract: 'All settled.',
			abstractStatus: 'ready' as const,
			abstractHash: abstractSourceHash(settled.nodes)
		};
		expect(abstractNeeded(withAbstract)).toBe(false);
	});
});

describe('prompts and instruction block', () => {
	it('builds section and abstract messages around the content', () => {
		const sections = studySections(doc());
		const messages = studySectionMessages('Whale Song', sections[1]);
		expect(messages[0].role).toBe('system');
		expect(messages[1].content).toContain('Section: Songs');
		expect(messages[1].content).toContain('Males sing in winter.');

		const { study } = reconcileStudy(sections, undefined);
		const nodes = study.nodes.map((node) => ({
			...node,
			status: 'ready' as const,
			summary: `About ${node.title}.`
		}));
		const abstract = studyAbstractMessages('Whale Song', nodes);
		expect(abstract[1].content).toContain('- Songs: About Songs.');
	});

	it('composes the study block with markers and indentation', () => {
		const book = doc();
		const sections = studySections(book);
		const { study } = reconcileStudy(sections, undefined);
		book.study = {
			...study,
			abstract: 'Whales sing structured songs and migrate.',
			abstractStatus: 'ready',
			nodes: study.nodes.map((node) => ({
				...node,
				status: 'ready' as const,
				summary: `Covers ${node.title.toLowerCase()}.`
			}))
		};
		const text = composeStudyBlock(book);
		expect(text).toContain('Abstract: Whales sing structured songs and migrate.');
		expect(text).toContain('- ⟦1⟧ Songs — Covers songs.');
		expect(text).toContain('  - ⟦4⟧ Structure — Covers structure.');
	});

	it('returns an empty block when nothing is ready', () => {
		const book = doc();
		expect(composeStudyBlock(book)).toBe('');
		const sections = studySections(book);
		book.study = reconcileStudy(sections, undefined).study;
		expect(composeStudyBlock(book)).toBe('');
	});
});

describe('composeReaderState', () => {
	const withStudy = () => {
		const book = doc();
		const { study } = reconcileStudy(studySections(book), undefined);
		book.study = {
			...study,
			nodes: study.nodes.map((node) => ({
				...node,
				status: 'ready' as const,
				summary: `About ${node.title}.`
			}))
		};
		return book;
	};

	it('is empty without any history', () => {
		expect(composeReaderState(doc())).toBe('');
		expect(composeReaderState(withStudy())).toBe('');
	});

	it('reports the last session, saved notes, and section coverage', () => {
		const now = 1_700_000_000_000;
		const book = withStudy();
		book.memories = [
			{
				id: 'm1',
				text: 'Reader wants to revisit how themes repeat.',
				blockId: 'b2',
				origin: 'assistant',
				createdAt: 1,
				updatedAt: 1
			},
			{
				id: 'm2',
				text: 'A note whose anchor no longer exists.',
				blockId: 'gone',
				origin: 'assistant',
				createdAt: 2,
				updatedAt: 2
			}
		];
		book.conversation = {
			discussedBlockIds: ['h2', 'b2'],
			lastBlockId: 'b2',
			lastSessionAt: now - 86_400_000
		};
		book.listened = {
			'h1:s0': [{ start: 0, end: 2 }],
			'b1:s0': [{ start: 0, end: 3 }]
		};
		const state = composeReaderState(book, now);
		expect(state).toContain('Last conversation: yesterday, leaving off around "Structure" ⟦5⟧.');
		expect(state).toContain('- ⟦5⟧ Reader wants to revisit how themes repeat.');
		expect(state).toContain('- A note whose anchor no longer exists.');
		expect(state).toContain('Heard in playback: Songs.');
		expect(state).toContain('Discussed with you: Structure.');
		expect(state).toContain('Not yet visited:');
		expect(state).toContain('Migration ⟦6⟧');
	});

	it('still reports memories when there is no study tree', () => {
		const book = doc();
		book.memories = [
			{
				id: 'm1',
				text: 'Songs evolve seasonally.',
				origin: 'assistant',
				createdAt: 1,
				updatedAt: 1
			}
		];
		const state = composeReaderState(book, 10);
		expect(state).toContain('Songs evolve seasonally.');
		expect(state).not.toContain('Not yet visited');
	});
});
