import mammoth from 'mammoth';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { segmentBlocks } from './segmenter';
import type {
	BlockKind,
	DocumentTable,
	DocumentBlock,
	DocumentKind,
	InlineMark,
	InlineRun,
	NormalizedDocument,
	OutlineEntry,
	SourceAnchor,
	TableAlignment,
	TableCell
} from './types';

export const DOCUMENT_NORMALIZATION_VERSION = 3;

interface AstNode {
	type: string;
	value?: string;
	depth?: number;
	lang?: string;
	ordered?: boolean;
	start?: number | null;
	checked?: boolean | null;
	align?: TableAlignment[];
	url?: string;
	title?: string;
	alt?: string;
	identifier?: string;
	label?: string;
	position?: {
		start?: { offset?: number };
		end?: { offset?: number };
	};
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
	const normalizedText = text
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return {
		id: `b${index}`,
		kind,
		text: normalizedText,
		speak: !['code', 'math', 'frontmatter', 'divider', 'page-break'].includes(kind),
		anchor: {},
		...extras
	};
}

function sameRun(left: InlineRun, right: InlineRun): boolean {
	return (
		left.href === right.href &&
		left.title === right.title &&
		left.math === right.math &&
		(left.marks ?? []).join(':') === (right.marks ?? []).join(':')
	);
}

function normalizeRuns(runs: InlineRun[]): InlineRun[] {
	const normalized: InlineRun[] = [];
	for (const run of runs) {
		const candidate = { ...run, text: run.text.replace(/\s+/g, ' ') };
		if (!candidate.text) continue;
		const previous = normalized.at(-1);
		if (previous && sameRun(previous, candidate)) previous.text += candidate.text;
		else normalized.push(candidate);
	}
	if (normalized[0]) normalized[0].text = normalized[0].text.trimStart();
	if (normalized.at(-1)) normalized[normalized.length - 1].text = normalized.at(-1)!.text.trimEnd();
	return normalized.filter((run) => run.text.length > 0);
}

