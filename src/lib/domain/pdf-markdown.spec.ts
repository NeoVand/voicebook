import { describe, expect, it } from 'vitest';
import type { DocumentBlock } from './types';
import {
	assemblePages,
	assignPageAnchors,
	blanketBoldShare,
	collapseSpacedHeadings,
	imageDataUri,
	normalizeHeadingLevels,
	outlineFromBookmarks,
	pageForOffset,
	pagesJoinSeam,
	pagesNeedingOcr,
	resolveImageRefs,
	stripBlanketBoldPage,
	stripRepeatedPageChrome,
	unwrapTextFences
} from './pdf-markdown';

function block(id: string, kind: DocumentBlock['kind'], text: string, extras: Partial<DocumentBlock> = {}): DocumentBlock {
	return {
		id,
		kind,
		text,
		anchor: {},
		speak: true,
		...extras
	} as DocumentBlock;
}

describe('pagesNeedingOcr', () => {
	const stats = (
		pageNumber: number,
		needsOcr: boolean,
		reasons: string[],
		textLength = 500
	) => ({ pageNumber, needsOcr, reasons, textLength });

	it('selects genuinely unreadable pages, not merely light ones', () => {
		expect(
			pagesNeedingOcr([
				stats(1, true, ['sparse-text']),
				stats(2, true, ['scanned']),
				stats(3, true, ['no-text']),
				stats(4, true, ['garbled']),
				stats(5, false, []),
				stats(6, true, ['embedded-images'])
			])
		).toEqual([2, 3, 4]);
	});

	it('treats a flagged page with almost no text as unreadable regardless of reason', () => {
		expect(pagesNeedingOcr([stats(1, true, ['sparse-text'], 12)])).toEqual([1]);
	});
});

describe('unwrapTextFences', () => {
	it('unwraps the fence LiteParse emits for OCR and blank pages', () => {
		expect(unwrapTextFences('```text\nRecovered line one.\n\nLine two.\n```')).toBe(
			'Recovered line one.\n\nLine two.'
		);
	});

	it('drops the empty fence of a blank page entirely', () => {
		expect(unwrapTextFences('```text\n\n```')).toBe('');
	});

	it('leaves real code fences alone', () => {
		const markdown = '```python\nprint("hi")\n```';
		expect(unwrapTextFences(markdown)).toBe(markdown);
	});
});

describe('collapseSpacedHeadings', () => {
	it('collapses letter-spaced headings, keeping word gaps', () => {
		expect(collapseSpacedHeadings('# R E F E R E N C E S')).toBe('# REFERENCES');
		expect(collapseSpacedHeadings('T A B L E  O F  C O N T E N T S')).toBe('TABLE OF CONTENTS');
	});

	it('leaves prose, initialisms, and mixed lines untouched', () => {
		expect(collapseSpacedHeadings('I am a U S citizen')).toBe('I am a U S citizen');
		expect(collapseSpacedHeadings('A B testing works')).toBe('A B testing works');
		expect(collapseSpacedHeadings('Normal heading text')).toBe('Normal heading text');
	});
});

describe('stripRepeatedPageChrome', () => {
	it('removes edge lines repeating across most pages, digits normalized', () => {
		const pages = [
			'Journal of Reading · 12\n\n# Introduction\n\nBody one.',
			'Journal of Reading · 13\n\nBody two.',
			'Journal of Reading · 14\n\nBody three.'
		];
		const cleaned = stripRepeatedPageChrome(pages);
		expect(cleaned[0]).toBe('# Introduction\n\nBody one.');
		expect(cleaned[1]).toBe('Body two.');
		expect(cleaned[2]).toBe('Body three.');
	});

	it('needs at least three pages and 60% repetition', () => {
		const two = ['Header\n\nBody.', 'Header\n\nMore.'];
		expect(stripRepeatedPageChrome(two)).toEqual(two);
		const sparse = ['Header\n\nA.', 'Other\n\nB.', 'Another\n\nC.'];
		expect(stripRepeatedPageChrome(sparse)).toEqual(sparse);
	});

	it('never strips structural lines from page edges', () => {
		const pages = [
			'# Chapter 1\n\nBody one.',
			'# Chapter 1\n\nBody two.',
			'# Chapter 1\n\nBody three.'
		];
		expect(stripRepeatedPageChrome(pages)).toEqual(pages);
	});
});

