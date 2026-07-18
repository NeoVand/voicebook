import type { DocumentBlock, SpeechSegment } from './types';

/**
 * Page math for the reader: which top-level blocks start a new source page,
 * how many pages a document spans, and where the playhead sits in page
 * terms. Anchors are trusted only while non-decreasing — a stray backwards
 * page (garbled extraction) is ignored rather than minting a bogus marker.
 * Child blocks (list items, table rows) never start a page of their own.
 */
export function pageStartMap(blocks: DocumentBlock[]): Map<string, number> {
	const starts = new Map<string, number>();
	let seen = 0;
	for (const block of blocks) {
		if (block.parentId) continue;
		const page = block.anchor.page;
		if (page === undefined || page <= seen) continue;
		starts.set(block.id, page);
		seen = page;
	}
	return starts;
}

/** Highest anchored page, or undefined when the document has none. */
export function pageCount(blocks: DocumentBlock[]): number | undefined {
	let highest: number | undefined;
	for (const block of blocks) {
		const page = block.anchor.page;
		if (page !== undefined && (highest === undefined || page > highest)) highest = page;
	}
	return highest;
}

/** The first top-level block at or after `page` (clamped into the document's
 * page range), for jump-to-page navigation. */
export function blockForPage(blocks: DocumentBlock[], page: number): DocumentBlock | undefined {
	const total = pageCount(blocks);
	if (total === undefined) return undefined;
	const target = Math.max(1, Math.min(total, Math.round(page)));
	let fallback: DocumentBlock | undefined;
	for (const block of blocks) {
		if (block.parentId || block.anchor.page === undefined) continue;
		if (block.anchor.page >= target) return block;
		fallback = block;
	}
	return fallback;
}

/** The page the given segment sits on, backfilling from the nearest earlier
 * paged segment (constructs and narrations inherit their block's anchor, but
 * not every segment carries one). */
export function pageForSegmentIndex(segments: SpeechSegment[], index: number): number | undefined {
	for (let cursor = Math.min(index, segments.length - 1); cursor >= 0; cursor -= 1) {
		const page = segments[cursor]?.anchor?.page;
		if (page !== undefined) return page;
	}
	return undefined;
}
