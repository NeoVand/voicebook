/**
 * Persistent reader annotations: gold highlights and margin notes anchored to
 * block character ranges. The anchors ride out listening-mode re-segmentation
 * for free — segmentation never touches block text — while normalization
 * re-parses go through rescueAnnotations, which verifies each range against
 * its stored excerpt and re-locates it by text search when block ids or
 * offsets have shifted. Rescue failure orphans the annotation rather than
 * deleting it: the reader's ink is precious, and a later re-parse may bring
 * the text back.
 */
import type {
	AnnotationAnchor,
	DocumentAnnotation,
	DocumentBlock,
	NormalizedDocument,
	SpeechSegment
} from './types';
import type { PassageRange } from './assistant-context';

/** Excerpts clamp to head + '…' + tail so a chapter-long highlight cannot
 * bloat the record; both slices stay far longer than the rescue probes. */
const EXCERPT_HEAD_CHARS = 300;
const EXCERPT_TAIL_CHARS = 99;

/** Head/tail probe length used to verify and re-locate an anchored range. */
const RESCUE_PROBE_CHARS = 60;

export const ANNOTATION_NOTE_LIMIT = 600;

function normalizeText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function blockOrder(blocks: DocumentBlock[]): Map<string, number> {
	return new Map(blocks.map((block, index) => [block.id, index]));
}

/** The raw text between an annotation's anchors, joined across blocks, or
 * undefined when the anchors do not resolve against these blocks. */
function anchoredText(
	blocks: DocumentBlock[],
	order: Map<string, number>,
	start: AnnotationAnchor,
	end: AnnotationAnchor
): string | undefined {
	const startAt = order.get(start.blockId);
	const endAt = order.get(end.blockId);
	if (startAt === undefined || endAt === undefined || startAt > endAt) return undefined;
	if (startAt === endAt && start.offset >= end.offset) return undefined;
	const parts: string[] = [];
	for (let index = startAt; index <= endAt; index += 1) {
		const text = blocks[index].text;
		const from = index === startAt ? start.offset : 0;
		const to = index === endAt ? end.offset : text.length;
		if (from > text.length || to > text.length) return undefined;
		parts.push(text.slice(from, to));
	}
	return parts.join(' ');
}

function excerptFor(text: string): string {
	const normalized = normalizeText(text);
	if (normalized.length <= EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS + 1) return normalized;
	return `${normalized.slice(0, EXCERPT_HEAD_CHARS)}…${normalized.slice(-EXCERPT_TAIL_CHARS)}`;
}

/** Whether the text now under the anchors still reads as the stored excerpt.
 * Probes both ends rather than comparing whole strings so clamped excerpts
 * verify the same way as short ones. */
function matchesExcerpt(excerpt: string, text: string): boolean {
	if (!excerpt) return false;
	const normalized = normalizeText(text);
	return (
		normalized.startsWith(excerpt.slice(0, RESCUE_PROBE_CHARS)) &&
		normalized.endsWith(excerpt.slice(-RESCUE_PROBE_CHARS))
	);
}

/**
 * Create an annotation covering a segment range, snapped to the segments'
 * block character ranges. Returns undefined when the range does not resolve.
 */
export function annotationForRange(
	doc: NormalizedDocument,
	range: PassageRange,
	options: { createdBy: DocumentAnnotation['createdBy']; note?: string }
): DocumentAnnotation | undefined {
	const first = doc.segments[range.startIndex];
	const last = doc.segments[range.endIndex];
	if (!first || !last) return undefined;
	const start = { blockId: first.blockId, offset: first.start };
	const end = { blockId: last.blockId, offset: last.end };
	const text = anchoredText(doc.blocks, blockOrder(doc.blocks), start, end);
	if (!text) return undefined;
	const now = Date.now();
	const note = options.note?.trim().slice(0, ANNOTATION_NOTE_LIMIT);
	return {
		id: crypto.randomUUID(),
		start,
		end,
		excerpt: excerptFor(text),
		...(note ? { note } : {}),
		createdBy: options.createdBy,
		createdAt: now,
		updatedAt: now
	};
}

