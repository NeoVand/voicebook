import mammoth from 'mammoth';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { segmentBlocks } from './segmenter';
import type {
	BlockKind,
	DocumentBlock,
	DocumentKind,
	NormalizedDocument,
	OutlineEntry
} from './types';

interface AstNode {
	type: string;
	value?: string;
	depth?: number;
	children?: AstNode[];
}

interface ParsedSource {
	title?: string;
	blocks: DocumentBlock[];
	warnings?: string[];
}

export class ImportError extends Error {
	constructor(
		message: string,
		readonly code: 'unsupported' | 'scanned-pdf' | 'malformed'
	) {
		super(message);
		this.name = 'ImportError';
	}
}

function extensionOf(name: string): string {
	return name.toLowerCase().split('.').pop() ?? '';
}

export function kindForFile(file: Pick<File, 'name' | 'type'>): DocumentKind {
	const extension = extensionOf(file.name);
	if (file.type === 'application/pdf' || extension === 'pdf') return 'pdf';
	if (
		file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		extension === 'docx'
	)
		return 'docx';
	if (['md', 'markdown', 'mdown', 'mkd'].includes(extension) || file.type === 'text/markdown')
		return 'markdown';
	if (file.type.startsWith('text/') || ['txt', 'text'].includes(extension)) return 'text';
	throw new ImportError(
		'Voicebook currently supports PDF, DOCX, Markdown, and plain text files.',
		'unsupported'
	);
}

export async function fingerprint(file: Blob): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function titleFromName(name: string): string {
	return (
		name
			.replace(/\.[^.]+$/, '')
			.replace(/[_-]+/g, ' ')
			.trim() || 'Untitled'
	);
}

function block(
	kind: BlockKind,
	text: string,
	index: number,
	extras: Partial<DocumentBlock> = {}
): DocumentBlock {
	return {
		id: `b${index}`,
		kind,
		text: text
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim(),
		speak: kind !== 'code' && kind !== 'page-break',
		anchor: {},
		...extras
	};
}

