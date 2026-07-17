import {
	Document,
	ExternalHyperlink,
	HeadingLevel,
	ImageRun,
	Math,
	MathRun,
	MathSuperScript,
	Packer,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun
} from 'docx';
import { DOMParser } from 'linkedom';
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	DOCUMENT_NORMALIZATION_VERSION,
	ImportError,
	documentFromText,
	fingerprint,
	importFile,
	kindForFile,
	pageLines,
	repeatedEdgeLines
} from './importers';

beforeAll(() => {
	Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
	Object.defineProperty(globalThis, 'DOMMatrix', { value: DOMMatrix, configurable: true });
	Object.defineProperty(globalThis, 'ImageData', { value: ImageData, configurable: true });
	Object.defineProperty(globalThis, 'Path2D', { value: Path2D, configurable: true });
});

describe('document importers', () => {
	it('detects supported formats by MIME type or extension', () => {
		expect(kindForFile({ name: 'book.PDF', type: '' })).toBe('pdf');
		expect(
			kindForFile({
				name: 'book',
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			})
		).toBe('docx');
		expect(kindForFile({ name: 'notes.mdown', type: '' })).toBe('markdown');
		expect(kindForFile({ name: 'notes.unknown', type: 'text/plain' })).toBe('text');
		expect(kindForFile({ name: 'book.docx', type: '' })).toBe('docx');
		expect(kindForFile({ name: 'README', type: 'text/markdown' })).toBe('markdown');
		expect(kindForFile({ name: 'notes.text', type: '' })).toBe('text');
		expect(() => kindForFile({ name: 'archive.zip', type: 'application/zip' })).toThrowError(
			ImportError
		);
	});

	it('creates stable SHA-256 fingerprints', async () => {
		await expect(fingerprint(new Blob(['voicebook']))).resolves.toBe(
			'1196ee5bcd53f20e136b08d4b6ad36dd56f9f2781a86f1e34ae82dfb16a704d9'
		);
	});

	it('imports BOM-aware text into paragraphs and sentence units', async () => {
		const document = await importFile(
			new File(['\uFEFFFirst line\ncontinues.\n\nSecond paragraph.'], 'calm_notes.txt', {
				type: 'text/plain'
			})
		);
		expect(document.title).toBe('calm notes');
		expect(document.blocks.map((item) => item.text)).toEqual([
			'First line continues.',
			'Second paragraph.'
		]);
		expect(document.segments).toHaveLength(2);
	});

	it('preserves semantic Markdown without rendering raw HTML', async () => {
		const markdown = [
			'# Listening well',
			'',
			'A **calm** paragraph with [a link](https://example.com).',
			'',
			'> A useful quotation.',
			'',
			'- First item',
			'- Second item',
			'',
			'```ts',
			'const privateByDefault = true;',
			'```',
			'',
			'```mermaid',
			'flowchart LR',
			'  Document --> Speech',
			'```',
			'',
			'<script>alert(1)</script>'
		].join('\n');
		const document = await importFile(new File([markdown], 'guide.md', { type: 'text/markdown' }));
		expect(document.title).toBe('Listening well');
		expect(document.normalizationVersion).toBe(DOCUMENT_NORMALIZATION_VERSION);
		expect(document.outline[0]).toMatchObject({ title: 'Listening well', level: 1 });
		expect(document.blocks.map((item) => item.kind)).toEqual([
			'heading',
			'paragraph',
			'quote',
			'paragraph',
			'list',
			'list-item',
			'list-item',
			'code',
			'mermaid'
		]);
		const quote = document.blocks.find((item) => item.kind === 'quote');
		expect(quote?.children).toHaveLength(1);
		expect(document.blocks.find((item) => item.parentId === quote?.id)).toMatchObject({
			kind: 'paragraph',
			text: 'A useful quotation.'
		});
		expect(document.blocks.find((item) => item.codeLanguage === 'mermaid')).toMatchObject({
			kind: 'mermaid',
			text: 'flowchart LR\n  Document --> Speech',
			speak: false
		});
		// Mermaid diagrams narrate via a deterministic fallback until an LLM
		// rewrite arrives.
		expect(
			document.segments.find((segment) => segment.narration?.constructKind === 'mermaid')?.text
		).toBe('A flowchart is shown here.');
		expect(
			document.blocks.filter((item) => item.kind === 'code').every((item) => !item.speak)
		).toBe(true);
		expect(document.segments.some((segment) => segment.text.includes('alert'))).toBe(false);
		const paragraph = document.blocks.find((item) => item.kind === 'paragraph');
		expect(paragraph?.inlines).toEqual([
			{ text: 'A ' },
			{ text: 'calm', marks: ['strong'] },
			{ text: ' paragraph with ' },
			{ text: 'a link', href: 'https://example.com/' },
			{ text: '.' }
		]);
		expect(paragraph?.anchor).toEqual({
			start: markdown.indexOf('A **calm**'),
			end:
				markdown.indexOf('A **calm**') +
				'A **calm** paragraph with [a link](https://example.com).'.length
		});
	});

	it('preserves inline and display mathematics alongside fenced code', async () => {
		const markdown = [
			'# Technical notes',
			'',
			'The identity $e^{i\\pi} + 1 = 0$ stays inline.',
			'',
			'$$',
			'\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
			'$$',
			'',
			'```typescript',
			'const answer: number = 42;',
			'```'
		].join('\n');
		const document = await importFile(
			new File([markdown], 'technical.md', { type: 'text/markdown' })
		);
		const paragraph = document.blocks.find((item) => item.kind === 'paragraph');
		const equation = document.blocks.find((item) => item.kind === 'math');
		const code = document.blocks.find((item) => item.kind === 'code');

		expect(paragraph?.inlines?.find((run) => run.math)).toEqual({
			text: 'e^{i\\pi} + 1 = 0',
			math: true
		});
		expect(equation).toMatchObject({
			kind: 'math',
			text: '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
			speak: false
		});
		expect(code).toMatchObject({
			kind: 'code',
			codeLanguage: 'typescript',
			text: 'const answer: number = 42;',
			speak: false
		});
	});

	it('links footnote references to preserved note content', async () => {
		const markdown =
			'A private reader keeps its context.[^privacy]\n\n[^privacy]: Nothing is uploaded.';
		const document = await importFile(new File([markdown], 'notes.md', { type: 'text/markdown' }));
		const paragraph = document.blocks.find((item) => item.kind === 'paragraph');
		const footnote = document.blocks.find((item) => item.kind === 'footnote');

		expect(paragraph?.inlines?.at(-1)).toEqual({
			text: '[privacy]',
			href: '#footnote-privacy'
		});
		expect(footnote).toMatchObject({
			id: 'b1',
			kind: 'footnote',
			footnoteId: 'footnote-privacy',
			footnoteLabel: 'privacy',
			text: 'Nothing is uploaded.',
			speak: true
		});
	});

	it('handles frontmatter titles, source offsets, and malformed fences', async () => {
		const markdown = [
			'---',
			'title: "A frontmatter title"',
			'tags: [local, private]',
			'---',
			'',
			'# The visible title wins',
			'',
			'An ordinary paragraph.',
			'',
			'```ts',
			'const unfinished = true;'
		].join('\n');
		const document = await importFile(new File([markdown], 'frontmatter.md'));
		expect(document.title).toBe('The visible title wins');
		expect(document.blocks[0]).toMatchObject({
			kind: 'frontmatter',
			codeLanguage: 'yaml',
			speak: false,
			anchor: { start: 0 }
		});
		expect(document.blocks[1].anchor.start).toBe(markdown.indexOf('# The visible title'));
		expect(document.blocks.at(-1)).toMatchObject({
			kind: 'code',
			codeLanguage: 'ts',
			speak: false
		});

		const fallback = await importFile(
			new File(['+++\ntitle = "Metadata only"\n+++\n\nBody.'], 'fallback.md')
		);
		expect(fallback.title).toBe('Metadata only');
	});

	it('retains GFM lists, tasks, tables, and safe inline marks', async () => {
		const markdown = [
			'3. Third',
			'4. Fourth',
			'   - Nested **detail**',
			'',
			'- [x] Finished',
			'- [ ] Waiting',
			'',
			'~~Removed~~ and *quiet* with `inline()` and [unsafe](javascript:alert(1)).',
			'',
			'| Voice | Language |',
			'| :--- | ---: |',
			'| F1 | English |',
			'| M2 | Korean |'
		].join('\n');
		const document = await importFile(new File([markdown], 'gfm.md'));
		const listItems = document.blocks.filter((item) => item.kind === 'list-item');
		expect(listItems.map((item) => item.list)).toMatchObject([
			{ ordered: true, depth: 0, index: 0, start: 3 },
			{ ordered: true, depth: 0, index: 1, start: 3 },
			{ ordered: false, depth: 1, index: 0 },
			{ ordered: false, depth: 0, index: 0, checked: true },
			{ ordered: false, depth: 0, index: 1, checked: false }
		]);
		const markedParagraph = document.blocks.find(
			(item) => item.kind === 'paragraph' && item.text.includes('Removed')
		);
		expect(markedParagraph?.inlines).toEqual([
			{ text: 'Removed', marks: ['delete'] },
			{ text: ' and ' },
			{ text: 'quiet', marks: ['emphasis'] },
			{ text: ' with ' },
			{ text: 'inline()', marks: ['code'] },
			{ text: ' and unsafe.' }
		]);
		const table = document.blocks.find((item) => item.kind === 'table');
		expect(table?.table).toMatchObject({
			align: ['left', 'right'],
			header: [{ text: 'Voice' }, { text: 'Language' }],
			rows: [
				[{ text: 'F1' }, { text: 'English' }],
				[{ text: 'M2' }, { text: 'Korean' }]
			]
		});
	});

	it('keeps hard breaks, images, inline HTML, anchors, and dividers safe', async () => {
		const markdown = [
			'Paragraph with [a section](#local "Jump there"), [mail](mailto:hello@example.com), and ![Cover art](cover.png).',
			'',
			'Hard  ',
			'break with <kbd>Enter</kbd> and an empty image ![](missing.png).',
			'',
			'---'
		].join('\n');
		const document = await importFile(new File([markdown], 'safe-markup.md'));
		const first = document.blocks[0];
		expect(first.inlines).toEqual([
			{ text: 'Paragraph with ' },
			{ text: 'a section', href: '#local', title: 'Jump there' },
			{ text: ', ' },
			{ text: 'mail', href: 'mailto:hello@example.com' },
			{ text: ', and ' },
			{
				text: 'Cover art',
				image: { src: undefined, alt: 'Cover art', title: undefined }
			},
			{ text: '.' }
		]);
		expect(document.blocks[1].inlines).toEqual([
			{ text: 'Hard break with ' },
			{ text: 'Enter', marks: ['kbd'] },
			{ text: ' and an empty image ' },
			{
				text: 'Image',
				image: { src: undefined, alt: '', title: undefined }
			},
			{ text: '.' }
		]);
		expect(document.blocks[2]).toMatchObject({ kind: 'divider', text: '', speak: false });

		const unclosed = await importFile(new File(['\uFEFF---\ntitle: Still Markdown'], 'open.md'));
		expect(unclosed.blocks.every((item) => item.kind !== 'frontmatter')).toBe(true);
	});

	it('preserves extended Markdown containers and sanitizes embedded HTML', async () => {
		const markdown = [
			'> [!WARNING]',
			'> Read this before continuing.',
			'',
			'1. Parent item',
			'   - Nested item',
			'     > Nested quote',
			'',
			'Term',
			': Definition with **bold** text.',
			': > Nested quote.',
			'',
			'```math',
			'\\operatorname{tr}(A) = \\sum_i A_{ii}',
			'```',
			'',
			'<details>',
			'<summary>More context</summary>',
			'',
			'- Hidden list item',
			'',
			'</details>',
			'',
			'<div style="border-left: 4px solid red"><strong>Safe callout</strong><script>bad()</script></div>'
		].join('\n');
		const document = await importFile(new File([markdown], 'extended.md'));
		const alert = document.blocks.find((item) => item.kind === 'alert');
		const lists = document.blocks.filter((item) => item.kind === 'list');
		const definition = document.blocks.find((item) => item.kind === 'definition-list');
		const details = document.blocks.find((item) => item.kind === 'details');
		const html = document.blocks.find((item) => item.kind === 'html');

		expect(alert).toMatchObject({ alertKind: 'warning', speak: false });
		expect(document.blocks.find((item) => item.parentId === alert?.id)?.text).toBe(
			'Read this before continuing.'
		);
		expect(lists).toHaveLength(3);
		expect(lists.map((item) => item.list?.depth)).toEqual([0, 1, 0]);
		expect(definition?.children).toHaveLength(3);
		expect(document.blocks.find((item) => item.kind === 'definition-term')?.text).toBe('Term');
		const nestedDefinition = document.blocks.find(
			(item) => item.kind === 'definition-description' && item.children?.length
		);
		expect(document.blocks.find((item) => item.parentId === nestedDefinition?.id)).toMatchObject({
			kind: 'quote'
		});
		expect(document.blocks.find((item) => item.kind === 'math')).toMatchObject({
			text: '\\operatorname{tr}(A) = \\sum_i A_{ii}',
			speak: false
		});
		expect(details).toMatchObject({ detailsSummary: 'More context', speak: false });
		expect(details?.children).toHaveLength(1);
		expect(html?.text).toContain('Safe callout');
		expect(JSON.stringify(html?.html)).not.toContain('script');
		expect(document.segments.some((segment) => segment.text.includes('bad'))).toBe(false);
	});

	it('retains supported inline HTML marks, progress, and safe image sources', async () => {
		const markdown = [
			"Text <sub>sub</sub> <sup>sup</sup> <mark>marked</mark> <kbd>Enter</kbd> <abbr title='Hypertext'>HTML</abbr>.",
			'',
			'Progress <progress value=120 max=100></progress> and default <progress></progress> plus a break<br>here.',
			'',
			'![Embedded](data:image/png;base64,AA== "Tiny") and ![Remote](blob:https://example.com/id).'
		].join('\n');
		const document = await importFile(new File([markdown], 'inline-html.md'));
		const runs = document.blocks.flatMap((item) => item.inlines ?? []);

		expect(runs.filter((item) => item.marks?.length).map((item) => item.marks?.[0])).toEqual([
			'sub',
			'sup',
			'mark',
			'kbd',
			'abbr'
		]);
		expect(runs.find((item) => item.marks?.includes('abbr'))).toMatchObject({
			text: 'HTML',
			title: 'Hypertext'
		});
		expect(runs.filter((item) => item.progress).map((item) => item.progress)).toEqual([
			{ value: 100, max: 100 },
			{ value: 0, max: 1 }
		]);
		expect(runs.filter((item) => item.image).map((item) => item.image)).toEqual([
			{
				src: 'data:image/png;base64,AA==',
				alt: 'Embedded',
				title: 'Tiny'
			},
			{ src: 'blob:https://example.com/id', alt: 'Remote', title: undefined }
		]);
	});

	it('allowlists rich HTML structure and drops unsafe elements and attributes', async () => {
		const markdown = [
			'<div style="padding: 1rem; background: red" onclick="bad()">',
			'<p><span><strong>Strong</strong> <em>emphasis</em> <del>gone</del> <sub>sub</sub> <sup>sup</sup> <mark>mark</mark> <kbd>K</kbd> <abbr title="Accessible">abbr</abbr> <abbr>plain</abbr></span></p>',
			'<p><a href="https://example.com" title="Allowed">Good link</a> <a href="javascript:bad()">Bad link text</a></p>',
			'<p><img src="https://example.com/image.png" alt="Example" title="Preview" width="100" height="80"><img src="https://example.com/plain.png" alt="Plain" width="wide" height="bad"><img alt="Missing"><img src="javascript:bad()" alt="Unsafe"></p>',
			'<br><unknown>Unwrapped text</unknown>',
			'<table><thead><tr><th colspan="2" rowspan="1">Header</th><th>Plain</th></tr></thead><tbody><tr><td colspan="2">Cell</td><td>Plain</td></tr></tbody></table>',
			'<progress value="150" max="100"></progress><progress></progress>',
			'<!-- nested comment -->',
			'<button>Removed button</button><iframe>Removed frame</iframe><script>bad()</script>',
			'</div>'
		].join('\n');
		const document = await importFile(new File([markdown], 'safe-html.md'));
		const html = document.blocks.find((item) => item.kind === 'html');
		const serialized = JSON.stringify(html?.html);

		expect(html?.text).toContain('Strong emphasis gone sub sup mark K abbr');
		expect(html?.text).toContain('Bad link text');
		expect(html?.text).toContain('Unwrapped text');
		expect(html?.text).not.toContain('Removed');
		expect(serialized).toContain('"variant":"callout"');
		expect(serialized).toContain('"href":"https://example.com/"');
		expect(serialized).not.toContain('javascript');
		expect(serialized).not.toContain('onclick');
		expect(serialized).toContain('"width":100');
		expect(serialized).toContain('"height":80');
		expect(serialized).toContain('"colspan":2');
		expect(serialized).toContain('"rowspan":1');
		expect(serialized).toContain('"value":100');
	});

	it('recovers from sparse HTML containers and reference definitions', async () => {
		const markdown = [
			'<details><summary>Inline <strong>summary</strong><script>bad()</script></summary>',
			'',
			'Inline details body.',
			'',
			'</details>',
			'',
			'</details>',
			'',
			'<details>',
			'',
			'Unclosed details body.'
		].join('\n');
		const document = await importFile(new File([markdown], '.md'));
		const details = document.blocks.filter((item) => item.kind === 'details');

		expect(document.title).toBe('Untitled');
		expect(details[0]).toMatchObject({ detailsSummary: 'Inline summary' });
		expect(document.blocks.find((item) => item.parentId === details[0].id)?.text).toBe(
			'Inline details body.'
		);
		expect(details[1]).toMatchObject({ detailsSummary: 'Details', children: [] });
		expect(document.blocks.some((item) => item.text === 'Unclosed details body.')).toBe(true);
		const references = await importFile(
			new File(
				[
					[
						'[reference]: https://example.com',
						'[image]: https://example.com/reference.png "Referenced image"',
						'',
						'Use [reference].',
						'',
						'![Reference art][image]'
					].join('\n')
				],
				'references.md'
			)
		);
		expect(
			references.blocks.find((item) => item.text === 'Use reference.')?.inlines
		).toContainEqual({
			text: 'reference',
			href: 'https://example.com/'
		});
		expect(
			references.blocks.flatMap((item) => item.inlines ?? []).find((item) => item.image)?.image
		).toEqual({
			src: 'https://example.com/reference.png',
			alt: 'Reference art',
			title: 'Referenced image'
		});
	});

	it('keeps container-only list items and footnotes navigable', async () => {
		const markdown = [
			'- > Quote-only list item',
			'',
			'Reference.[^nested]',
			'',
			'[^nested]:',
			'    - Footnote list item'
		].join('\n');
		const document = await importFile(new File([markdown], 'container-only.md'));
		const listItem = document.blocks.find((item) => item.kind === 'list-item');
		const footnote = document.blocks.find((item) => item.kind === 'footnote');

		expect(document.blocks.find((item) => item.parentId === listItem?.id)).toMatchObject({
			kind: 'quote'
		});
		expect(footnote).toMatchObject({ text: '', speak: false });
		expect(document.blocks.find((item) => item.parentId === footnote?.id)).toMatchObject({
			kind: 'list'
		});
	});

	it('imports a semantic DOCX fixture with tables and equations', async () => {
		const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] });
		const bytes = await Packer.toBuffer(
			new Document({
				sections: [
					{
						children: [
							new Paragraph({ text: 'A local book', heading: HeadingLevel.HEADING_1 }),
							new Paragraph('The document stays inside this browser.'),
							new Paragraph({ text: 'A list entry', bullet: { level: 0 } }),
							new Paragraph({ text: 'A nested entry', bullet: { level: 1 } }),
							new Paragraph({
								children: [
									new ImageRun({
										type: 'png',
										data: Uint8Array.from(
											atob(
												'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
											),
											(c) => c.charCodeAt(0)
										),
										transformation: { width: 8, height: 8 },
										altText: {
											title: 'A tiny square',
											description: 'A tiny square',
											name: 'square'
										}
									})
								]
							}),
							new Table({
								rows: [
									new TableRow({ children: [cell('City'), cell('Country')] }),
									new TableRow({ children: [cell('Zurich'), cell('Switzerland')] })
								]
							}),
							new Paragraph({
								children: [
									new TextRun({ text: 'Bold', bold: true }),
									new TextRun({ text: ' and ' }),
									new TextRun({ text: 'italic', italics: true }),
									new TextRun({ text: ' and ' }),
									new TextRun({ text: 'struck', strike: true }),
									new TextRun({ text: ' beside ' }),
									new ExternalHyperlink({
										children: [new TextRun('a link')],
										link: 'https://example.com/doc'
									})
								]
							}),
							new Paragraph('The energy relation follows.'),
							new Paragraph({
								children: [
									new Math({
										children: [
											new MathRun('E=m'),
											new MathSuperScript({
												children: [new MathRun('c')],
												superScript: [new MathRun('2')]
											})
										]
									})
								]
							})
						]
					}
				]
			})
		);
		const document = await importFile(
			new File([new Uint8Array(bytes)], 'local.docx', {
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			})
		);
		expect(document.blocks[0]).toMatchObject({ kind: 'heading', text: 'A local book', level: 1 });
		const items = document.blocks.filter((item) => item.kind === 'list-item');
		expect(items.map((item) => item.text)).toEqual(['A list entry', 'A nested entry']);
		expect(items[1].list?.depth).toBe(1);
		const withImage = document.blocks.find((item) =>
			item.inlines?.some((entry) => entry.image?.src?.startsWith('data:image/'))
		);
		expect(withImage).toBeDefined();
		const styled = document.blocks.find((item) => item.text.startsWith('Bold and italic'));
		expect(styled?.inlines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: 'Bold', marks: ['strong'] }),
				expect.objectContaining({ text: 'italic', marks: ['emphasis'] }),
				expect.objectContaining({ text: 'struck', marks: ['delete'] }),
				expect.objectContaining({ text: 'a link', href: 'https://example.com/doc' })
			])
		);
		const table = document.blocks.find((item) => item.kind === 'table');
		expect(table?.table?.header.map((entry) => entry.text)).toEqual(['City', 'Country']);
		expect(table?.table?.rows).toHaveLength(1);
		const anchorIndex = document.blocks.findIndex(
			(item) => item.text === 'The energy relation follows.'
		);
		expect(document.blocks[anchorIndex + 1]).toMatchObject({
			kind: 'math',
			text: 'E=mc^{2}',
			speak: false
		});
	});

	it('repairs PDF row and two-column reading order', () => {
		const transform = (x: number, y: number) => [1, 0, 0, 1, x, y];
		expect(
			pageLines([
				{ str: 'second', transform: transform(60, 80) },
				{ str: 'first', transform: transform(50, 100) }
			])
		).toEqual(['first', 'second']);
		const columns = [100, 80, 60].flatMap((y, index) => [
			{ str: `left ${index + 1}`, transform: transform(50, y) },
			{ str: `right ${index + 1}`, transform: transform(360, y) }
		]);
		expect(pageLines(columns)).toEqual([
			'left 1',
			'left 2',
			'left 3',
			'right 1',
			'right 2',
			'right 3'
		]);
		expect(pageLines([{ str: ' ', transform: [] }])).toEqual([]);
	});

	it('identifies repeated PDF headers and footers conservatively', () => {
		const repeated = repeatedEdgeLines([
			['Voicebook Guide', 'Page one body', '1'],
			['Voicebook Guide', 'Page two body', '2'],
			['Voicebook Guide', 'Page three body', '3']
		]);
		expect(repeated).toEqual(new Set(['voicebook guide', '#']));
		expect(repeatedEdgeLines([['Only page', 'Body']])).toEqual(new Set());
	});

	it('imports a real text PDF fixture and retains page anchors', async () => {
		const pdf = await PDFDocument.create();
		pdf.setTitle('A PDF Listening Test');
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		for (let index = 0; index < 3; index += 1) {
			const page = pdf.addPage([612, 792]);
			page.drawText('Voicebook research notes', { x: 50, y: 750, size: 12, font });
			page.drawText(`First useful sentence on page ${index + 1}.`, {
				x: 50,
				y: 680,
				size: 12,
				font
			});
			page.drawText(`Another paragraph begins on page ${index + 1}.`, {
				x: 50,
				y: 650,
				size: 12,
				font
			});
			page.drawText(`${index + 1}`, { x: 300, y: 30, size: 10, font });
		}
		const bytes = await pdf.save();
		const document = await importFile(
			new File([new Uint8Array(bytes)], 'research.pdf', { type: 'application/pdf' })
		);
		expect(document.title).toBe('A PDF Listening Test');
		expect(document.blocks).toHaveLength(6);
		expect(document.blocks.map((item) => item.anchor.page)).toEqual([1, 1, 2, 2, 3, 3]);
		expect(document.blocks.every((item) => !item.text.includes('Voicebook research notes'))).toBe(
			true
		);
	});

	it('returns the planned OCR recovery error for a scanned/textless PDF', async () => {
		const pdf = await PDFDocument.create();
		pdf.addPage([612, 792]);
		const bytes = await pdf.save();
		await expect(
			importFile(new File([new Uint8Array(bytes)], 'scan.pdf', { type: 'application/pdf' }))
		).rejects.toMatchObject({ code: 'scanned-pdf' });
	});

	it('returns recoverable errors for malformed PDF and DOCX inputs', async () => {
		await expect(
			importFile(new File(['not a pdf'], 'broken.pdf', { type: 'application/pdf' }))
		).rejects.toMatchObject({ code: 'malformed' });
		await expect(
			importFile(
				new File(['not a docx'], 'broken.docx', {
					type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				})
			)
		).rejects.toMatchObject({ code: 'malformed' });
	});

	it('rejects empty sources and creates a safe pasted document', async () => {
		await expect(
			importFile(new File(['   '], 'empty.txt', { type: 'text/plain' }))
		).rejects.toMatchObject({ code: 'malformed' });
		const pasted = documentFromText('', 'A private paragraph.');
		expect(pasted.title).toBe('Pasted text');
		expect(pasted.fingerprint).toContain(`pasted-${pasted.id}`);
		const untitled = await importFile(new File(['Readable.'], '.txt'));
		expect(untitled).toMatchObject({ title: 'Untitled', mimeType: 'application/octet-stream' });
		expect(documentFromText('Named', 'Text.').sourceName).toBe('Named.txt');
	});

	it('detects pasted Markdown and sends it through the structured Markdown parser', () => {
		const pasted = documentFromText(
			'',
			'# Pasted handbook\n\n1. First step\n2. Second step\n\n```ts\nconst local = true;\n```'
		);

		expect(pasted).toMatchObject({
			title: 'Pasted handbook',
			sourceName: 'Pasted handbook.md',
			sourceKind: 'markdown',
			mimeType: 'text/markdown'
		});
		expect(pasted.outline).toEqual([
			expect.objectContaining({ title: 'Pasted handbook', level: 1 })
		]);
		expect(pasted.blocks.map((block) => block.kind)).toEqual(
			expect.arrayContaining(['heading', 'list', 'list-item', 'code'])
		);
		expect(pasted.blocks.some((block) => block.text.includes('```'))).toBe(false);
	});
});
