/**
 * The document map: the table of contents the assistant reasons over when a
 * document is too long to carry whole. Every section knows where it is (its
 * ⟦first–last⟧ passage markers), how long it takes to hear, what it is about
 * — the study note when one is ready, otherwise its opening line — and its
 * entry points: the equations, tables, figures, and code it holds, plus the
 * reader's own highlights, margin notes, and saved memories. The model reads
 * the map, decides where to look, and fetches the real text with its reading
 * tools. Pure: everything is derived from the document.
 */
import { codeNoun, mermaidNoun } from './narration';
import type { BlockKind, DocumentBlock, NormalizedDocument } from './types';

/** A long stretch without headings is split into parts about this long, so a
 * read fetches one coherent piece and the map still says where things are. */
export const MAP_PART_WORDS = 1_800;
/** Entry points listed per section; the rest are counted. */
const ENTRY_CAP = 8;
const GIST_CHARS = 180;
const LABEL_CHARS = 90;
/** Shorter equations are symbols in passing (a caption's f(t)), not places
 * worth pointing at. */
const EQUATION_MIN_CHARS = 8;
/** Share of a section's passages played back before it counts as heard —
 * the study layer's reader state uses the same threshold. */
const HEARD_FRACTION = 0.6;

export type MapEntryKind =
	'equation' | 'table' | 'figure' | 'code' | 'diagram' | 'highlight' | 'note' | 'memory';

export interface MapEntry {
	kind: MapEntryKind;
	/** The passage it sits at — its ⟦n⟧ marker. */
	segment: number;
	label: string;
}

export interface MapSection {
	/** The handle the reading tools accept: S1, S2, … in reading order. */
	id: string;
	title: string;
	/** Depth in the map, 1 = top level. Parts of a long section sit one deeper. */
	level: number;
	/** The section's first block — its scroll anchor. */
	blockId: string;
	/** Inclusive passage range, as ⟦n⟧ markers. */
	start: number;
	end: number;
	words: number;
	seconds: number;
	/** The study note, or the section's opening line; empty when the section
	 * opens straight into its subsections or parts, which carry their own. */
	gist: string;
	/** The gist is a study note rather than the section's opening line. */
	noted: boolean;
	heard: boolean;
	discussed: boolean;
	entries: MapEntry[];
	/** Entry points beyond the cap. */
	moreEntries: number;
}

export interface DocumentMap {
	title: string;
	sections: MapSection[];
	words: number;
	seconds: number;
}