function textFromAst(node: AstNode): string {
	if (typeof node.value === 'string') return node.value;
	return (node.children ?? [])
		.map(textFromAst)
		.join(node.type === 'paragraph' ? '' : ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function markdownBlocks(markdown: string): DocumentBlock[] {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as AstNode;
	const blocks: DocumentBlock[] = [];
	const add = (kind: BlockKind, text: string, extras: Partial<DocumentBlock> = {}) => {
		if (text.trim()) blocks.push(block(kind, text, blocks.length, extras));
	};

	for (const node of tree.children ?? []) {
		switch (node.type) {
			case 'heading':
				add('heading', textFromAst(node), { level: node.depth ?? 2 });
				break;
			case 'paragraph':
				add('paragraph', textFromAst(node));
				break;
			case 'blockquote':
				add('quote', textFromAst(node));
				break;
			case 'code':
				add('code', node.value ?? '');
				break;
			case 'list':
				for (const item of node.children ?? []) add('list-item', textFromAst(item));
				break;
			case 'html':
				add('code', node.value ?? '');
				break;
		}
	}
	return blocks;
}

function textBlocks(text: string): DocumentBlock[] {
	return text
		.replace(/^\uFEFF/, '')
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
		.filter(Boolean)
		.map((paragraph, index) => block('paragraph', paragraph, index));
}

async function parseDocx(file: File): Promise<ParsedSource> {
	try {
		const arrayBuffer = await file.arrayBuffer();
		const source =
			typeof Buffer === 'function' ? { buffer: Buffer.from(arrayBuffer) } : { arrayBuffer };
		const result = await mammoth.convertToHtml(source);
		const document = new DOMParser().parseFromString(result.value, 'text/html');
		const blocks: DocumentBlock[] = [];
		for (const element of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre')) {
			if (element.closest('li') && element.tagName !== 'LI') continue;
			const text = element.textContent?.trim() ?? '';
			if (!text) continue;
			const tag = element.tagName.toLowerCase();
			if (tag.startsWith('h'))
				blocks.push(block('heading', text, blocks.length, { level: Number(tag[1]) }));
			else if (tag === 'li') blocks.push(block('list-item', text, blocks.length));
			else if (tag === 'blockquote') blocks.push(block('quote', text, blocks.length));
			else if (tag === 'pre') blocks.push(block('code', text, blocks.length));
			else blocks.push(block('paragraph', text, blocks.length));
		}
		return {
			blocks,
			warnings: result.messages.map((message) => message.message).slice(0, 8)
		};
	} catch (error) {
		throw new ImportError(
			`This Word file could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
			'malformed'
		);
	}
}

interface PdfLine {
	text: string;
	y: number;
	x: number;
}

export function pageLines(
	items: Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>
): string[] {
	const rows: PdfLine[][] = [];
	for (const item of items) {
		const text = item.str?.trim();
		if (!text) continue;
		const x = item.transform?.[4] ?? 0;
		const y = item.transform?.[5] ?? 0;
		let row = rows.find((candidate) => Math.abs(candidate[0].y - y) < 3);
		if (!row) {
			row = [];
			rows.push(row);
		}
		row.push({ text, x, y });
	}
	const ordered = rows.sort((a, b) => b[0].y - a[0].y).map((row) => row.sort((a, b) => a.x - b.x));
	const splitCandidates = ordered.flatMap((row) => {
		let largestGap = 0;
		let split = 0;
		for (let index = 1; index < row.length; index += 1) {
			const gap = row[index].x - row[index - 1].x;
			if (gap > largestGap) {
				largestGap = gap;
				split = (row[index].x + row[index - 1].x) / 2;
			}
		}
		return largestGap > 180 && split > 180 ? [split] : [];
	});
	const hasColumns =
		splitCandidates.length >= 3 && splitCandidates.length >= Math.ceil(ordered.length * 0.3);
	const columnSplit = hasColumns
		? splitCandidates.sort((a, b) => a - b)[Math.floor(splitCandidates.length / 2)]
		: 0;
	const lineText = (line: PdfLine[]) =>
		line
			.map((item) => item.text)
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
	if (hasColumns) {
		const left = ordered.map((row) => row.filter((item) => item.x < columnSplit)).map(lineText);
		const right = ordered.map((row) => row.filter((item) => item.x >= columnSplit)).map(lineText);
		return [...left, ...right].filter(Boolean);
	}
	return ordered.map(lineText).filter(Boolean);
}

export function repeatedEdgeLines(pages: string[][]): Set<string> {
	const counts = new Map<string, number>();
	for (const lines of pages) {
		for (const line of [lines[0], lines.at(-1)]) {
			const normalized = line?.toLowerCase().replace(/\d+/g, '#').trim();
			if (normalized && normalized.length < 160)
				counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
		}
	}
	return new Set(
		Array.from(counts)
			.filter(([, count]) => pages.length >= 3 && count / pages.length >= 0.6)
			.map(([line]) => line)
	);
}

async function parsePdf(file: File): Promise<ParsedSource> {
	try {
		const pdfjs =
			typeof window === 'undefined'
				? await import('pdfjs-dist/legacy/build/pdf.mjs')
				: await import('pdfjs-dist');
		if (typeof window !== 'undefined') {
			const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
			pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		}
		const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
		const pages: string[][] = [];

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
			const page = await pdf.getPage(pageNumber);
			const content = await page.getTextContent();
			pages.push(
				pageLines(content.items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>)
			);
			page.cleanup();
		}

		const totalCharacters = pages.flat().join('').length;
		if (totalCharacters < Math.max(24, pdf.numPages * 8)) {
			throw new ImportError(
				'This PDF appears to be scanned. OCR support is planned, but is not part of this release.',
				'scanned-pdf'
			);
		}

		const repeated = repeatedEdgeLines(pages);
		const blocks: DocumentBlock[] = [];
		pages.forEach((lines, pageIndex) => {
			const filtered = lines.filter(
				(line) => !repeated.has(line.toLowerCase().replace(/\d+/g, '#').trim())
			);
			let paragraph = '';
			for (const line of filtered) {
				const beginsNew = paragraph && /^[A-Z“"']/.test(line) && /[.!?][”"']?$/.test(paragraph);
				if (beginsNew) {
					blocks.push(
						block('paragraph', paragraph, blocks.length, { anchor: { page: pageIndex + 1 } })
					);
					paragraph = line;
				} else {
					paragraph = `${paragraph} ${line}`.trim().replace(/- ([a-z])/g, '$1');
				}
			}
			if (paragraph)
				blocks.push(
					block('paragraph', paragraph, blocks.length, { anchor: { page: pageIndex + 1 } })
				);
		});

		const metadata = await pdf.getMetadata().catch(() => null);
		await pdf.destroy();
		const info = metadata?.info as { Title?: string } | undefined;
		return { title: info?.Title?.trim(), blocks };
	} catch (error) {
		if (error instanceof ImportError) throw error;
		throw new ImportError(
			`This PDF could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
			'malformed'
		);
	}
}

function outlineFor(blocks: DocumentBlock[]): OutlineEntry[] {
	return blocks
		.filter((candidate) => candidate.kind === 'heading')
		.map((candidate) => ({
			id: `outline-${candidate.id}`,
			blockId: candidate.id,
			title: candidate.text,
			level: candidate.level ?? 2
		}));
}

export async function importFile(file: File): Promise<NormalizedDocument> {
	const sourceKind = kindForFile(file);
	let parsed: ParsedSource;
	if (sourceKind === 'pdf') parsed = await parsePdf(file);
	else if (sourceKind === 'docx') parsed = await parseDocx(file);
	else {
		const text = await file.text();
		const blocks = sourceKind === 'markdown' ? markdownBlocks(text) : textBlocks(text);
		parsed = {
			blocks,
			title:
				sourceKind === 'markdown'
					? blocks.find((block) => block.kind === 'heading' && block.level === 1)?.text
					: undefined
		};
	}

	if (!parsed.blocks.length)
		throw new ImportError('No readable text was found in this file.', 'malformed');
	const now = Date.now();
	const id = crypto.randomUUID();
	const blocks = parsed.blocks.map((candidate, index) => ({ ...candidate, id: `b${index}` }));
	return {
		id,
		fingerprint: await fingerprint(file),
		title: parsed.title || titleFromName(file.name),
		sourceName: file.name,
		sourceKind,
		mimeType: file.type || 'application/octet-stream',
		language: 'en',
		createdAt: now,
		updatedAt: now,
		blocks,
		segments: segmentBlocks(blocks),
		outline: outlineFor(blocks),
		bookmarks: [],
		warnings: parsed.warnings ?? [],
		includeCode: false
	};
}

export function documentFromText(title: string, text: string): NormalizedDocument {
	const now = Date.now();
	const blocks = textBlocks(text);
	const id = crypto.randomUUID();
	return {
		id,
		fingerprint: `pasted-${id}`,
		title: title.trim() || 'Pasted text',
		sourceName: `${title.trim() || 'Pasted text'}.txt`,
		sourceKind: 'text',
		mimeType: 'text/plain',
		language: 'en',
		createdAt: now,
		updatedAt: now,
		blocks,
		segments: segmentBlocks(blocks),
		outline: [],
		bookmarks: [],
		warnings: [],
		includeCode: false
	};
}
