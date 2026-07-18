import type { DocumentBlock, OutlineEntry } from './types';

/** The slice of LiteParse's ParsedPage this module needs. */
export interface LiteparsePage {
	pageNum: number;
	width?: number;
	height?: number;
	markdown?: string;
	text?: string;
}

/** The slice of LiteParse's ExtractedImage this module needs. */
export interface LiteparseImage {
	id: string;
	page: number;
	format: string;
	bytes: number[] | Uint8Array;
}

/** The slice of LiteParse's PageComplexityStats this module needs. */
export interface PageComplexity {
	pageNumber: number;
	needsOcr: boolean;
	reasons: string[];
	textLength: number;
}

export interface PdfBookmark {
	title: string;
	page: number;
	level: number;
}

export interface PageSpan {
	page: number;
	start: number;
	end: number;
}

/** Join per-page LiteParse output into one markdown document, preferring the
 * structured markdown and falling back to each page's plain text. */
export function liteparsePageMarkdown(pages: Array<{ markdown?: string; text?: string }>): string {
	return pages
		.map((page) => page.markdown?.trim() || page.text?.trim() || '')
		.filter(Boolean)
		.join('\n\n');
}

/** A text layer this thin means the pages are scans, not embedded text. */
export function pdfLooksScanned(markdown: string, pageCount: number): boolean {
	const letters = markdown.replace(/[^\p{L}\p{N}]/gu, '').length;
	return letters < Math.max(24, pageCount * 8);
}

/** LiteParse's `needsOcr` verdict fires for merely light pages (`sparse-text`
 * on a short chapter opener), so recognizing every flagged page would OCR
 * perfectly good text. Only pages that are genuinely unreadable qualify. */
export function pagesNeedingOcr(stats: PageComplexity[]): number[] {
	const unreadable = new Set(['scanned', 'no-text', 'garbled']);
	return stats
		.filter(
			(page) =>
				page.needsOcr &&
				(page.reasons.some((reason) => unreadable.has(reason)) || page.textLength < 40)
		)
		.map((page) => page.pageNumber);
}

/** LiteParse emits pages without font metadata (blank or scanned pages) as a
 * lone ```text fence "so content is never silently dropped" — but downstream
 * that renders a whole page as one code block. Unwrap to plain paragraphs. */
export function unwrapTextFences(pageMarkdown: string): string {
	return pageMarkdown
		.replace(/^```text\n([\s\S]*?)\n?```$/gm, (_match, body: string) => body.trim())
		.replace(/^\n+|\n+$/g, '');
}

/** "R E F E R E N C E S" → "REFERENCES". PDFs letter-space display headings;
 * extraction keeps the spaces and the speech engine spells them out. Only
 * short lines made entirely of spaced-out capitals collapse (double spaces
 * separate words), so ordinary prose can never match. */
