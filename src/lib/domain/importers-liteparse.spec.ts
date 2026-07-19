import { describe, expect, it } from 'vitest';
import {
	liteparsePageMarkdown,
	parsedSourceFromLiteparse,
	pdfLooksScanned,
	stripBlanketBold,
	type LiteparseResultLike
} from './importers';

describe('liteparsePageMarkdown', () => {
	it('prefers page markdown and falls back to plain text', () => {
		expect(
			liteparsePageMarkdown([
				{ markdown: '# Title\n\nBody.', text: 'Title Body.' },
				{ markdown: '  ', text: 'Second page text.' },
				{ text: '' },
				{}
			])
		).toBe('# Title\n\nBody.\n\nSecond page text.');
	});

	it('returns an empty string for no usable pages', () => {
		expect(liteparsePageMarkdown([])).toBe('');
		expect(liteparsePageMarkdown([{ markdown: '', text: '' }])).toBe('');
	});
});

describe('stripBlanketBold', () => {
	it('unwraps body paragraphs when nearly everything is bold', () => {
		const markdown = [
			'# Field Notes',
			'',
			'**Reinforcement learning studies agents that improve through interaction.**',
			'',
			'## Core quantities',
			'',
			'**The three quantities below appear in nearly every formulation.**',
			'',
			'| Symbol | Name |',
			'|---|---|',
			'| S | State |'
		].join('\n');
		const cleaned = stripBlanketBold(markdown);
		expect(cleaned).toContain(
			'Reinforcement learning studies agents that improve through interaction.'
		);
		expect(cleaned).not.toContain('**Reinforcement');
		// Headings and tables are untouched.
		expect(cleaned).toContain('# Field Notes');
		expect(cleaned).toContain('| S | State |');
	});

	it('leaves selective emphasis alone', () => {
		const markdown = [
			'Plain paragraph one.',
			'',
			'**A deliberately bold callout.**',
			'',
			'Plain paragraph two.',
			'',
			'Plain paragraph three with **inline bold** kept.'
		].join('\n');
		expect(stripBlanketBold(markdown)).toBe(markdown);
	});
});

describe('pdfLooksScanned', () => {
	it('flags documents with almost no embedded text', () => {
		expect(pdfLooksScanned('', 3)).toBe(true);
		expect(pdfLooksScanned('| - | - |', 1)).toBe(true);
	});

	it('accepts documents with a real text layer', () => {
		const page = 'Reinforcement learning studies agents that improve through interaction.';
		expect(pdfLooksScanned(page, 1)).toBe(false);
		expect(pdfLooksScanned(Array(10).fill(page).join('\n\n'), 10)).toBe(false);
	});

	it('scales the threshold with page count', () => {
		const thin = 'twenty five letters here now'; // > 24 letters, < 8 per page × 30
		expect(pdfLooksScanned(thin, 1)).toBe(false);
		expect(pdfLooksScanned(thin, 30)).toBe(true);
	});
});