/**
 * The segments an annotation paints, in reading order. Empty for orphaned
 * annotations or anchors that no longer resolve.
 */
export function annotationSegments(
	doc: NormalizedDocument,
	annotation: DocumentAnnotation
): SpeechSegment[] {
	if (annotation.orphaned) return [];
	const order = blockOrder(doc.blocks);
	const startAt = order.get(annotation.start.blockId);
	const endAt = order.get(annotation.end.blockId);
	if (startAt === undefined || endAt === undefined || startAt > endAt) return [];
	const covered: SpeechSegment[] = [];
	for (const segment of doc.segments) {
		const at = order.get(segment.blockId);
		if (at === undefined || at < startAt || at > endAt) continue;
		if (at === startAt && segment.end <= annotation.start.offset) continue;
		if (at === endAt && segment.start >= annotation.end.offset) continue;
		covered.push(segment);
	}
	return covered;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A probe regex that tolerates the whitespace differences a re-parse can
 * introduce (wrapping, indentation, non-breaking spaces). */
function probeRegex(probe: string): RegExp {
	return new RegExp(probe.trim().split(/\s+/).map(escapeRegExp).join('\\s+'));
}

interface ProbeMatch {
	blockIndex: number;
	start: number;
	end: number;
}

function findProbe(
	blocks: DocumentBlock[],
	pattern: RegExp,
	fromBlock: number,
	fromOffset: number
): ProbeMatch | undefined {
	for (let index = fromBlock; index < blocks.length; index += 1) {
		const haystack =
			index === fromBlock ? blocks[index].text.slice(fromOffset) : blocks[index].text;
		const match = pattern.exec(haystack);
		if (!match) continue;
		const shift = index === fromBlock ? fromOffset : 0;
		return {
			blockIndex: index,
			start: shift + match.index,
			end: shift + match.index + match[0].length
		};
	}
	return undefined;
}

/** Re-locate an annotation by searching for its excerpt's head and tail in
 * the given blocks. */
function relocate(
	annotation: DocumentAnnotation,
	blocks: DocumentBlock[]
): { start: AnnotationAnchor; end: AnnotationAnchor } | undefined {
	const excerpt = annotation.excerpt;
	if (!excerpt) return undefined;
	const headProbe = excerpt.slice(0, RESCUE_PROBE_CHARS);
	const tailProbe = excerpt.length > RESCUE_PROBE_CHARS ? excerpt.slice(-RESCUE_PROBE_CHARS) : '';
	const head = findProbe(blocks, probeRegex(headProbe), 0, 0);
	if (!head) return undefined;
	const start = { blockId: blocks[head.blockIndex].id, offset: head.start };
	// A short excerpt is its own tail: the head match bounds the whole range.
	if (!tailProbe) return { start, end: { blockId: start.blockId, offset: head.end } };
	const tail = findProbe(blocks, probeRegex(tailProbe), head.blockIndex, head.start);
	if (!tail) return undefined;
	return { start, end: { blockId: blocks[tail.blockIndex].id, offset: tail.end } };
}

/**
 * Carry annotations across a normalization re-parse. Anchors that still read
 * as their excerpt pass through untouched; shifted ones re-anchor by text
 * search; the rest are marked orphaned (kept, not painted).
 */
export function rescueAnnotations(
	annotations: DocumentAnnotation[] | undefined,
	blocks: DocumentBlock[]
): DocumentAnnotation[] | undefined {
	if (!annotations?.length) return annotations;
	const order = blockOrder(blocks);
	return annotations.map((annotation) => {
		const text = anchoredText(blocks, order, annotation.start, annotation.end);
		if (text !== undefined && matchesExcerpt(annotation.excerpt, text)) {
			if (!annotation.orphaned) return annotation;
			const restored = { ...annotation };
			delete restored.orphaned;
			return restored;
		}
		const moved = relocate(annotation, blocks);
		if (moved) {
			const rescued = { ...annotation, ...moved };
			delete rescued.orphaned;
			return rescued;
		}
		return { ...annotation, orphaned: true };
	});
}