function safeHref(value?: string): string | undefined {
	if (!value) return undefined;
	if (value.startsWith('#')) return value;
	try {
		const url = new URL(value);
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function footnoteId(identifier?: string): string {
	return (identifier ?? 'note').toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function run(
	text: string,
	marks: InlineMark[],
	link?: Pick<InlineRun, 'href' | 'title'>
): InlineRun {
	return {
		text,
		...(marks.length ? { marks } : {}),
		...(link?.href ? { href: link.href } : {}),
		...(link?.title ? { title: link.title } : {})
	};
}

function inlineRuns(
	node: AstNode,
	marks: InlineMark[] = [],
	link?: Pick<InlineRun, 'href' | 'title'>
): InlineRun[] {
	if (node.type === 'text') return [run(node.value ?? '', marks, link)];
	if (node.type === 'inlineCode') return [run(node.value ?? '', [...marks, 'code'], link)];
	if (node.type === 'inlineMath') return [{ text: node.value ?? '', math: true }];
	if (node.type === 'footnoteReference') {
		const label = node.label ?? node.identifier ?? 'note';
		return [{ text: `[${label}]`, href: `#footnote-${footnoteId(node.identifier)}` }];
	}
	if (node.type === 'break') return [run(' ', marks, link)];
	if (node.type === 'image') {
		const text = node.alt?.trim();
		return text ? [run(text, [...marks, 'emphasis'], link)] : [];
	}
	if (node.type === 'html') return [run(node.value ?? '', [...marks, 'code'], link)];

	let nextMarks = marks;
	if (node.type === 'strong') nextMarks = [...marks, 'strong'];
	else if (node.type === 'emphasis') nextMarks = [...marks, 'emphasis'];
	else if (node.type === 'delete') nextMarks = [...marks, 'delete'];
	const nextLink =
		node.type === 'link'
			? {
					href: safeHref(node.url),
					title: node.title?.trim() || undefined
				}
			: link;
	return (node.children ?? []).flatMap((child) => inlineRuns(child, nextMarks, nextLink));
}

function runsForBlocks(nodes: AstNode[]): InlineRun[] {
	const runs: InlineRun[] = [];
	for (const node of nodes) {
		const candidate = inlineRuns(node);
		if (candidate.length && runs.length) runs.push({ text: ' ' });
		runs.push(...candidate);
	}
	return normalizeRuns(runs);
}

function anchorFor(node: AstNode, offsetBase: number): SourceAnchor {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	return {
		start: start === undefined ? undefined : offsetBase + start,
		end: end === undefined ? undefined : offsetBase + end
	};
}

interface FrontmatterResult {
	content: string;
	offset: number;
	raw?: string;
	language?: 'yaml' | 'toml';
	title?: string;
}

function frontmatterFrom(markdown: string): FrontmatterResult {
	const bomLength = markdown.startsWith('\uFEFF') ? 1 : 0;
	const source = markdown.slice(bomLength);
	const delimiter =
		source.startsWith('---\n') || source.startsWith('---\r\n')
			? '---'
			: source.startsWith('+++\n') || source.startsWith('+++\r\n')
				? '+++'
				: undefined;
	if (!delimiter) return { content: source, offset: bomLength };
	const escaped = delimiter === '+++' ? '\\+\\+\\+' : '---';
	const match = new RegExp(
		`^${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n${escaped}[ \\t]*(?:\\r?\\n|$)`
	).exec(source);
	if (!match) return { content: source, offset: bomLength };
	const raw = match[1].trim();
	const titlePattern = delimiter === '---' ? /^title\s*:\s*(.+)$/im : /^title\s*=\s*(.+)$/im;
	const title = titlePattern
		.exec(raw)?.[1]
		?.trim()
		.replace(/^(['"])(.*)\1$/, '$2');
	return {
		content: source.slice(match[0].length),
		offset: bomLength + match[0].length,
		raw,
		language: delimiter === '---' ? 'yaml' : 'toml',
		title
	};
}

function tableCell(node: AstNode): TableCell {
	const inlines = normalizeRuns(inlineRuns(node));
	return { text: inlines.map((run) => run.text).join(''), inlines };
}

function parseMarkdown(markdown: string): ParsedSource {
	const frontmatter = frontmatterFrom(markdown);
	const tree = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkMath)
		.parse(frontmatter.content) as AstNode;
	const blocks: DocumentBlock[] = [];
	const add = (
		kind: BlockKind,
		text: string,
		extras: Partial<DocumentBlock> = {},
		allowEmpty = false
	) => {
		if (text.trim() || allowEmpty) blocks.push(block(kind, text, blocks.length, extras));
	};
	const addInlineBlock = (
		kind: BlockKind,
		node: AstNode,
		nodes: AstNode[] = [node],
		extras: Partial<DocumentBlock> = {}
	) => {
		const inlines = runsForBlocks(nodes);
		add(kind, inlines.map((run) => run.text).join(''), {
			inlines,
			anchor: anchorFor(node, frontmatter.offset),
			...extras
		});
	};
	const addList = (node: AstNode, depth: number) => {
		const ordered = Boolean(node.ordered);
		const start = ordered ? (node.start ?? 1) : undefined;
		(node.children ?? []).forEach((item, index) => {
			const directChildren = (item.children ?? []).filter((child) => child.type !== 'list');
			addInlineBlock('list-item', item, directChildren, {
				list: {
					ordered,
					depth,
					index,
					start,
					checked: typeof item.checked === 'boolean' ? item.checked : undefined
				}
			});
			for (const child of item.children ?? []) if (child.type === 'list') addList(child, depth + 1);
		});
	};

	if (frontmatter.raw !== undefined) {
		add('frontmatter', frontmatter.raw, {
			codeLanguage: frontmatter.language,
			anchor: { start: 0, end: frontmatter.offset },
			speak: false
		});
	}

	for (const node of tree.children ?? []) {
		switch (node.type) {
			case 'heading':
				addInlineBlock('heading', node, [node], { level: node.depth ?? 2 });
				break;
			case 'paragraph':
				addInlineBlock('paragraph', node);
				break;
			case 'blockquote':
				addInlineBlock('quote', node, node.children ?? []);
				break;
			case 'code':
				add('code', node.value ?? '', {
					codeLanguage: node.lang?.trim() || undefined,
					anchor: anchorFor(node, frontmatter.offset)
				});
				break;
			case 'math':
				add('math', node.value ?? '', {
					anchor: anchorFor(node, frontmatter.offset),
					speak: false
				});
				break;
			case 'footnoteDefinition':
				addInlineBlock('footnote', node, node.children ?? [], {
					footnoteId: `footnote-${footnoteId(node.identifier)}`,
					footnoteLabel: node.label ?? node.identifier ?? 'Note'
				});
				break;
			case 'list':
				addList(node, 0);
				break;
			case 'table': {
				const [header, ...rows] = (node.children ?? []).map((row) =>
					(row.children ?? []).map(tableCell)
				);
				const table: DocumentTable = {
					align: node.align ?? [],
					header: header ?? [],
					rows
				};
				const text = [table.header, ...table.rows]
					.map((row) =>
						row
							.map((cell) => cell.text)
							.filter(Boolean)
							.join(', ')
					)
					.filter(Boolean)
					.join('. ');
				add('table', text, { table, anchor: anchorFor(node, frontmatter.offset) });
				break;
			}
			case 'thematicBreak':
				add('divider', '', { anchor: anchorFor(node, frontmatter.offset), speak: false }, true);
				break;
			case 'html':
				add('code', node.value ?? '', {
					codeLanguage: 'html',
					anchor: anchorFor(node, frontmatter.offset)
				});
				break;
		}
	}
	return {
		blocks,
		title:
			blocks.find((candidate) => candidate.kind === 'heading' && candidate.level === 1)?.text ||
			frontmatter.title
	};
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
		parsed = sourceKind === 'markdown' ? parseMarkdown(text) : { blocks: textBlocks(text) };
	}

	if (!parsed.blocks.length)
		throw new ImportError('No readable text was found in this file.', 'malformed');
	const now = Date.now();
	const id = crypto.randomUUID();
	const blocks = parsed.blocks.map((candidate, index) => ({ ...candidate, id: `b${index}` }));
	return {
		normalizationVersion: DOCUMENT_NORMALIZATION_VERSION,
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
		normalizationVersion: DOCUMENT_NORMALIZATION_VERSION,
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
