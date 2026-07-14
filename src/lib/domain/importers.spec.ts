import { Document, HeadingLevel, Packer, Paragraph } from 'docx';
import { DOMParser } from 'linkedom';
import { DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
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
			'<script>alert(1)</script>'
		].join('\n');
		const document = await importFile(new File([markdown], 'guide.md', { type: 'text/markdown' }));
		expect(document.title).toBe('Listening well');
		expect(document.normalizationVersion).toBe(2);
		expect(document.outline[0]).toMatchObject({ title: 'Listening well', level: 1 });
		expect(document.blocks.map((item) => item.kind)).toEqual([
			'heading',
			'paragraph',
			'quote',
			'list-item',
			'list-item',
			'code',
			'code'
		]);
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
		expect(listItems.map((item) => item.list)).toEqual([
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
			{ text: 'Cover art', marks: ['emphasis'] },
			{ text: '.' }
		]);
		expect(document.blocks[1].inlines).toEqual([
			{ text: 'Hard break with ' },
			{ text: '<kbd>', marks: ['code'] },
			{ text: 'Enter' },
			{ text: '</kbd>', marks: ['code'] },
			{ text: ' and an empty image .' }
		]);
		expect(document.blocks[2]).toMatchObject({ kind: 'divider', text: '', speak: false });

		const unclosed = await importFile(new File(['\uFEFF---\ntitle: Still Markdown'], 'open.md'));
		expect(unclosed.blocks.every((item) => item.kind !== 'frontmatter')).toBe(true);
	});

	it('imports a semantic DOCX fixture', async () => {
		const bytes = await Packer.toBuffer(
			new Document({
				sections: [
					{
						children: [
							new Paragraph({ text: 'A local book', heading: HeadingLevel.HEADING_1 }),
							new Paragraph('The document stays inside this browser.'),
							new Paragraph({ text: 'A list entry', bullet: { level: 0 } })
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
		expect(document.blocks.some((item) => item.kind === 'list-item')).toBe(true);
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
});
