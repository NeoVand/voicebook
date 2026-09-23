/**
 * Pure helpers for the narration work queue: document-order positions,
 * playhead-first prioritization, the listening window that decides which
 * constructs are worth describing now, and the prose context handed to the
 * LLM with each construct.
 */
import type { DocumentBlock, SpeechSegment } from './types';
import type { NarrationConstruct } from './narration';

export function blockPositions(blocks: DocumentBlock[]): Map<string, number> {
	return new Map(blocks.map((block, index) => [block.id, index]));
}

/**
 * Seconds of listening from the start of the document to each block: the
 * estimated duration of every passage before it, in reading order. A block
 * with no passages of its own sits where the block before it does.
 */
export function blockTimeline(
	blocks: DocumentBlock[],
	segments: SpeechSegment[]
): Map<string, number> {
	const timeline = new Map<string, number>();
	let elapsed = 0;
	for (const segment of segments) {
		if (!timeline.has(segment.blockId)) timeline.set(segment.blockId, elapsed);
		elapsed += segment.estimatedDuration;
	}
	let last = 0;
	for (const block of blocks) {
		const at = timeline.get(block.id);
		if (at === undefined) timeline.set(block.id, last);
		else last = at;
	}
	return timeline;
}

export interface DescribeWindow {
	/** Where the reader is: the playhead, the passage on screen. */
	focusBlockIds: string[];
	/** Seconds of listening described ahead of each focus… */
	aheadSeconds: number;
	/** …and behind it, for a reader who glances back. */
	behindSeconds: number;
}

/** A construct this far behind the reader ranks with one this many times
 * further ahead — the listener is moving forward. */
const BEHIND_WEIGHT = 4;

/**
 * The constructs worth describing now: those within listening reach of the
 * reader — ahead of the playhead or of the passage on screen, plus a little
 * behind — nearest first. Everything else waits until the reader gets close,
 * or until the whole document is prepared on purpose, so opening a long page
 * no longer fires a description request for every equation in it.
 */
export function constructsInWindow(
	constructs: NarrationConstruct[],
	timeline: Map<string, number>,
	window: DescribeWindow
): NarrationConstruct[] {
	const foci = window.focusBlockIds
		.map((blockId) => timeline.get(blockId))
		.filter((at): at is number => at !== undefined);
	// Nothing to go on yet: the reader starts at the top.
	if (!foci.length) foci.push(0);
	const ranked: Array<{ construct: NarrationConstruct; rank: number }> = [];
	for (const construct of constructs) {
		const at = timeline.get(construct.blockId);
		if (at === undefined) continue;
		let rank = Number.POSITIVE_INFINITY;
		for (const focus of foci) {
			const ahead = at - focus;
			if (ahead >= 0 && ahead <= window.aheadSeconds) rank = Math.min(rank, ahead);
			else if (ahead < 0 && -ahead <= window.behindSeconds) {
				rank = Math.min(rank, -ahead * BEHIND_WEIGHT);
			}
		}
		if (Number.isFinite(rank)) ranked.push({ construct, rank });
	}
	// Array sort is stable, so equal ranks keep document order.
	return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.construct);
}

/**
 * Stable re-sort: constructs at or after the playhead first (in document
 * order), then the ones before it — the diagram the listener is about to
 * reach gets rewritten before back-matter.
 */
export function prioritizeQueue(
	queue: NarrationConstruct[],
	positions: Map<string, number>,
	playheadBlockId: string | undefined
): NarrationConstruct[] {
	if (!playheadBlockId) return [...queue];
	const playhead = positions.get(playheadBlockId);
	if (playhead === undefined) return [...queue];
	const ahead: NarrationConstruct[] = [];
	const behind: NarrationConstruct[] = [];
	for (const construct of queue) {
		const position = positions.get(construct.blockId) ?? Number.MAX_SAFE_INTEGER;
		(position >= playhead ? ahead : behind).push(construct);
	}
	return [...ahead, ...behind];
}

const CONTEXT_KINDS = new Set([
	'paragraph',
	'heading',
	'list-item',
	'quote',
	'footnote',
	'definition-term',
	'definition-description'
]);

/** Marks where the narration will be spoken inside its surrounding prose, so
 * the model writes a continuation of the flow rather than an announcement. */
export const NARRATION_SLOT = '⟪the narration speaks here⟫';

/**
 * The prose surrounding a construct's block, with an explicit slot where the
 * narration will land: "…text before ⟪the narration speaks here⟫ text
 * after…". The sentence after a display equation usually defines the symbols
 * ("where the discount factor gamma controls…"), and the prose around a
 * table or diagram is what its narration should connect to.
 */
export function documentContextFor(
	blocks: DocumentBlock[],
	construct: NarrationConstruct,
	limits: { before?: number; after?: number } = {}
): string {
	const beforeLimit = limits.before ?? 260;
	const afterLimit = limits.after ?? 220;
	const index = blocks.findIndex((block) => block.id === construct.blockId);
	if (index < 0) return '';
	let before = '';
	for (let cursor = index - 1; cursor >= 0 && before.length < beforeLimit; cursor -= 1) {
		const block = blocks[cursor];
		if (!CONTEXT_KINDS.has(block.kind) || !block.text.trim()) continue;
		before = before ? `${block.text} ${before}` : block.text;
	}
	if (before.length > beforeLimit) before = before.slice(-beforeLimit);

	let after = '';
	if (afterLimit > 0) {
		for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
			const block = blocks[cursor];
			if (!CONTEXT_KINDS.has(block.kind) || !block.text.trim()) continue;
			after = block.text.replace(/\s+/g, ' ').trim();
			if (after.length > afterLimit) {
				const clipped = after.slice(0, afterLimit);
				const sentenceEnd = Math.max(
					clipped.lastIndexOf('. '),
					clipped.lastIndexOf('! '),
					clipped.lastIndexOf('? ')
				);
				after = sentenceEnd > afterLimit * 0.3 ? clipped.slice(0, sentenceEnd + 1) : clipped;
			}
			break;
		}
	}
	if (!before && !after) return '';
	return [before, NARRATION_SLOT, after].filter(Boolean).join(' ');
}