interface Bound {
	blockIndex: number;
	blockId: string;
	title: string;
	level: number;
	/** Holds only its own text, up to the next heading of any level: the lead
	 * before the first heading, or the document's title heading. Left off the
	 * map when that text offers nothing to read or point at. */
	flat?: boolean;
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= limit) return flat;
	const cut = flat.slice(0, limit);
	const space = cut.lastIndexOf(' ');
	return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`;
}

function wordCount(text: string): number {
	return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/** Where each block sits, and which passages each block owns. */
function indexDocument(doc: NormalizedDocument) {
	const blockIndex = new Map(doc.blocks.map((block, index) => [block.id, index]));
	const firstSegment = new Map<string, number>();
	const segmentsByBlock = new Map<string, number[]>();
	doc.segments.forEach((segment, index) => {
		if (!firstSegment.has(segment.blockId)) firstSegment.set(segment.blockId, index);
		const list = segmentsByBlock.get(segment.blockId);
		if (list) list.push(index);
		else segmentsByBlock.set(segment.blockId, [index]);
	});
	return { blockIndex, firstSegment, segmentsByBlock };
}

function sectionBounds(
	doc: NormalizedDocument,
	blockIndex: Map<string, number>,
	firstSegment: Map<string, number>
): Bound[] {
	const headings = doc.outline
		.map((entry) => ({ entry, at: blockIndex.get(entry.blockId) }))
		.filter(
			(item): item is { entry: (typeof doc.outline)[number]; at: number } => item.at !== undefined
		)
		.sort((a, b) => a.at - b.at);
	const firstHeadingAt = headings[0]?.at ?? doc.blocks.length;
	const hasLead = doc.blocks.slice(0, firstHeadingAt).some((block) => firstSegment.has(block.id));
	// A lone top-level heading opening the document is its title, not a
	// chapter: it holds just the text under it, and the headings after it move
	// up a level — otherwise every real section sits one level deep.
	const [first, ...rest] = headings;
	const restLevel = rest.reduce((min, item) => Math.min(min, item.entry.level), Infinity);
	const titled = !hasLead && rest.length > 0 && first.entry.level < restLevel;
	const body = titled ? rest : headings;
	const shift = body.reduce((min, item) => Math.min(min, item.entry.level), Infinity) - 1;
	const bounds: Bound[] = [];
	if (hasLead) {
		bounds.push({
			blockIndex: 0,
			blockId: doc.blocks[0].id,
			title: doc.title,
			level: 1,
			flat: true
		});
	}
	if (titled) {
		bounds.push({
			blockIndex: first.at,
			blockId: first.entry.blockId,
			title: first.entry.title,
			level: 1,
			flat: true
		});
	}
	for (const { entry, at } of body) {
		bounds.push({
			blockIndex: at,
			blockId: entry.blockId,
			title: entry.title,
			level: Math.max(1, entry.level - shift)
		});
	}
	return bounds;
}

interface Span {
	title: string;
	level: number;
	blockId: string;
	segments: number[];
	/** Blocks whose gist and entry points belong to this row — the section's
	 * own text before its first subheading; none when parts carry them. */
	blocks: DocumentBlock[];
}

/** Split a long run of blocks into parts of roughly MAP_PART_WORDS, cutting
 * only between blocks — at whichever boundary lands a part nearest that. */
function splitIntoParts(
	blocks: DocumentBlock[],
	segmentsByBlock: Map<string, number[]>,
	doc: NormalizedDocument
): Array<{ blocks: DocumentBlock[]; segments: number[] }> {
	const parts: Array<{ blocks: DocumentBlock[]; segments: number[] }> = [];
	let current: { blocks: DocumentBlock[]; segments: number[] } = { blocks: [], segments: [] };
	let words = 0;
	for (const block of blocks) {
		const owned = segmentsByBlock.get(block.id) ?? [];
		const blockWords = owned.reduce((sum, index) => sum + wordCount(doc.segments[index].text), 0);
		if (current.segments.length && words + blockWords / 2 > MAP_PART_WORDS) {
			parts.push(current);
			current = { blocks: [], segments: [] };
			words = 0;
		}
		current.blocks.push(block);
		current.segments.push(...owned);
		words += blockWords;
	}
	if (current.segments.length) parts.push(current);
	return parts;
}

const PROSE_KINDS = new Set<BlockKind>([
	'paragraph',
	'list-item',
	'quote',
	'alert',
	'details',
	'definition-description'
]);

/** The italic byline a web import puts under the title — the site's name
 * makes a poor summary of what the page opens with. */
function bylineIds(doc: NormalizedDocument): Set<string> {
	if (doc.sourceKind !== 'web') return new Set();
	const byline = doc.blocks
		.slice(0, 3)
		.find(
			(block) =>
				block.kind === 'paragraph' &&
				Boolean(block.inlines?.length) &&
				block.inlines!.every((run) => !run.text.trim() || run.marks?.includes('emphasis'))
		);
	return new Set(byline ? [byline.id] : []);
}

/** The first line of real prose: not a heading, a construct's description,
 * a figure or its caption, the byline, or back matter. */
function openingLine(
	doc: NormalizedDocument,
	blocks: DocumentBlock[],
	segmentsByBlock: Map<string, number[]>,
	skip: Set<string>
): string {
	const flat = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
	// A figure's caption is not how the section opens — whether it rides in
	// the image's paragraph or follows it, repeating the image's alt text.
	const captions = new Set<string>();
	for (const block of blocks) {
		const images = (block.inlines ?? []).filter((run) => run.image);
		for (const run of images) if (run.image?.alt) captions.add(flat(run.image.alt));
		if (!PROSE_KINDS.has(block.kind) || skip.has(block.id) || images.length) continue;
		if (captions.has(flat(block.text))) continue;
		for (const at of segmentsByBlock.get(block.id) ?? []) {
			const segment = doc.segments[at];
			if (segment.role === 'back-matter' || segment.narration?.kind === 'construct') continue;
			if (segment.text.trim()) return tidyMath(segment.text);
		}
	}
	return '';
}

const STYLE_WRAPPER = /\{\\(?:display|text|script)style\s*/g;

/**
 * Text as a model should read it: Wikipedia wraps every formula in
 * {\displaystyle …} and pads inline ones with invisible word joiners, which
 * only cost tokens. The wrapper's content stays exactly as written.
 */
export function tidyMath(text: string): string {
	let tidy = text.replace(/\u2060/g, '');
	for (let match = STYLE_WRAPPER.exec(tidy); match; match = STYLE_WRAPPER.exec(tidy)) {
		let depth = 1;
		let at = match.index + match[0].length;
		for (; at < tidy.length && depth; at += 1) {
			if (tidy[at] === '{' && tidy[at - 1] !== '\\') depth += 1;
			else if (tidy[at] === '}' && tidy[at - 1] !== '\\') depth -= 1;
		}
		if (depth) break;
		const inner = tidy.slice(match.index + match[0].length, at - 1).trim();
		tidy = `${tidy.slice(0, match.index)}${inner}${tidy.slice(at)}`;
		STYLE_WRAPPER.lastIndex = match.index;
	}
	STYLE_WRAPPER.lastIndex = 0;
	return tidy;
}

/** An equation's source, unwrapped — "\scriptstyle f(t)" is just f(t). */
function equationSource(latex: string): string {
	return tidyMath(latex)
		.trim()
		.replace(/^\\(?:display|text|script)style\s*/, '')
		.trim();
}

function entriesFor(
	doc: NormalizedDocument,
	blocks: DocumentBlock[],
	firstSegment: Map<string, number>
): MapEntry[] {
	const inSpan = new Set(blocks.map((block) => block.id));
	const marks: MapEntry[] = [];
	for (const annotation of doc.annotations ?? []) {
		if (annotation.orphaned || !inSpan.has(annotation.start.blockId)) continue;
		const segment = firstSegment.get(annotation.start.blockId);
		if (segment === undefined) continue;
		marks.push(
			annotation.note
				? { kind: 'note', segment, label: clip(annotation.note, LABEL_CHARS) }
				: { kind: 'highlight', segment, label: `“${clip(annotation.excerpt, LABEL_CHARS - 2)}”` }
		);
	}
	for (const memory of doc.memories ?? []) {
		if (!memory.blockId || !inSpan.has(memory.blockId)) continue;
		const segment = firstSegment.get(memory.blockId);
		if (segment === undefined) continue;
		marks.push({ kind: 'memory', segment, label: clip(memory.text, LABEL_CHARS) });
	}
	const constructs: MapEntry[] = [];
	for (const block of blocks) {
		const segment = firstSegment.get(block.id);
		if (segment === undefined) continue;
		const mermaid =
			block.kind === 'mermaid' || (block.kind === 'code' && block.codeLanguage === 'mermaid');
		if (block.kind === 'math') {
			const source = equationSource(block.text);
			if (source.length >= EQUATION_MIN_CHARS) {
				constructs.push({ kind: 'equation', segment, label: clip(source, LABEL_CHARS) });
			}
		} else if (block.table) {
			const header = block.table.header.map((cell) => cell.text.trim()).filter(Boolean);
			const label = header.length
				? `columns ${header.join(', ')}`
				: `${block.table.rows.length} rows`;
			constructs.push({ kind: 'table', segment, label: clip(label, LABEL_CHARS) });
		} else if (mermaid) {
			constructs.push({ kind: 'diagram', segment, label: mermaidNoun(block.text) });
		} else if (block.kind === 'code') {
			// Preformatted prose and verse are text, not code worth pointing at.
			const noun = codeNoun(block.codeLanguage);
			if (noun !== 'text') constructs.push({ kind: 'code', segment, label: noun });
		}
		for (const run of block.inlines ?? []) {
			const label = run.image?.alt?.trim() || run.image?.title?.trim();
			if (label) constructs.push({ kind: 'figure', segment, label: clip(label, LABEL_CHARS) });
		}
	}
	// The reader's own marks first: they are why a place matters to them.
	return [...marks.sort((a, b) => a.segment - b.segment), ...constructs];
}

/** Build the map for a document. Cheap enough to rebuild on every session. */
export function buildDocumentMap(doc: NormalizedDocument): DocumentMap {
	const { blockIndex, firstSegment, segmentsByBlock } = indexDocument(doc);
	const bounds = sectionBounds(doc, blockIndex, firstSegment);
	const segmentsOf = (blocks: DocumentBlock[]) =>
		blocks.flatMap((block) => segmentsByBlock.get(block.id) ?? []);
	const byline = bylineIds(doc);
	const notes = new Map(
		(doc.study?.nodes ?? [])
			.filter((node) => node.status === 'ready' && node.summary)
			.map((node) => [node.blockId, node.summary as string])
	);
	const spans: Array<Span & { gist: string; noted: boolean; entries: MapEntry[] }> = [];
	const pushSpan = (span: Span, split = false) => {
		const note = notes.get(span.blockId);
		const opening = split ? '' : openingLine(doc, span.blocks, segmentsByBlock, byline);
		spans.push({
			...span,
			gist: clip(note ?? opening, GIST_CHARS),
			noted: Boolean(note),
			entries: entriesFor(doc, span.blocks, firstSegment)
		});
	};
	bounds.forEach((bound, index) => {
		// Sections nest like a table of contents: a chapter runs to the next
		// heading at its level or above, so its range, size, and a read of it
		// take in its subsections. Its own text — up to the first subheading —
		// supplies its gist and entry points; the subsections list theirs.
		const ownTo = bounds[index + 1]?.blockIndex ?? doc.blocks.length;
		let to = ownTo;
		if (!bound.flat) {
			const next = bounds.slice(index + 1).find((later) => later.level <= bound.level);
			to = next?.blockIndex ?? doc.blocks.length;
		}
		const segments = segmentsOf(doc.blocks.slice(bound.blockIndex, to));
		if (!segments.length) return;
		const own = doc.blocks.slice(bound.blockIndex, ownTo);
		const base = { title: bound.title, level: bound.level, blockId: bound.blockId };
		const ownWords = segmentsOf(own).reduce((sum, at) => sum + wordCount(doc.segments[at].text), 0);
		// A long stretch without subheadings: the row still spans it all, and
		// parts carry the gists and entry points, each a readable piece.
		const parts = ownWords > MAP_PART_WORDS * 1.3 ? splitIntoParts(own, segmentsByBlock, doc) : [];
		if (parts.length < 2) {
			const before = spans.length;
			pushSpan({ ...base, segments, blocks: own });
			const added = spans[before];
			if (bound.flat && !added.gist && !added.entries.length) spans.pop();
			return;
		}
		pushSpan({ ...base, segments, blocks: [] }, true);
		parts.forEach((part, partIndex) => {
			pushSpan({
				title: `${bound.title} (part ${partIndex + 1} of ${parts.length})`,
				level: bound.level + 1,
				blockId: part.blocks[0].id,
				segments: part.segments,
				blocks: part.blocks
			});
		});
	});

	const discussed = new Set(doc.conversation?.discussedBlockIds ?? []);
	const listened = doc.listened ?? {};
	const sections = spans.map((span, index): MapSection => {
		const ordered = [...span.segments].sort((a, b) => a - b);
		let words = 0;
		let seconds = 0;
		let heardCount = 0;
		for (const at of ordered) {
			const segment = doc.segments[at];
			words += wordCount(segment.text);
			seconds += segment.estimatedDuration;
			if (listened[segment.id]?.length) heardCount += 1;
		}
		return {
			id: `S${index + 1}`,
			title: span.title,
			level: span.level,
			blockId: span.blockId,
			start: ordered[0],
			end: ordered[ordered.length - 1],
			words,
			seconds,
			gist: span.gist,
			noted: span.noted,
			heard: heardCount / ordered.length >= HEARD_FRACTION,
			discussed: ordered.some((at) => discussed.has(doc.segments[at].blockId)),
			entries: span.entries.slice(0, ENTRY_CAP),
			moreEntries: Math.max(0, span.entries.length - ENTRY_CAP)
		};
	});

	return {
		title: doc.title,
		sections,
		words: doc.segments.reduce((sum, segment) => sum + wordCount(segment.text), 0),
		seconds: doc.segments.reduce((sum, segment) => sum + segment.estimatedDuration, 0)
	};
}

/** Accepts S12, s12, §12, or 12 — and a handle copied with its title,
 * "S12 Sampling", as models tend to write it. */
export function mapSection(map: DocumentMap, handle: string): MapSection | undefined {
	const number = /^\s*(?:s|§)?\s*(\d+)(?![\d.])/i.exec(handle)?.[1];
	return number ? map.sections[Number(number) - 1] : undefined;
}

/** The innermost section holding a passage — for placing search hits and
 * the reader's focus on the map. */
export function sectionAt(map: DocumentMap, segment: number): MapSection | undefined {
	let found: MapSection | undefined;
	for (const section of map.sections) {
		if (section.start <= segment && segment <= section.end) {
			if (!found || section.level >= found.level) found = section;
		}
	}
	return found;
}

function duration(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 1) return 'under a minute';
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const ENTRY_NAMES: Record<MapEntryKind, string> = {
	equation: 'equation',
	table: 'table',
	figure: 'figure',
	code: 'code',
	diagram: 'diagram',
	highlight: 'reader highlight',
	note: 'reader note',
	memory: 'saved note'
};

interface Detail {
	/** Deepest level whose entry points are listed. */
	entries: number;
	/** Deepest level whose gist is shown. */
	gists: number;
	/** Deepest level listed at all; deeper sections are counted instead. */
	sections: number;
}

/** From richest to most compact — the first that fits the budget wins. */
const DETAILS: Detail[] = [
	{ entries: 9, gists: 9, sections: 9 },
	{ entries: 2, gists: 9, sections: 9 },
	{ entries: 0, gists: 9, sections: 9 },
	{ entries: 0, gists: 2, sections: 9 },
	{ entries: 0, gists: 2, sections: 3 },
	{ entries: 0, gists: 1, sections: 2 },
	{ entries: 0, gists: 0, sections: 1 }
];

function renderMap(map: DocumentMap, detail: Detail): string {
	const lines: string[] = [];
	let hidden = 0;
	const flushHidden = () => {
		if (!hidden || !lines.length) return;
		lines[lines.length - 1] += ` · +${hidden} deeper section${hidden === 1 ? '' : 's'}`;
		hidden = 0;
	};
	for (const section of map.sections) {
		if (section.level > detail.sections) {
			hidden += 1;
			continue;
		}
		flushHidden();
		const indent = '  '.repeat(Math.max(0, section.level - 1));
		const flags = [section.heard && 'heard', section.discussed && 'discussed'].filter(Boolean);
		lines.push(
			`${indent}${section.id} ${section.title} ⟦${section.start}–${section.end}⟧ · ${section.words.toLocaleString('en-US')} words · ${duration(section.seconds)}${flags.length ? ` · ${flags.join(', ')}` : ''}`
		);
		if (section.gist && section.level <= detail.gists) {
			lines.push(`${indent}   ${section.noted ? 'Note' : 'Opens'}: ${section.gist}`);
		}
		if (section.level <= detail.entries) {
			for (const entry of section.entries) {
				lines.push(`${indent}   • ${ENTRY_NAMES[entry.kind]} ⟦${entry.segment}⟧ ${entry.label}`);
			}
			if (section.moreEntries) lines.push(`${indent}   • +${section.moreEntries} more`);
		}
	}
	flushHidden();
	return lines.join('\n');
}

/**
 * The map as prompt text, as rich as the budget allows: entry points and
 * gists drop from the deepest levels first, then whole levels collapse into
 * counts. A map that still does not fit is cut, with a pointer to search.
 */
export function mapText(map: DocumentMap, maxChars: number): string {
	const header = `${map.title} · ${map.sections.length} sections · ${map.words.toLocaleString('en-US')} words · ${duration(map.seconds)} of listening`;
	for (const detail of DETAILS) {
		const body = renderMap(map, detail);
		if (header.length + body.length + 1 <= maxChars) return `${header}\n${body}`;
	}
	const compact = renderMap(map, DETAILS[DETAILS.length - 1]);
	const room = Math.max(0, maxChars - header.length - 80);
	const cut = compact.slice(0, room);
	return `${header}\n${cut.slice(0, cut.lastIndexOf('\n') + 1)}… (map cut to fit — search_document finds any passage)`;
}