describe('blanket bold across pages', () => {
	it('computes the share document-wide and rewrites per page', () => {
		const pages = [
			'**Every line on this page is bold.**\n\n**And this one too.**',
			'**Second page keeps the pattern going.**'
		];
		expect(blanketBoldShare(pages)).toBe(1);
		expect(stripBlanketBoldPage(pages[0])).toBe(
			'Every line on this page is bold.\n\nAnd this one too.'
		);
	});

	it('a single deliberate callout does not reach the threshold', () => {
		const pages = ['Plain one.\n\n**A callout.**\n\nPlain two.', 'Plain three.'];
		expect(blanketBoldShare(pages)).toBeLessThan(0.6);
	});
});

describe('resolveImageRefs', () => {
	const image = (id: string, page: number, size: number, fill = 65) => ({
		id,
		page,
		format: 'png',
		bytes: new Uint8Array(size).fill(fill)
	});

	it('rewrites known references to data URIs and keeps alt text', () => {
		const { pages, warnings } = resolveImageRefs(
			['Before.\n\n![Figure 1](image_p1_0.png)\n\nAfter.'],
			[image('p1_0', 1, 8192)]
		);
		expect(pages[0]).toContain('![Figure 1](data:image/png;base64,');
		expect(warnings).toEqual([]);
	});

	it('drops unknown and decorative references without warning', () => {
		const { pages, warnings } = resolveImageRefs(
			['![](image_p1_0.png) and ![](image_p9_9.png)'],
			[image('p1_0', 1, 100)]
		);
		expect(pages[0]).not.toContain('image_p');
		expect(pages[0]).not.toContain('data:');
		expect(warnings).toEqual([]);
	});

	it('skips over-budget images and says so', () => {
		const { pages, warnings } = resolveImageRefs(
			['![](image_p1_0.png)'],
			[image('p1_0', 1, 8192)],
			{ perImageBytes: 4096 }
		);
		expect(pages[0]).not.toContain('data:');
		expect(warnings).toEqual(['One image was too large to keep and was skipped.']);
	});

	it('enforces the whole-document budget in order', () => {
		const { pages, warnings } = resolveImageRefs(
			['![](image_p1_0.png)', '![](image_p2_0.png)'],
			[image('p1_0', 1, 8192, 1), image('p2_0', 2, 8192, 2)],
			{ totalBytes: 10_000 }
		);
		expect(pages[0]).toContain('data:');
		expect(pages[1]).not.toContain('data:');
		expect(warnings.length).toBe(1);
	});

	it('drops an image repeated on three or more pages (logo, watermark)', () => {
		const logo = new Uint8Array(8192).fill(7);
		const { pages } = resolveImageRefs(
			['![](image_p1_0.png)', '![](image_p2_0.png)', '![](image_p3_0.png)'],
			[
				{ id: 'p1_0', page: 1, format: 'png', bytes: logo },
				{ id: 'p2_0', page: 2, format: 'png', bytes: logo },
				{ id: 'p3_0', page: 3, format: 'png', bytes: logo }
			]
		);
		expect(pages.every((page) => !page.includes('data:'))).toBe(true);
	});
});

describe('imageDataUri', () => {
	it('encodes bytes as a png data uri', () => {
		expect(imageDataUri({ id: 'p1_0', page: 1, format: 'png', bytes: [72, 105] })).toBe(
			`data:image/png;base64,${btoa('Hi')}`
		);
	});
});

describe('pagesJoinSeam', () => {
	it('detects hyphenated page breaks', () => {
		expect(pagesJoinSeam('The experi-', 'ment continued.')).toBe('hyphen');
	});

	it('detects mid-sentence page breaks', () => {
		expect(pagesJoinSeam('The sentence continues without', 'stopping at the page break.')).toBe(
			'space'
		);
	});

	it('keeps ordinary block boundaries', () => {
		expect(pagesJoinSeam('A finished sentence.', 'A new paragraph.')).toBe('break');
		expect(pagesJoinSeam('Text before.', '# Heading')).toBe('break');
		expect(pagesJoinSeam('| a | b |', 'lowercase after table')).toBe('break');
	});
});

