/**
 * Document lens: where a block sits in the document's shape. Gives prompt
 * builders a breadcrumb ("Title › Section › Subsection") and a compact
 * outline so descriptions and explanations are written knowing their place,
 * not just their neighbouring sentences.
 */
import type { DocumentBlock, OutlineEntry } from './types';

export interface DocumentLensSource {
	title: string;
	blocks: DocumentBlock[];
	outline: OutlineEntry[];
}

/** "Title › Section › Subsection" for the outline path above a block. */
export function breadcrumbFor(source: DocumentLensSource, blockId: string): string {
	const positions = new Map(source.blocks.map((block, index) => [block.id, index]));
	const target = positions.get(blockId);
	if (target === undefined) return source.title;
	const stack: OutlineEntry[] = [];
	for (const entry of source.outline) {
		const position = positions.get(entry.blockId);
		if (position === undefined || position > target) continue;
		while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
		stack.push(entry);
	}
	return [source.title, ...stack.map((entry) => entry.title)].join(' › ');
}

/** Indented outline text, capped so prompts stay bounded. */
export function outlineText(source: DocumentLensSource, maxEntries = 40): string {
	if (!source.outline.length) return '';
	const shown = source.outline.slice(0, maxEntries);
	const lines = shown.map(
		(entry) => `${'  '.repeat(Math.max(0, entry.level - 1))}- ${entry.title}`
	);
	const remaining = source.outline.length - shown.length;
	if (remaining > 0) lines.push(`(+${remaining} more sections)`);
	return lines.join('\n');
}