describe('parsedSourceFromLiteparse', () => {
	// A synthetic ParseResult drives the whole post-wasm pipeline in node,
	// where the wasm itself cannot initialize.
	const result = (
		pages: Array<Partial<LiteparseResultLike['pages'][number]>>,
		images: LiteparseResultLike['images'] = []
	): LiteparseResultLike => ({
		pages: pages.map((page, index) => ({
			pageNum: index + 1,
			width: 612,
			height: 792,
			...page
		})),
		images
	});

	it('builds page-anchored blocks from per-page markdown', () => {
		const parsed = parsedSourceFromLiteparse(
			result([
				{ markdown: '# The Anatomy of Reading\n\nFirst page paragraph.' },
				{ markdown: 'Second page paragraph.' }
			])
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.title).toBe('The Anatomy of Reading');
		const paragraphs = parsed!.blocks.filter((candidate) => candidate.kind === 'paragraph');
		expect(paragraphs[0].anchor.page).toBe(1);
		expect(paragraphs[1].anchor.page).toBe(2);
		expect(parsed?.pages?.map((page) => page.page)).toEqual([1, 2]);
	});

	it('replaces the empty fence of a scanned page with recognized text and marks it', () => {
		const parsed = parsedSourceFromLiteparse(
			result([
				{ markdown: '# Title\n\nReal first page text.' },
				{ markdown: '```text\n\n```' },
				{ markdown: 'Closing page text.' }
			]),
			new Map([[2, 'Recovered scanned paragraph.']])
		);
		const texts = parsed!.blocks.map((candidate) => candidate.text);
		expect(texts).toContain('Recovered scanned paragraph.');
		expect(parsed?.pages?.[1]).toMatchObject({ page: 2, ocr: true });
		expect(parsed?.pages?.[0].ocr).toBeUndefined();
	});

	it('turns embedded image references into image paragraphs', () => {
		const parsed = parsedSourceFromLiteparse(
			result(
				[{ markdown: 'Intro paragraph text for the figure.\n\n![](image_p1_0.png)' }],
				[{ id: 'p1_0', page: 1, format: 'png', bytes: new Uint8Array(8192).fill(65) }]
			)
		);
		const withImage = parsed!.blocks.find((candidate) =>
			candidate.inlines?.some((run) => run.image)
		);
		expect(withImage?.inlines?.[0].image?.src).toMatch(/^data:image\/png;base64,/);
	});

	it('mends a sentence split across a page break into one paragraph', () => {
		const parsed = parsedSourceFromLiteparse(
			result([
				{ markdown: 'The evidence continues across the page bound-' },
				{ markdown: 'ary without a break.' }
			])
		);
		const paragraph = parsed!.blocks.find((candidate) => candidate.kind === 'paragraph');
		expect(paragraph?.text).toBe(
			'The evidence continues across the page boundary without a break.'
		);
		expect(paragraph?.anchor.page).toBe(1);
	});

	it('keeps substantial native text even when recognition ran for the page', () => {
		const parsed = parsedSourceFromLiteparse(
			result([
				{
					markdown:
						'## Partly Garbled\n\nThe native extraction of this page still carries real structure and enough text to keep.'
				},
				{ markdown: 'A second page so the outline math has company.' }
			]),
			new Map([[1, 'Flat OCR text that must not replace the native structure.']])
		);
		const texts = parsed!.blocks.map((candidate) => candidate.text);
		expect(texts).toContain('Partly Garbled');
		expect(texts.join(' ')).not.toContain('Flat OCR text');
		// The page keeps its native provenance — no ocr flag.
		expect(parsed?.pages?.[0].ocr).toBeUndefined();
	});

	it('defuses a document-leading horizontal rule before it reads as frontmatter', () => {
		const parsed = parsedSourceFromLiteparse(
			result([
				{ markdown: '---\n\nOpening prose that must stay narrated.\n\n---\n\nMore prose.' },
				{ markdown: 'Second page paragraph.' }
			])
		);
		const texts = parsed!.blocks.map((candidate) => candidate.text);
		expect(texts.join(' ')).toContain('Opening prose that must stay narrated.');
		expect(parsed!.blocks.some((candidate) => candidate.kind === 'frontmatter')).toBe(false);
	});

	it('returns null when nothing survives cleanup', () => {
		expect(parsedSourceFromLiteparse(result([{ markdown: '```text\n\n```' }]))).toBeNull();
	});

	it('falls back to plain page text and default dimensions', () => {
		const parsed = parsedSourceFromLiteparse({
			pages: [{ pageNum: 1, text: 'Only plain text extraction survived on this page.' }],
			images: []
		});
		expect(parsed?.blocks[0]?.text).toBe('Only plain text extraction survived on this page.');
		expect(parsed?.pages?.[0]).toMatchObject({ page: 1, width: 612, height: 792 });
	});

	it('propagates image-budget warnings from reference resolution', () => {
		const parsed = parsedSourceFromLiteparse(
			result(
				[{ markdown: 'A paragraph before the oversized figure.\n\n![](image_p1_0.png)' }],
				[{ id: 'p1_0', page: 1, format: 'png', bytes: new Uint8Array(3_000_000).fill(1) }]
			)
		);
		expect(parsed?.warnings).toEqual(['One image was too large to keep and was skipped.']);
	});
});