describe('assemblePages + pageForOffset + assignPageAnchors', () => {
	it('round-trips block offsets to the correct pages', () => {
		const { markdown, spans } = assemblePages([
			{ page: 1, markdown: '# Title\n\nFirst page paragraph.' },
			{ page: 2, markdown: 'Second page paragraph.' }
		]);
		expect(markdown).toBe('# Title\n\nFirst page paragraph.\n\nSecond page paragraph.');
		const secondStart = markdown.indexOf('Second');
		expect(pageForOffset(spans, 0)).toBe(1);
		expect(pageForOffset(spans, secondStart)).toBe(2);
		const blocks = assignPageAnchors(
			[
				block('b0', 'heading', 'Title', { anchor: { start: 0, end: 7 } }),
				block('b1', 'paragraph', 'Second page paragraph.', {
					anchor: { start: secondStart, end: markdown.length }
				})
			],
			spans
		);
		expect(blocks[0].anchor.page).toBe(1);
		expect(blocks[1].anchor.page).toBe(2);
	});

	it('a paragraph mended across a page break anchors to its starting page', () => {
		const { markdown, spans } = assemblePages([
			{ page: 1, markdown: 'The claim holds because the evi-' },
			{ page: 2, markdown: 'dence points the same way.' }
		]);
		expect(markdown).toBe('The claim holds because the evidence points the same way.');
		expect(pageForOffset(spans, 5)).toBe(1);
		expect(pageForOffset(spans, markdown.length - 3)).toBe(2);
	});

	it('skips blank pages without emitting spans', () => {
		const { spans } = assemblePages([
			{ page: 1, markdown: 'Content.' },
			{ page: 2, markdown: '' },
			{ page: 3, markdown: 'More.' }
		]);
		expect(spans.map((span) => span.page)).toEqual([1, 3]);
	});

	it('does not stamp pages onto blocks that already have one', () => {
		const blocks = assignPageAnchors(
			[block('b0', 'paragraph', 'x', { anchor: { page: 7, start: 0 } })],
			[{ page: 1, start: 0, end: 10 }]
		);
		expect(blocks[0].anchor.page).toBe(7);
	});
});

describe('normalizeHeadingLevels', () => {
	it('caps each heading at one level deeper than the previous', () => {
		const blocks = normalizeHeadingLevels([
			block('b0', 'heading', 'Title', { level: 2 }),
			block('b1', 'paragraph', 'Text.'),
			block('b2', 'heading', 'Deep jump', { level: 5 }),
			block('b3', 'heading', 'Back up', { level: 2 })
		]);
		expect(blocks[0].level).toBe(1);
		expect(blocks[2].level).toBe(2);
		expect(blocks[3].level).toBe(2);
	});
});

describe('outlineFromBookmarks', () => {
	const docBlocks = [
		block('b0', 'heading', 'Introduction', { level: 1, anchor: { page: 1 } }),
		block('b1', 'paragraph', 'Text.', { anchor: { page: 1 } }),
		block('b2', 'heading', 'Methods', { level: 2, anchor: { page: 3 } }),
		block('b3', 'paragraph', 'More text.', { anchor: { page: 5 } })
	];

	it('matches bookmarks to headings by page and title', () => {
		const outline = outlineFromBookmarks(
			[
				{ title: '1. Introduction', page: 1, level: 1 },
				{ title: '2. Methods', page: 3, level: 1 }
			],
			docBlocks
		);
		expect(outline?.map((entry) => entry.blockId)).toEqual(['b0', 'b2']);
		expect(outline?.[0].page).toBe(1);
	});

	it('falls back to the first block on the destination page', () => {
		const outline = outlineFromBookmarks(
			[
				{ title: 'Introduction', page: 1, level: 1 },
				{ title: 'Appendix', page: 5, level: 1 }
			],
			docBlocks
		);
		expect(outline?.[1].blockId).toBe('b3');
	});

	it('returns null when fewer than two bookmarks resolve', () => {
		expect(outlineFromBookmarks([{ title: 'Only', page: 1, level: 1 }], docBlocks)).toBeNull();
		expect(
			outlineFromBookmarks(
				[
					{ title: 'Ghost', page: 99, level: 1 },
					{ title: 'Phantom', page: 99, level: 1 }
				],
				[block('b0', 'paragraph', 'no anchors')]
			)
		).toBeNull();
	});
});
