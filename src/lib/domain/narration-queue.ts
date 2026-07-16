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

/**
 * The prose surrounding a construct's block. For display equations the
 * sentence AFTER the equation usually defines the symbols ("where the
 * discount factor gamma controls…"), so a slice of the following prose block
 * is appended after the preceding text.
 */
export function documentContextFor(
	blocks: DocumentBlock[],
	construct: NarrationConstruct,
	limits: { before?: number; after?: number } = {}
): string {
	const before = limits.before ?? 260;
	const after = limits.after ?? 220;
	const index = blocks.findIndex((block) => block.id === construct.blockId);
	if (index < 0) return '';
	let context = '';
	for (let cursor = index - 1; cursor >= 0 && context.length < before; cursor -= 1) {
		const block = blocks[cursor];
		if (!CONTEXT_KINDS.has(block.kind) || !block.text.trim()) continue;
		context = context ? `${block.text} ${context}` : block.text;
	}
	if (context.length > before) context = context.slice(-before);

	if (after > 0 && (construct.kind === 'math-block' || construct.kind === 'mermaid')) {
		for (let cursor = index + 1; cursor < blocks.length; cursor += 1) {
			const block = blocks[cursor];
			if (!CONTEXT_KINDS.has(block.kind) || !block.text.trim()) continue;
			let following = block.text.replace(/\s+/g, ' ').trim();
			if (following.length > after) {
				const clipped = following.slice(0, after);
				const sentenceEnd = Math.max(
					clipped.lastIndexOf('. '),
					clipped.lastIndexOf('! '),
					clipped.lastIndexOf('? ')
				);
				following = sentenceEnd > after * 0.3 ? clipped.slice(0, sentenceEnd + 1) : clipped;
			}
			context = context ? `${context} ${following}` : following;
			break;
		}
	}
	return context;
}
