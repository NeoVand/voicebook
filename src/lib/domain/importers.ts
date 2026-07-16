import mammoth from 'mammoth';
import remarkDefinitionList from 'remark-definition-list';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { segmentBlocks } from './segmenter';
import type {
	BlockKind,
	AlertKind,
	DocumentTable,
	DocumentBlock,
	DocumentKind,
	InlineMark,
	InlineRun,
	InlineImage,
	NormalizedDocument,
	OutlineEntry,
	SourceAnchor,
	SafeHtmlNode,
	SafeHtmlTag,
	TableAlignment,
	TableCell
} from './types';

export const DOCUMENT_NORMALIZATION_VERSION = 8;

interface AstNode {
	type: string;
	value?: string;
	depth?: number;
	lang?: string;
	ordered?: boolean;
	start?: number | null;
	checked?: boolean | null;
	spread?: boolean;
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
		speak: ![
			'list',
			'quote',
			'alert',
			'details',
			'definition-list',
			'code',
			'math',
			'mermaid',
			'frontmatter',
			'divider',
			'page-break'
		].includes(kind),
		anchor: {},
		...extras
	};
}

function sameRun(left: InlineRun, right: InlineRun): boolean {
	return (
		left.href === right.href &&
		left.title === right.title &&
		left.math === right.math &&
		JSON.stringify(left.image) === JSON.stringify(right.image) &&
		JSON.stringify(left.progress) === JSON.stringify(right.progress) &&
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

function safeImageSrc(value?: string): string | undefined {
	if (!value) return undefined;
	if (/^data:image\/(?:png|gif|jpe?g|webp|svg\+xml);/i.test(value)) return value;
	try {
		const url = new URL(value);
		return ['http:', 'https:', 'blob:'].includes(url.protocol) ? url.href : undefined;
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
	link?: Pick<InlineRun, 'href' | 'title'>,
	extras: Partial<InlineRun> = {}
): InlineRun {
	return {
		text,
		...(marks.length ? { marks } : {}),
		...(link?.href ? { href: link.href } : {}),
		...(link?.title ? { title: link.title } : {}),
		...extras
	};
}

interface HtmlMark {
	mark: Extract<InlineMark, 'sub' | 'sup' | 'mark' | 'kbd' | 'abbr'>;
	title?: string;
}

function htmlAttribute(source: string, name: string): string | undefined {
	const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(source);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

function inlineHtmlRun(value: string, marks: InlineMark[], stack: HtmlMark[]): InlineRun[] {
	const trimmed = value.trim();
	const progress = /^<progress\b[^>]*>(?:<\/progress>)?$/i.test(trimmed)
		? trimmed
		: /^<progress\b[^>]*><\/progress>$/i.test(trimmed)
			? trimmed
			: undefined;
	if (progress) {
		const maximum = Math.max(1, Number(htmlAttribute(progress, 'max') ?? 1));
		const value = Math.min(maximum, Math.max(0, Number(htmlAttribute(progress, 'value') ?? 0)));
		return [
			run(`${Math.round((value / maximum) * 100)}%`, marks, undefined, {
				progress: { value, max: maximum }
			})
		];
	}
	if (/^<br\s*\/?\s*>$/i.test(trimmed)) return [run(' ', marks)];
	const close = /^<\/(sub|sup|mark|kbd|abbr)\s*>$/i.exec(trimmed);
	if (close) {
		const index = stack
			.map((entry) => entry.mark)
			.lastIndexOf(close[1].toLowerCase() as HtmlMark['mark']);
		if (index >= 0) stack.splice(index, 1);
		return [];
	}
	const open = /^<(sub|sup|mark|kbd|abbr)\b[^>]*>$/i.exec(trimmed);
	if (open) {
		stack.push({
			mark: open[1].toLowerCase() as HtmlMark['mark'],
			title: open[1].toLowerCase() === 'abbr' ? htmlAttribute(trimmed, 'title') : undefined
		});
	}
	return [];
}

function inlineRuns(
	node: AstNode,
	marks: InlineMark[] = [],
	link?: Pick<InlineRun, 'href' | 'title'>,
	htmlStack: HtmlMark[] = []
): InlineRun[] {
	const htmlMarks = htmlStack.map((entry) => entry.mark);
	const activeMarks = [...marks, ...htmlMarks];
	const abbrTitle = htmlStack.findLast((entry) => entry.mark === 'abbr')?.title;
	const activeLink = abbrTitle ? { ...link, title: abbrTitle } : link;
	if (node.type === 'text') return [run(node.value ?? '', activeMarks, activeLink)];
	if (node.type === 'inlineCode')
		return [run(node.value ?? '', [...activeMarks, 'code'], activeLink)];
	if (node.type === 'inlineMath') return [{ text: node.value ?? '', math: true }];
	if (node.type === 'footnoteReference') {
		const label = node.label ?? node.identifier ?? 'note';
		return [{ text: `[${label}]`, href: `#footnote-${footnoteId(node.identifier)}` }];
	}
	if (node.type === 'break') return [run(' ', activeMarks, activeLink)];
	if (node.type === 'image') {
		const alt = node.alt?.trim() ?? '';
		const image: InlineImage = {
			src: safeImageSrc(node.url),
			alt,
			title: node.title?.trim() || undefined
		};
		return [run(alt || 'Image', activeMarks, activeLink, { image })];
	}
	if (node.type === 'html') return inlineHtmlRun(node.value ?? '', activeMarks, htmlStack);

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
	const runs: InlineRun[] = [];
	for (const child of node.children ?? [])
		runs.push(...inlineRuns(child, nextMarks, nextLink, htmlStack));
	return runs;
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

const SAFE_HTML_TAGS = new Set<SafeHtmlTag>([
	'p',
	'div',
	'span',
	'strong',
	'em',
	'del',
	'sub',
	'sup',
	'mark',
	'kbd',
	'abbr',
	'a',
	'img',
	'br',
	'table',
	'thead',
	'tbody',
	'tr',
	'th',
	'td',
	'progress'
]);

interface HtmlDomNode {
	nodeType: number;
	textContent?: string | null;
	tagName?: string;
	childNodes?: Iterable<HtmlDomNode>;
	getAttribute?(name: string): string | null;
}

function boundedInteger(
	value: string | null | undefined,
	minimum: number,
	maximum: number
): number | undefined {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : undefined;
}

function safeHtmlNode(node: HtmlDomNode): SafeHtmlNode[] {
	if (node.nodeType === 3)
		return node.textContent ? [{ type: 'text', text: node.textContent }] : [];
	if (node.nodeType !== 1 || !node.tagName) return [];
	const tag = node.tagName.toLowerCase();
	if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'].includes(tag))
		return [];
	const children = Array.from(node.childNodes ?? []).flatMap(safeHtmlNode);
	if (!SAFE_HTML_TAGS.has(tag as SafeHtmlTag)) return children;
	const attributes: Record<string, string | number | boolean> = {};
	if (tag === 'a') {
		const href = safeHref(node.getAttribute?.('href') ?? undefined);
		if (href) attributes.href = href;
		const title = node.getAttribute?.('title')?.trim();
		if (title) attributes.title = title;
	}
	if (tag === 'img') {
		const src = safeImageSrc(node.getAttribute?.('src') ?? undefined);
		if (!src) return [];
		attributes.src = src;
		attributes.alt = node.getAttribute?.('alt') ?? '';
		const title = node.getAttribute?.('title')?.trim();
		if (title) attributes.title = title;
		const width = boundedInteger(node.getAttribute?.('width'), 16, 1600);
		const height = boundedInteger(node.getAttribute?.('height'), 16, 1600);
		if (width) attributes.width = width;
		if (height) attributes.height = height;
	}
	if (tag === 'abbr') {
		const title = node.getAttribute?.('title')?.trim();
		if (title) attributes.title = title;
	}
	if (tag === 'td' || tag === 'th') {
		const colspan = boundedInteger(node.getAttribute?.('colspan'), 1, 12);
		const rowspan = boundedInteger(node.getAttribute?.('rowspan'), 1, 100);
		if (colspan) attributes.colspan = colspan;
		if (rowspan) attributes.rowspan = rowspan;
	}
	if (tag === 'progress') {
		const maximum = Math.max(1, Number(node.getAttribute?.('max') ?? 1));
		attributes.max = maximum;
		attributes.value = Math.min(maximum, Math.max(0, Number(node.getAttribute?.('value') ?? 0)));
	}
	if (tag === 'div' && /border-left|background/i.test(node.getAttribute?.('style') ?? '')) {
		attributes.variant = 'callout';
	}
	return [{ type: 'element', tag: tag as SafeHtmlTag, attributes, children }];
}

function parseSafeHtml(source: string): SafeHtmlNode[] {
	if (/^\s*<!--/.test(source)) return [];
	const parsed = new DOMParser().parseFromString(
		`<html><body>${source}</body></html>`,
		'text/html'
	);
	return Array.from(parsed.body?.childNodes ?? []).flatMap((node) =>
		safeHtmlNode(node as HtmlDomNode)
	);
}

function safeHtmlText(nodes: SafeHtmlNode[]): string {
	return nodes
		.map((node) => (node.type === 'text' ? node.text : safeHtmlText(node.children)))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseMarkdown(markdown: string): ParsedSource {
	const frontmatter = frontmatterFrom(markdown);
	const parsedTree = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkMath)
		.use(remarkDefinitionList)
		.parse(frontmatter.content) as AstNode;
	const definitions = new Map(
		(parsedTree.children ?? [])
			.filter((node) => node.type === 'definition' && node.identifier)
			.map((node) => [node.identifier!.toLocaleLowerCase(), node])
	);
	const resolveReferences = (node: AstNode): AstNode => {
		const definition = node.identifier
			? definitions.get(node.identifier.toLocaleLowerCase())
			: undefined;
		if (node.type === 'linkReference' && definition) {
			return {
				...node,
				type: 'link',
				url: definition.url,
				title: definition.title,
				children: node.children?.map(resolveReferences)
			};
		}
		if (node.type === 'imageReference' && definition) {
			return { ...node, type: 'image', url: definition.url, title: definition.title };
		}
		return { ...node, children: node.children?.map(resolveReferences) };
	};
	const tree = resolveReferences(parsedTree);
	const blocks: DocumentBlock[] = [];
	const add = (
		kind: BlockKind,
		text: string,
		extras: Partial<DocumentBlock> = {},
		allowEmpty = false
	): DocumentBlock | undefined => {
		if (!text.trim() && !allowEmpty) return;
		const candidate = block(kind, text, blocks.length, extras);
		blocks.push(candidate);
		if (candidate.parentId) {
			const parent = blocks.find((item) => item.id === candidate.parentId);
			if (parent) parent.children = [...(parent.children ?? []), candidate.id];
		}
		return candidate;
	};
	const addInlineBlock = (
		kind: BlockKind,
		node: AstNode,
		nodes: AstNode[] = [node],
		extras: Partial<DocumentBlock> = {}
	): DocumentBlock | undefined => {
		const inlines = runsForBlocks(nodes);
		return add(kind, inlines.map((run) => run.text).join(''), {
			inlines,
			anchor: anchorFor(node, frontmatter.offset),
			...extras
		});
	};
	const listDepth = (parentId?: string): number => {
		let depth = 0;
		let current = parentId ? blocks.find((candidate) => candidate.id === parentId) : undefined;
		while (current) {
			if (current.kind === 'list') depth += 1;
			current = current.parentId
				? blocks.find((candidate) => candidate.id === current?.parentId)
				: undefined;
		}
		return depth;
	};
	const alertFor = (node: AstNode): AlertKind | undefined => {
		const first = node.children?.[0];
		const text = first?.children?.map((child) => child.value ?? '').join('') ?? '';
		return /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(text)?.[1].toLowerCase() as
			AlertKind | undefined;
	};
	const withoutAlertMarker = (node: AstNode): AstNode => {
		const [first, ...rest] = node.children ?? [];
		if (!first) return node;
		let removed = false;
		const cleanedChildren = (first.children ?? []).map((child) => {
			if (removed || child.type !== 'text') return child;
			removed = true;
			return {
				...child,
				value: (child.value ?? '').replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, '')
			};
		});
		return { ...node, children: [{ ...first, children: cleanedChildren }, ...rest] };
	};
	const addTable = (node: AstNode, parentId?: string) => {
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
		add('table', text, { table, parentId, anchor: anchorFor(node, frontmatter.offset) });
	};

	const walkNodes = (nodes: AstNode[], parentId?: string) => {
		for (let index = 0; index < nodes.length; index += 1) {
			const node = nodes[index];
			if (node.type === 'html' && /^\s*<details\b/i.test(node.value ?? '')) {
				const followingSummary =
					nodes[index + 1]?.type === 'html' && /^\s*<summary\b/i.test(nodes[index + 1].value ?? '')
						? nodes[index + 1]
						: undefined;
				const closingIndex = nodes.findIndex(
					(candidate, candidateIndex) =>
						candidateIndex > index &&
						candidate.type === 'html' &&
						/^\s*<\/details\s*>/i.test(candidate.value ?? '')
				);
				const summaryMarkup = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(
					followingSummary?.value ?? node.value ?? ''
				)?.[1];
				const summary = summaryMarkup ? safeHtmlText(parseSafeHtml(summaryMarkup)) : undefined;
				const details = add(
					'details',
					'',
					{
						parentId,
						children: [],
						detailsSummary: summary || 'Details',
						anchor: anchorFor(node, frontmatter.offset),
						speak: false
					},
					true
				);
				if (details && closingIndex > index) {
					walkNodes(nodes.slice(index + (followingSummary ? 2 : 1), closingIndex), details.id);
				}
				if (closingIndex > index) index = closingIndex;
				continue;
			}
			if (node.type === 'html' && /^\s*<\/details\s*>/i.test(node.value ?? '')) continue;

			switch (node.type) {
				case 'heading':
					addInlineBlock('heading', node, [node], {
						parentId,
						level: node.depth ?? 2
					});
					break;
				case 'paragraph':
					addInlineBlock('paragraph', node, [node], { parentId });
					break;
				case 'blockquote': {
					const alertKind = alertFor(node);
					const container = add(
						alertKind ? 'alert' : 'quote',
						'',
						{
							parentId,
							children: [],
							alertKind,
							anchor: anchorFor(node, frontmatter.offset),
							speak: false
						},
						true
					);
					if (container)
						walkNodes((alertKind ? withoutAlertMarker(node) : node).children ?? [], container.id);
					break;
				}
				case 'list': {
					const depth = listDepth(parentId);
					const ordered = Boolean(node.ordered);
					const list = add(
						'list',
						'',
						{
							parentId,
							children: [],
							list: {
								ordered,
								depth,
								index: 0,
								start: ordered ? (node.start ?? 1) : undefined,
								spread: Boolean(node.spread)
							},
							anchor: anchorFor(node, frontmatter.offset),
							speak: false
						},
						true
					);
					if (!list) break;
					(node.children ?? []).forEach((item, itemIndex) => {
						const [firstParagraph, ...rest] = item.children ?? [];
						const itemBlock =
							firstParagraph?.type === 'paragraph'
								? addInlineBlock('list-item', item, [firstParagraph], {
										parentId: list.id,
										children: [],
										list: {
											ordered,
											depth,
											index: itemIndex,
											start: ordered ? (node.start ?? 1) : undefined,
											checked: typeof item.checked === 'boolean' ? item.checked : undefined,
											spread: Boolean(node.spread || item.spread)
										}
									})
								: add(
										'list-item',
										'',
										{
											parentId: list.id,
											children: [],
											list: {
												ordered,
												depth,
												index: itemIndex,
												start: ordered ? (node.start ?? 1) : undefined,
												checked: typeof item.checked === 'boolean' ? item.checked : undefined,
												spread: Boolean(node.spread || item.spread)
											},
											anchor: anchorFor(item, frontmatter.offset),
											speak: false
										},
										true
									);
						if (itemBlock)
							walkNodes(
								firstParagraph?.type === 'paragraph' ? rest : (item.children ?? []),
								itemBlock.id
							);
					});
					break;
				}
				case 'code': {
					const codeLanguage = node.lang?.trim().toLowerCase();
					if (codeLanguage === 'math') {
						add('math', node.value ?? '', {
							parentId,
							anchor: anchorFor(node, frontmatter.offset),
							speak: false
						});
					} else if (codeLanguage === 'mermaid') {
						add('mermaid', node.value ?? '', {
							parentId,
							codeLanguage: 'mermaid',
							anchor: anchorFor(node, frontmatter.offset)
						});
					} else {
						add('code', node.value ?? '', {
							parentId,
							codeLanguage: node.lang?.trim() || undefined,
							anchor: anchorFor(node, frontmatter.offset)
						});
					}
					break;
				}
				case 'math':
					add('math', node.value ?? '', {
						parentId,
						anchor: anchorFor(node, frontmatter.offset),
						speak: false
					});
					break;
				case 'footnoteDefinition': {
					const [firstParagraph, ...rest] = node.children ?? [];
					const footnoteExtras: Partial<DocumentBlock> = {
						parentId,
						children: [],
						footnoteId: `footnote-${footnoteId(node.identifier)}`,
						footnoteLabel: node.label ?? node.identifier ?? 'Note'
					};
					const footnote =
						firstParagraph?.type === 'paragraph'
							? addInlineBlock('footnote', node, [firstParagraph], footnoteExtras)
							: add(
									'footnote',
									'',
									{
										...footnoteExtras,
										anchor: anchorFor(node, frontmatter.offset),
										speak: false
									},
									true
								);
					if (footnote)
						walkNodes(
							firstParagraph?.type === 'paragraph' ? rest : (node.children ?? []),
							footnote.id
						);
					break;
				}
				case 'table':
					addTable(node, parentId);
					break;
				case 'thematicBreak':
					add(
						'divider',
						'',
						{ parentId, anchor: anchorFor(node, frontmatter.offset), speak: false },
						true
					);
					break;
				case 'defList': {
					const definitionList = add(
						'definition-list',
						'',
						{
							parentId,
							children: [],
							anchor: anchorFor(node, frontmatter.offset),
							speak: false
						},
						true
					);
					if (!definitionList) break;
					for (const entry of node.children ?? []) {
						if (entry.type === 'defListTerm') {
							addInlineBlock('definition-term', entry, [entry], { parentId: definitionList.id });
						} else if (entry.type === 'defListDescription') {
							const [firstParagraph, ...rest] = entry.children ?? [];
							const description =
								firstParagraph?.type === 'paragraph'
									? addInlineBlock('definition-description', entry, [firstParagraph], {
											parentId: definitionList.id,
											children: []
										})
									: add(
											'definition-description',
											'',
											{
												parentId: definitionList.id,
												children: [],
												anchor: anchorFor(entry, frontmatter.offset),
												speak: false
											},
											true
										);
							if (description)
								walkNodes(
									firstParagraph?.type === 'paragraph' ? rest : (entry.children ?? []),
									description.id
								);
						}
					}
					break;
				}
				case 'html': {
					const html = parseSafeHtml(node.value ?? '');
					const text = safeHtmlText(html);
					if (html.length) {
						add('html', text, {
							parentId,
							html,
							anchor: anchorFor(node, frontmatter.offset),
							speak: false
						});
					}
					break;
				}
				default:
					if (node.children?.length) walkNodes(node.children, parentId);
			}
		}
	};

	if (frontmatter.raw !== undefined) {
		add('frontmatter', frontmatter.raw, {
			codeLanguage: frontmatter.language,
			anchor: { start: 0, end: frontmatter.offset },
			speak: false
		});
	}
	walkNodes(tree.children ?? []);
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

function looksLikeMarkdown(text: string): boolean {
	const source = text.replace(/^\uFEFF/, '');
	return [
		/^\s*---\s*\n[\s\S]+?\n---\s*(?:\n|$)/,
		/^\s{0,3}#{1,6}\s+\S/m,
		/^\s{0,3}(?:`{3,}|~{3,})(?:\w+)?\s*$/m,
		/^\s{0,3}>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/im,
		/^\s{0,3}>\s+\S/m,
		/^\s{0,3}(?:[-+*]|\d+[.)])\s+\S/m,
		/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}/m,
		/^\s*(?:\$\$|```math)\s*$/m,
		/!\[[^\]]*\]\([^\s)]+(?:\s+['"][^'"]*['"])?\)/,
		/\[[^\]]+\]\([^\s)]+(?:\s+['"][^'"]*['"])?\)/,
		/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/m
	].some((pattern) => pattern.test(source));
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

/** Join per-page LiteParse output into one markdown document, preferring the
 * structured markdown and falling back to each page's plain text. */
export function liteparsePageMarkdown(pages: Array<{ markdown?: string; text?: string }>): string {
	return pages
		.map((page) => page.markdown?.trim() || page.text?.trim() || '')
		.filter(Boolean)
		.join('\n\n');
}

/**
 * LiteParse's font-weight heuristics sometimes flag every body paragraph of a
 * PDF as bold. When emphasis stops being selective — most non-heading lines
 * are fully wrapped in ** ** — it carries no meaning, so unwrap those lines.
 * Documents where bold is used sparingly are left untouched.
 */
export function stripBlanketBold(markdown: string): string {
	const lines = markdown.split('\n');
	const isStructural = (line: string) => /^(#{1,6}\s|\||```|[-*+]\s|\d+[.)]\s|>)/.test(line);
	const fullyBold = (line: string) =>
		/^\*\*[^*]/.test(line) && /[^*]\*\*$/.test(line) && !line.slice(2, -2).includes('**');
	const body = lines.map((line) => line.trim()).filter((line) => line && !isStructural(line));
	if (!body.length) return markdown;
	const boldShare = body.filter(fullyBold).length / body.length;
	if (boldShare < 0.6) return markdown;
	return lines
		.map((line) => {
			const trimmed = line.trim();
			if (!isStructural(trimmed) && fullyBold(trimmed)) {
				return line.replace(trimmed, trimmed.slice(2, -2));
			}
			return line;
		})
		.join('\n');
}

/** A text layer this thin means the pages are scans, not embedded text. */
export function pdfLooksScanned(markdown: string, pageCount: number): boolean {
	const letters = markdown.replace(/[^\p{L}\p{N}]/gu, '').length;
	return letters < Math.max(24, pageCount * 8);
}

/**
 * Preferred PDF path: LiteParse (run-llama's wasm extractor) converts the
 * whole document to markdown — headings, lists, and tables land in the same
 * pipeline as native markdown files, so equations-in-text, tables, and
 * structure all survive import. Returns null when the library cannot run
 * here (old browser, test environment) so the legacy extractor takes over;
 * a scanned-PDF verdict propagates as the user-facing ImportError.
 */
async function parsePdfWithLiteparse(file: File): Promise<ParsedSource | null> {
	try {
		const [glue, wasm] = await Promise.all([
			import('@llamaindex/liteparse-wasm'),
			import('@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url')
		]);
		await glue.default({ module_or_path: wasm.default });
		const parser = new glue.LiteParse({
			ocrEnabled: false,
			outputFormat: 'markdown',
			extractLinks: true,
			imageMode: 'off',
			quiet: true
		});
		let result: Awaited<ReturnType<typeof parser.parse>>;
		try {
			result = await parser.parse(new Uint8Array(await file.arrayBuffer()));
		} finally {
			parser.free();
		}
		const markdown = stripBlanketBold(liteparsePageMarkdown(result.pages));
		if (pdfLooksScanned(markdown, result.pages.length)) {
			throw new ImportError(
				'This PDF appears to be scanned. OCR support is planned, but is not part of this release.',
				'scanned-pdf'
			);
		}
		const parsed = parseMarkdown(markdown);
		return parsed.blocks.length ? parsed : null;
	} catch (error) {
		if (error instanceof ImportError) throw error;
		// Initialization or parse trouble: quietly fall back to the legacy
		// pdf.js text extractor rather than failing the import outright.
		return null;
	}
}

async function parsePdf(file: File): Promise<ParsedSource> {
	const structured = await parsePdfWithLiteparse(file);
	if (structured) return structured;
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
	const markdown = looksLikeMarkdown(text);
	const parsed = markdown ? parseMarkdown(text) : { blocks: textBlocks(text) };
	const blocks = parsed.blocks.map((candidate, index) => ({ ...candidate, id: `b${index}` }));
	const id = crypto.randomUUID();
	const resolvedTitle = title.trim() || parsed.title || 'Pasted text';
	return {
		normalizationVersion: DOCUMENT_NORMALIZATION_VERSION,
		id,
		fingerprint: `pasted-${id}`,
		title: resolvedTitle,
		sourceName: `${resolvedTitle}.${markdown ? 'md' : 'txt'}`,
		sourceKind: markdown ? 'markdown' : 'text',
		mimeType: markdown ? 'text/markdown' : 'text/plain',
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
