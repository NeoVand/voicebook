/**
 * Pure helpers for the narration work queue: document-order positions,
 * playhead-first prioritization, and the prose context handed to the LLM
 * with each construct.
 */
import type { DocumentBlock } from './types';
import type { NarrationConstruct } from './narration';

export function blockPositions(blocks: DocumentBlock[]): Map<string, number> {
	return new Map(blocks.map((block, index) => [block.id, index]));
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