export function collapseSpacedHeadings(pageMarkdown: string): string {
	return pageMarkdown
		.split('\n')
		.map((line) => {
			const match = /^(#{1,6}\s+)?(.+)$/.exec(line.trim());
			if (!match) return line;
			const [, marker = '', body] = match;
			const words = body.split(/\s{2,}/);
			let totalLetters = 0;
			const collapsible = words.every((word) => {
				const letters = word.split(' ');
				totalLetters += letters.length;
				return (
					letters.length >= 2 && letters.every((letter) => /^[\p{Lu}\p{N}]$/u.test(letter))
				);
			});
			if (!collapsible || totalLetters < 4) return line;
			return marker + words.map((word) => word.replaceAll(' ', '')).join(' ');
		})
		.join('\n');
}

const structuralLine = (line: string) => /^(#{1,6}\s|\||```|[-*+]\s|\d+[.)]\s|>|!\[)/.test(line);

const chromeKey = (line: string) => line.trim().toLowerCase().replace(/\d+/g, '#');

/** Running headers, footers, and bare page numbers that survive LiteParse's
 * own suppression: a first/last line repeating (digits normalized) on at
 * least 60% of pages is page chrome, not content. */
export function stripRepeatedPageChrome(pages: string[]): string[] {
	if (pages.length < 3) return pages;
	const counts = new Map<string, number>();
	const edgeLines = (page: string): string[] => {
		const lines = page.split('\n').filter((line) => line.trim());
		const edges = [];
		if (lines.length) edges.push(lines[0]);
		if (lines.length > 1) edges.push(lines[lines.length - 1]);
		return edges;
	};
	for (const page of pages) {
		for (const line of new Set(edgeLines(page).map(chromeKey))) {
			if (!line || structuralLine(line)) continue;
			counts.set(line, (counts.get(line) ?? 0) + 1);
		}
	}
	const repeated = new Set(
		[...counts.entries()]
			.filter(([, count]) => count >= Math.max(3, Math.ceil(pages.length * 0.6)))
			.map(([line]) => line)
	);
	if (!repeated.size) return pages;
	return pages.map((page) => {
		const lines = page.split('\n');
		const isChrome = (line: string) =>
			line.trim() && !structuralLine(line.trim()) && repeated.has(chromeKey(line));
		let start = 0;
		let end = lines.length;
		while (start < end && (!lines[start].trim() || isChrome(lines[start]))) {
			if (isChrome(lines[start])) lines[start] = '';
			start += 1;
		}
		while (end > start && (!lines[end - 1].trim() || isChrome(lines[end - 1]))) {
			if (isChrome(lines[end - 1])) lines[end - 1] = '';
			end -= 1;
		}
		return lines.join('\n').replace(/^\n+|\n+$/g, '');
	});
}

const fullyBold = (line: string) =>
	/^\*\*[^*]/.test(line) && /[^*]\*\*$/.test(line) && !line.slice(2, -2).includes('**');

/**
 * LiteParse's font-weight heuristics sometimes flag every body paragraph of a
 * PDF as bold. When emphasis stops being selective — most non-heading lines
 * are fully wrapped in ** ** — it carries no meaning. The share is computed
 * document-wide so a single all-bold page in a normal document keeps its
 * (probably deliberate) emphasis; the rewrite is per page so page offsets
 * stay computable.
 */
export function blanketBoldShare(pages: string[]): number {
	const body = pages
		.flatMap((page) => page.split('\n'))
		.map((line) => line.trim())
		.filter((line) => line && !structuralLine(line));
	if (!body.length) return 0;
	return body.filter(fullyBold).length / body.length;
}

export function stripBlanketBoldPage(pageMarkdown: string): string {
	return pageMarkdown
		.split('\n')
		.map((line) => {
			const trimmed = line.trim();
			if (!structuralLine(trimmed) && fullyBold(trimmed)) {
				return line.replace(trimmed, trimmed.slice(2, -2));
			}
			return line;
		})
		.join('\n');
}

/** Whole-document convenience used by the pdf.js fallback and existing specs. */
export function stripBlanketBold(markdown: string): string {
	if (blanketBoldShare([markdown]) < 0.6) return markdown;
	return stripBlanketBoldPage(markdown);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function imageDataUri(image: LiteparseImage): string {
	const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
	const format = image.format === 'jpeg' || image.format === 'jpg' ? 'jpeg' : 'png';
	return `data:image/${format};base64,${bytesToBase64(bytes)}`;
}

export interface ImageRefLimits {
	/** Below this the "image" is a rule or bullet glyph, not a figure. */
	minBytes?: number;
	/** Above this the narration attachment loader would refuse it anyway. */
	perImageBytes?: number;
	/** Total embedded-image budget per document (IndexedDB bloat guard). */
	totalBytes?: number;
}

const IMAGE_LIMITS: Required<ImageRefLimits> = {
	minBytes: 4096,
	perImageBytes: 2_000_000,
	totalBytes: 25_000_000
};

function imageByteHash(bytes: Uint8Array): string {
	// fnv-1a over a sampled prefix: enough to spot the same logo repeating.
	let hash = 0x811c9dc5;
	const step = Math.max(1, Math.floor(bytes.length / 2048));
	for (let i = 0; i < bytes.length; i += step) {
		hash ^= bytes[i];
		hash = Math.imul(hash, 0x01000193);
	}
	return `${bytes.length}:${hash >>> 0}`;
}

/** Rewrite LiteParse's `![](image_pN_K.png)` references to inline data URIs
 * so the markdown pipeline turns them into image runs. Decorative fragments,
 * over-budget images, and per-page repeats (logos, watermarks) are dropped —
 * their references vanish rather than rendering broken. */
export function resolveImageRefs(
	pages: string[],
	images: LiteparseImage[],
	limits: ImageRefLimits = {}
): { pages: string[]; warnings: string[] } {
	const { minBytes, perImageBytes, totalBytes } = { ...IMAGE_LIMITS, ...limits };
	const byId = new Map(images.map((image) => [image.id, image]));
	const repeats = new Map<string, number>();
	for (const image of images) {
		const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
		const key = imageByteHash(bytes);
		repeats.set(key, (repeats.get(key) ?? 0) + 1);
	}
	let budget = totalBytes;
	let skipped = 0;
	const resolved = pages.map((page) =>
		page.replace(/!\[([^\]]*)\]\(image_(p\d+_\d+)\.(?:png|jpe?g)\)/g, (match, alt: string, id: string) => {
			const image = byId.get(id);
			if (!image) return '';
			const bytes =
				image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
			const tooSmall = bytes.length < minBytes;
			const tooBig = bytes.length > perImageBytes || bytes.length > budget;
			const repeated = (repeats.get(imageByteHash(bytes)) ?? 0) >= 3;
			if (tooSmall || repeated) return '';
			if (tooBig) {
				skipped += 1;
				return '';
			}
			budget -= bytes.length;
			return `![${alt}](${imageDataUri(image)})`;
		})
	);
	const warnings = skipped
		? [
				skipped === 1
					? 'One image was too large to keep and was skipped.'
					: `${skipped} images were too large to keep and were skipped.`
			]
		: [];
	return { pages: resolved, warnings };
}

/** How two consecutive pages join: a page break mid-word ('hyphen'),
 * mid-sentence ('space'), or between blocks ('break'). */
export function pagesJoinSeam(previous: string, next: string): 'hyphen' | 'space' | 'break' {
	const tail = previous.trimEnd().split('\n').pop() ?? '';
	const head = next.trimStart().split('\n')[0] ?? '';
	if (!tail || !head) return 'break';
	if (structuralLine(tail) || structuralLine(head)) return 'break';
	if (!/^[\p{Ll}]/u.test(head)) return 'break';
	if (/[\p{L}]-$/u.test(tail)) return 'hyphen';
	if (!/[.!?:][)”"']?$/.test(tail)) return 'space';
	return 'break';
}

/**
 * Join per-page markdown into the single document `parseMarkdown` consumes,
 * recording each page's character span so block anchors (which carry source
 * offsets) can be mapped back to pages. Sentences and hyphenated words that
 * run across a page break are mended into one paragraph.
 *
 * INVARIANT: the returned markdown must reach `parseMarkdown` unchanged — any
 * later edit shifts offsets and silently mis-pages every anchor.
 */
export function assemblePages(pages: Array<{ page: number; markdown: string }>): {
	markdown: string;
	spans: PageSpan[];
} {
	let markdown = '';
	const spans: PageSpan[] = [];
	for (const { page, markdown: raw } of pages) {
		const content = raw.trim();
		if (!content) continue;
		if (!markdown) {
			spans.push({ page, start: 0, end: content.length });
			markdown = content;
			continue;
		}
		const seam = pagesJoinSeam(markdown, content);
		if (seam === 'hyphen') markdown = markdown.replace(/-\s*$/, '');
		const separator = seam === 'break' ? '\n\n' : seam === 'space' ? ' ' : '';
		const start = markdown.length + separator.length;
		markdown = markdown + separator + content;
		spans.push({ page, start, end: markdown.length });
	}
	return { markdown, spans };
}

export function pageForOffset(spans: PageSpan[], offset: number): number | undefined {
	if (!spans.length) return undefined;
	let low = 0;
	let high = spans.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (spans[mid].start <= offset) low = mid;
		else high = mid - 1;
	}
	return spans[low].start <= offset ? spans[low].page : spans[0].page;
}

/** Stamp `anchor.page` onto blocks whose markdown-source offsets fall inside
 * a page span. A paragraph mended across a page break anchors to the page it
 * starts on. */
export function assignPageAnchors(blocks: DocumentBlock[], spans: PageSpan[]): DocumentBlock[] {
	if (!spans.length) return blocks;
	return blocks.map((candidate) => {
		if (candidate.anchor.page !== undefined || candidate.anchor.start === undefined) {
			return candidate;
		}
		const page = pageForOffset(spans, candidate.anchor.start);
		return page === undefined
			? candidate
			: { ...candidate, anchor: { ...candidate.anchor, page } };
	});
}

/** PDFs frequently jump heading levels (H1 title straight to H3 sections).
 * Clamp each heading to at most one level deeper than the previous one so the
 * outline nests sensibly. Shallower moves are kept as authored. */
export function normalizeHeadingLevels(blocks: DocumentBlock[]): DocumentBlock[] {
	let previous = 0;
	return blocks.map((candidate) => {
		if (candidate.kind !== 'heading') return candidate;
		const level = candidate.level ?? 2;
		const normalized = previous === 0 ? Math.min(level, 1) || 1 : Math.min(level, previous + 1);
		previous = normalized;
		return normalized === candidate.level ? candidate : { ...candidate, level: normalized };
	});
}

const bookmarkTitleKey = (title: string) =>
	title
		.toLowerCase()
		.replace(/[\d.]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/**
 * The PDF's own bookmarks beat guessed headings as a table of contents. Each
 * bookmark resolves to a block: a heading on the destination page with the
 * same normalized title, else any same-titled heading, else the first block
 * anchored at or after the destination page. Unresolvable bookmarks are
 * dropped (the reader assumes every outline entry navigates), and if fewer
 * than two survive the caller keeps the heading-derived outline.
 */
export function outlineFromBookmarks(
	bookmarks: PdfBookmark[],
	blocks: DocumentBlock[]
): OutlineEntry[] | null {
	if (bookmarks.length < 2) return null;
	const headings = blocks.filter((candidate) => candidate.kind === 'heading');
	const entries: OutlineEntry[] = [];
	for (const [index, bookmark] of bookmarks.entries()) {
		const key = bookmarkTitleKey(bookmark.title);
		const target =
			(key &&
				(headings.find(
					(heading) =>
						heading.anchor.page === bookmark.page && bookmarkTitleKey(heading.text) === key
				) ??
					headings.find((heading) => bookmarkTitleKey(heading.text) === key))) ||
			blocks.find(
				(candidate) =>
					candidate.anchor.page !== undefined && candidate.anchor.page >= bookmark.page
			);
		if (!target) continue;
		entries.push({
			id: `outline-bm${index}`,
			blockId: target.id,
			title: bookmark.title,
			level: Math.max(1, bookmark.level),
			page: bookmark.page
		});
	}
	return entries.length >= 2 ? entries : null;
}
