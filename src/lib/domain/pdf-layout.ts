import type { SpeechSegment } from './types';

/**
 * Placing the spoken layer back onto the original page.
 *
 * The reader's passages come from the markdown LiteParse extracted; the page
 * view draws the PDF itself. To highlight a passage where it actually sits on
 * paper, the two have to be reconciled — and the only trustworthy bridge is
 * that LiteParse can emit a box for every word it read (`emitWordBoxes`), so
 * both sides descend from the same glyphs.
 *
 * Reconciliation is a monotonic sequence alignment: the page's words in
 * reading order against the words of the passages anchored to that page.
 * Content the spoken layer skips (equations, figure labels, running heads)
 * falls out as gaps, and so does markdown the page renders differently
 * (table pipes, heading hashes) — neither derails the words on either side of
 * it. Nothing here touches the DOM or pdf.js: it is pure geometry over two
 * token streams, so the hard part is testable.
 *
 * Coordinates throughout are PDF points with a **top-left** origin, matching
 * LiteParse's boxes and the CSS the overlay ends up writing.
 */

export interface PageWordBox {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The slice of LiteParse's TextItem this module needs. */
export interface PageTextItem {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Degrees off horizontal; rotated stamps (arXiv spines) are not prose. */
	rotation?: number;
	words?: PageWordBox[];
}

export interface PageRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Where one passage landed on one page. */
export interface SegmentPlacement {
	segmentId: string;
	page: number;
	/** Line-merged rectangles covering the passage — what the overlay paints. */
	rects: PageRect[];
	/** Index-aligned to `SpeechSegment.words`; a hole is a word that found no
	 * box (a substituted equation reading, a word the page hyphenated away). */
	wordRects: Array<PageRect | undefined>;
	/** Share of the passage's words that found a box, 0–1. */
	coverage: number;
}

/** A passage reduced to what placement needs, so tests need no full segment. */
export interface PlaceableSegment {
	id: string;
	text: string;
	words: Array<{ start: number; end: number }>;
	page: number;
	/**
	 * What to look for on the page, when that differs from what is spoken. A
	 * table row is narrated as "Layer Type: Self-Attention. Complexity per
	 * Layer: …" — prose assembled from the header labels, which the page never
	 * printed in that form. Its cells, on the other hand, are right there.
	 * Passages placed this way get no per-word boxes: the words being spoken
	 * are not the words on the page, and only the region is meaningful.
	 */
	matchText?: string;
}

/**
 * The comparison form of a word: compatibility-decomposed (so a `ﬁ` ligature
 * on the page meets the `fi` in the markdown), unaccented, lowercased, and
 * stripped of everything that is not a letter or a digit. Punctuation must go
 * — the page hyphenates and the markdown does not, and quotes differ on both
 * sides of every extraction.
 */
export function matchKey(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Every word LiteParse read on a page, in its reading order. Items without
 * word boxes (older parses, OCR text) contribute their whole box, which still
 * highlights at line granularity. */
export function pageWordBoxes(items: PageTextItem[]): PageWordBox[] {
	const boxes: PageWordBox[] = [];
	for (const item of items) {
		if (item.rotation !== undefined && Math.abs(item.rotation) > 1) continue;
		if (item.words?.length) {
			for (const word of item.words) if (word.text.trim()) boxes.push(word);
		} else if (item.text.trim()) {
			boxes.push({
				text: item.text,
				x: item.x,
				y: item.y,
				width: item.width,
				height: item.height
			});
		}
	}
	return boxes;
}

/**
 * Reading order for a page's words.
 *
 * LiteParse hands back word boxes in raster order — every line of a
 * two-column page interleaved with the line beside it. Its *markdown* reads
 * the columns properly, so the passages arrive in true reading order and the
 * boxes do not, and a monotonic alignment between the two finds almost
 * nothing. (Measured on a two-column paper: 57% of passages placed, against
 * 90% on a single-column one.)
 *
 * A recursive XY-cut recovers the order. At each step the region is split at
 * whitespace that runs all the way across it — vertical gutters first,
 * because a page whose body is two columns must break into columns before it
 * breaks into paragraphs, or the halves interleave again. A single-column
 * page finds no gutter, splits into paragraphs, and comes out in the order it
 * already had.
 */
export function readingOrder(boxes: PageWordBox[], pageWidth: number): PageWordBox[] {
	if (boxes.length < 2) return boxes;
	const line = medianHeight(boxes);
	const columnGap = Math.max(10, pageWidth * 0.025);
	const rowGap = Math.max(2, line * 0.8);
	return cut(boxes, columnGap, rowGap, line, 0);
}

/** Typical line height on the page, used to size the gaps that count as
 * whitespace. The median shrugs off headings and subscripts. */
function medianHeight(boxes: PageWordBox[]): number {
	const heights = boxes.map((box) => box.height).sort((left, right) => left - right);
	return heights[heights.length >> 1] || 10;
}

/** Regions this deep are paragraphs; splitting further only costs time. */
const MAX_CUT_DEPTH = 8;
/** A vertical split needs a region tall enough to be a column. Without this,
 * a single line with something at each margin — a running head, a page
 * number — reads as two columns. */
const MIN_COLUMN_LINES = 4;

function cut(
	boxes: PageWordBox[],
	columnGap: number,
	rowGap: number,
	line: number,
	depth: number
): PageWordBox[] {
	if (boxes.length < 2 || depth >= MAX_CUT_DEPTH) return byLine(boxes);
	const height = extent(boxes, 'y');
	if (height >= line * MIN_COLUMN_LINES) {
		const columns = split(boxes, 'x', columnGap);
		if (columns.length > 1) {
			return columns.flatMap((column) => cut(column, columnGap, rowGap, line, depth + 1));
		}
	}
	const rows = split(boxes, 'y', rowGap);
	if (rows.length > 1) {
		return rows.flatMap((row) => cut(row, columnGap, rowGap, line, depth + 1));
	}
	return byLine(boxes);
}

function extent(boxes: PageWordBox[], axis: 'x' | 'y'): number {
	const size = axis === 'x' ? 'width' : 'height';
	let low = Infinity;
	let high = -Infinity;
	for (const box of boxes) {
		low = Math.min(low, box[axis]);
		high = Math.max(high, box[axis] + box[size]);
	}
	return high - low;
}

/** Split a region wherever whitespace runs all the way across it on one axis,
 * keeping the pieces in ascending order. */
function split(boxes: PageWordBox[], axis: 'x' | 'y', minGap: number): PageWordBox[][] {
	const size = axis === 'x' ? 'width' : 'height';
	const ordered = [...boxes].sort((left, right) => left[axis] - right[axis]);
	const groups: PageWordBox[][] = [];
	let group: PageWordBox[] = [];
	let reach = -Infinity;
	for (const box of ordered) {
		if (group.length && box[axis] - reach > minGap) {
			groups.push(group);
			group = [];
		}
		group.push(box);
		reach = Math.max(reach, box[axis] + box[size]);
	}
	if (group.length) groups.push(group);
	return groups;
}

/** The last word: rows of type, each read left to right. */
function byLine(boxes: PageWordBox[]): PageWordBox[] {
	const ordered = [...boxes].sort((left, right) => left.y - right.y || left.x - right.x);
	const lines: PageWordBox[][] = [];
	for (const box of ordered) {
		const current = lines[lines.length - 1];
		const previous = current?.[0];
		const sameLine =
			previous &&
			Math.abs(box.y + box.height / 2 - (previous.y + previous.height / 2)) <
				Math.max(box.height, previous.height) / 2;
		if (sameLine) current.push(box);
		else lines.push([box]);
	}
	return lines.flatMap((entries) => entries.sort((left, right) => left.x - right.x));
}

interface Chunk {
	key: string;
	start: number;
	end: number;
}

/** Whitespace-separated chunks with their character ranges, keyed for
 * comparison. Splitting on whitespace (not on letter runs) keeps both streams
 * tokenized the same way, so `don't` stays one token against the page's one
 * box for it. Chunks that key to nothing — a lone bullet, a stray dash — are
 * dropped: they carry no evidence and would only invite false matches. */
export function chunkText(text: string): Chunk[] {
	const chunks: Chunk[] = [];
	for (const match of text.matchAll(/\S+/gu)) {
		const start = match.index ?? 0;
		const key = matchKey(match[0]);
		if (key) chunks.push({ key, start, end: start + match[0].length });
	}
	return chunks;
}

/** Cheap enough to be exact for a page; the guard only exists so a pathological
 * page (a word list, a dense table) cannot lock the main thread. */
const MAX_ALIGNMENT_CELLS = 4_000_000;

const SCORE_MATCH = 1;
/** A hyphenated break leaves the page holding a fragment of the markdown's
 * word (`englishto` for `englishtogerman`). Scoring that as most of a match
 * keeps the alignment on the diagonal, where treating it as a mismatch would
 * derail it. */
const SCORE_PARTIAL = 0.5;
const SCORE_MISMATCH = -1;
/**
 * Skips are priced as one decision, not per word: opening a run of unmatched
 * words costs, continuing it barely does. This is what lets the two streams
 * survive each other's bulk. A page carries equations, axis labels and
 * running heads the spoken layer never says; the spoken layer carries whole
 * paragraphs the page never printed (a table's narration, "A table with
 * columns: …"). Charged per word, one such stretch would outweigh every match
 * after it and the alignment would simply stop there — which is exactly what
 * a flat gap penalty did: everything below Table 1 on a page went unplaced.
 *
 * Opening a gap also has to stay cheaper than a single match is worth, or the
 * free ends win instead: an alignment that starts late and matches three
 * words cleanly would outscore one that matches five with a skip in the
 * middle, and the two words before the skip would be dropped for no reason.
 */
const SCORE_GAP_OPEN = -0.6;
const SCORE_GAP_EXTEND = -0.02;

function pairScore(left: string, right: string): number {
	if (left === right) return SCORE_MATCH;
	if (left.length >= 4 && right.length >= 4 && (left.startsWith(right) || right.startsWith(left))) {
		return SCORE_PARTIAL;
	}
	return SCORE_MISMATCH;
}

/** Traceback states: a pair, an unmatched expected word, an unmatched page
 * word. */
const PAIRED = 0;
const EXPECTED_GAP = 1;
const PAGE_GAP = 2;

/**
 * Monotonic alignment of the expected words (the spoken layer's) against the
 * page's, returning the page index each expected word landed on, or -1.
 *
 * Gotoh's affine-gap alignment with both ends free. Free ends because neither
 * stream has to be consumed whole — the expected stream deliberately carries
 * a little of the neighbouring pages. Affine gaps because both streams are
 * full of material the other lacks, and skipping it has to stay cheap enough
 * that the alignment resumes afterwards (see the gap constants above).
 *
 * Only pairs that actually agree are reported: the path threads through
 * mismatches to stay on course, but a mismatch is not evidence of where a
 * word sits.
 */
export function alignWordStreams(pageKeys: string[], expectedKeys: string[]): Int32Array {
	const rows = expectedKeys.length;
	const columns = pageKeys.length;
	const result = new Int32Array(rows).fill(-1);
	if (!rows || !columns || (rows + 1) * (columns + 1) > MAX_ALIGNMENT_CELLS) return result;

	const width = columns + 1;
	// Scores roll row by row; only the traceback needs the whole grid.
	let pairedRow = new Float32Array(width);
	let expectedGapRow = new Float32Array(width);
	let pageGapRow = new Float32Array(width);
	let nextPaired = new Float32Array(width);
	let nextExpectedGap = new Float32Array(width);
	let nextPageGap = new Float32Array(width);
	// Which state each cell was reached from: for a pair, the predecessor
	// state; for a gap, whether it opened (0) or extended (1).
	const fromPaired = new Uint8Array((rows + 1) * width);
	const fromExpectedGap = new Uint8Array((rows + 1) * width);
	const fromPageGap = new Uint8Array((rows + 1) * width);

	let bestScore = 0;
	let bestRow = 0;
	let bestColumn = 0;
	let bestState = PAIRED;

	for (let row = 1; row <= rows; row += 1) {
		// Row 0 and column 0 stay at zero: an alignment may start anywhere in
		// either stream without paying for the prefix it skipped.
		nextPaired[0] = 0;
		nextExpectedGap[0] = 0;
		nextPageGap[0] = 0;
		const base = row * width;
		for (let column = 1; column <= columns; column += 1) {
			const previous = Math.max(
				pairedRow[column - 1],
				expectedGapRow[column - 1],
				pageGapRow[column - 1]
			);
			nextPaired[column] = previous + pairScore(expectedKeys[row - 1], pageKeys[column - 1]);
			fromPaired[base + column] =
				previous === pairedRow[column - 1]
					? PAIRED
					: previous === expectedGapRow[column - 1]
						? EXPECTED_GAP
						: PAGE_GAP;

			const openExpected = pairedRow[column] + SCORE_GAP_OPEN + SCORE_GAP_EXTEND;
			const extendExpected = expectedGapRow[column] + SCORE_GAP_EXTEND;
			nextExpectedGap[column] = Math.max(openExpected, extendExpected);
			fromExpectedGap[base + column] = extendExpected > openExpected ? 1 : 0;

			const openPage = nextPaired[column - 1] + SCORE_GAP_OPEN + SCORE_GAP_EXTEND;
			const extendPage = nextPageGap[column - 1] + SCORE_GAP_EXTEND;
			nextPageGap[column] = Math.max(openPage, extendPage);
			fromPageGap[base + column] = extendPage > openPage ? 1 : 0;

			// Ending is free as well, so the alignment stops at its best point on
			// either final edge rather than being dragged into the far corner.
			if ((row === rows || column === columns) && nextPaired[column] > bestScore) {
				bestScore = nextPaired[column];
				bestRow = row;
				bestColumn = column;
				bestState = PAIRED;
			}
		}
		[pairedRow, nextPaired] = [nextPaired, pairedRow];
		[expectedGapRow, nextExpectedGap] = [nextExpectedGap, expectedGapRow];
		[pageGapRow, nextPageGap] = [nextPageGap, pageGapRow];
	}

	let row = bestRow;
	let column = bestColumn;
	let state = bestState;
	while (row > 0 && column > 0) {
		const cell = row * width + column;
		if (state === PAIRED) {
			if (pairScore(expectedKeys[row - 1], pageKeys[column - 1]) > 0) {
				result[row - 1] = column - 1;
			}
			state = fromPaired[cell];
			row -= 1;
			column -= 1;
		} else if (state === EXPECTED_GAP) {
			state = fromExpectedGap[cell] === 1 ? EXPECTED_GAP : PAIRED;
			row -= 1;
		} else {
			state = fromPageGap[cell] === 1 ? PAGE_GAP : PAIRED;
			column -= 1;
		}
	}
	return result;
}

function unionRect(rects: PageRect[]): PageRect {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Collapse a passage's word boxes into one rectangle per line, in reading
 * order. Boxes join a run while they sit on the same line (vertical centres
 * within half a line height) and do not jump backwards across the page —
 * a backwards jump is a column break, which has to start a new rectangle or
 * the highlight would sweep across the gutter.
 */
export function mergeWordRects(boxes: PageRect[]): PageRect[] {
	const merged: PageRect[] = [];
	let run: PageRect[] = [];
	const flush = () => {
		if (run.length) merged.push(unionRect(run));
		run = [];
	};
	for (const box of boxes) {
		const previous = run[run.length - 1];
		if (previous) {
			const sameLine =
				Math.abs(box.y + box.height / 2 - (previous.y + previous.height / 2)) <
				Math.max(box.height, previous.height) / 2;
			if (!sameLine || box.x + box.width < previous.x) flush();
		}
		run.push(box);
	}
	flush();
	return merged;
}

/**
 * Below this, a placement is guesswork: a couple of stray words matched
 * somewhere on the page while the passage itself is elsewhere. Painting those
 * would put the highlight in the wrong place, which is worse than not
 * painting it. The refinement pass is allowed to be less strict, because by
 * then the passage is boxed in by its placed neighbours and cannot land far
 * from where it belongs.
 */
const MIN_COVERAGE = 0.35;
const MIN_REFINED_COVERAGE = 0.2;
/** One refinement of each unclaimed gap is enough in practice; the limit is
 * only here so a pathological page cannot recurse indefinitely. */
const MAX_REFINEMENT_DEPTH = 2;

interface ExpectedChunk extends Chunk {
	segment: number;
}

/**
 * Align a slice of the expected stream against a slice of the page, then look
 * at what went unplaced.
 *
 * A run of passages that all failed together usually failed for one reason:
 * the page renders them in a form the spoken layer rewrote — a table, whose
 * rows are narrated as "Layer Type: Self-Attention. Complexity per Layer: …"
 * against a page holding a grid of bare cells. Whole-page alignment cannot
 * find those rows among a thousand competing words, but the run is bracketed
 * by passages that *did* place, and the page words between those two brackets
 * are exactly the table. Aligning the run against that much smaller stretch
 * usually lands it.
 */
function assignRange(
	boxes: PageWordBox[],
	pageKeys: string[],
	expected: ExpectedChunk[],
	matches: Array<number[]>,
	range: { boxLow: number; boxHigh: number; chunkLow: number; chunkHigh: number },
	depth: number
): void {
	const { boxLow, boxHigh, chunkLow, chunkHigh } = range;
	if (boxLow > boxHigh || chunkLow > chunkHigh) return;
	const alignment = alignWordStreams(
		pageKeys.slice(boxLow, boxHigh + 1),
		expected.slice(chunkLow, chunkHigh + 1).map((chunk) => chunk.key)
	);
	for (let index = 0; index < alignment.length; index += 1) {
		const box = alignment[index];
		if (box >= 0) matches[chunkLow + index].push(boxLow + box);
	}

	const minimum = depth === 0 ? MIN_COVERAGE : MIN_REFINED_COVERAGE;
	// Which of the passages in this range came out placed, so the gaps between
	// them can be retried against the page they must lie on.
	const segmentLow = expected[chunkLow].segment;
	const segmentHigh = expected[chunkHigh].segment;
	const placed = new Map<number, { first: number; last: number }>();
	for (let segment = segmentLow; segment <= segmentHigh; segment += 1) {
		let total = 0;
		let first = Infinity;
		let last = -Infinity;
		for (let index = chunkLow; index <= chunkHigh; index += 1) {
			if (expected[index].segment !== segment) continue;
			total += 1;
			const box = matches[index][matches[index].length - 1];
			if (box === undefined) continue;
			first = Math.min(first, box);
			last = Math.max(last, box);
		}
		const covered = countMatched(expected, matches, chunkLow, chunkHigh, segment);
		if (total && covered / total >= minimum) placed.set(segment, { first, last });
	}
	if (depth >= MAX_REFINEMENT_DEPTH) return;

	let runStart: number | undefined;
	for (let segment = segmentLow; segment <= segmentHigh + 1; segment += 1) {
		if (segment <= segmentHigh && !placed.has(segment)) {
			runStart ??= segment;
			continue;
		}
		if (runStart === undefined) continue;
		const runEnd = segment - 1;
		const before = previousPlaced(placed, runStart - 1, segmentLow);
		const after = nextPlaced(placed, runEnd + 1, segmentHigh);
		const nextRange = {
			boxLow: before === undefined ? boxLow : before + 1,
			boxHigh: after === undefined ? boxHigh : after - 1,
			chunkLow: firstChunkOf(expected, chunkLow, chunkHigh, runStart),
			chunkHigh: lastChunkOf(expected, chunkLow, chunkHigh, runEnd)
		};
		runStart = undefined;
		// No narrowing happened: retrying the same range would only repeat this
		// pass's answer.
		if (
			nextRange.chunkLow === undefined ||
			nextRange.chunkHigh === undefined ||
			(nextRange.boxLow === boxLow && nextRange.boxHigh === boxHigh)
		) {
			continue;
		}
		assignRange(
			boxes,
			pageKeys,
			expected,
			matches,
			nextRange as { boxLow: number; boxHigh: number; chunkLow: number; chunkHigh: number },
			depth + 1
		);
	}
}

function countMatched(
	expected: ExpectedChunk[],
	matches: Array<number[]>,
	low: number,
	high: number,
	segment: number
): number {
	let count = 0;
	for (let index = low; index <= high; index += 1) {
		if (expected[index].segment === segment && matches[index].length) count += 1;
	}
	return count;
}

function previousPlaced(
	placed: Map<number, { first: number; last: number }>,
	from: number,
	low: number
): number | undefined {
	for (let segment = from; segment >= low; segment -= 1) {
		const entry = placed.get(segment);
		if (entry) return entry.last;
	}
	return undefined;
}

function nextPlaced(
	placed: Map<number, { first: number; last: number }>,
	from: number,
	high: number
): number | undefined {
	for (let segment = from; segment <= high; segment += 1) {
		const entry = placed.get(segment);
		if (entry) return entry.first;
	}
	return undefined;
}

function firstChunkOf(
	expected: ExpectedChunk[],
	low: number,
	high: number,
	segment: number
): number | undefined {
	for (let index = low; index <= high; index += 1) {
		if (expected[index].segment === segment) return index;
	}
	return undefined;
}

function lastChunkOf(
	expected: ExpectedChunk[],
	low: number,
	high: number,
	segment: number
): number | undefined {
	for (let index = high; index >= low; index -= 1) {
		if (expected[index].segment === segment) return index;
	}
	return undefined;
}

/**
 * Place every passage anchored to a page onto that page's words.
 *
 * `segments` should be given in document order and may include a little of the
 * neighbouring pages: a paragraph that starts on one page and finishes on the
 * next is one passage, and the alignment's free end gaps let the part that
 * belongs elsewhere go unmatched rather than dragging the rest off course.
 */
export function placeSegments(
	boxes: PageWordBox[],
	segments: PlaceableSegment[],
	page: number
): SegmentPlacement[] {
	const pageKeys = boxes.map((box) => matchKey(box.text));
	const expected: ExpectedChunk[] = [];
	segments.forEach((segment, index) => {
		for (const chunk of chunkText(segment.matchText ?? segment.text)) {
			expected.push({ ...chunk, segment: index });
		}
	});
	if (!expected.length || !pageKeys.length) return [];
	const matches: Array<number[]> = expected.map(() => []);
	assignRange(
		boxes,
		pageKeys,
		expected,
		matches,
		{ boxLow: 0, boxHigh: pageKeys.length - 1, chunkLow: 0, chunkHigh: expected.length - 1 },
		0
	);

	const placements: SegmentPlacement[] = [];
	segments.forEach((segment, index) => {
		const matched: Array<{ chunk: Chunk; box: PageWordBox }> = [];
		let total = 0;
		expected.forEach((chunk, chunkIndex) => {
			if (chunk.segment !== index) return;
			total += 1;
			// The last assignment wins: a refinement pass ran against a narrower
			// stretch of the page and knows better than the whole-page sweep.
			const box = matches[chunkIndex][matches[chunkIndex].length - 1];
			if (box !== undefined) matched.push({ chunk, box: boxes[box] });
		});
		const coverage = total ? matched.length / total : 0;
		if (!matched.length || coverage < MIN_REFINED_COVERAGE) return;
		matched.sort((left, right) => left.chunk.start - right.chunk.start);
		const wordRects = segment.matchText
			? segment.words.map(() => undefined)
			: segment.words.map((word) => {
					const overlapping = matched
						.filter(({ chunk }) => chunk.start < word.end && chunk.end > word.start)
						.map(({ box }) => box);
					return overlapping.length ? unionRect(overlapping) : undefined;
				});
		placements.push({
			segmentId: segment.id,
			page,
			rects: mergeWordRects(matched.map(({ box }) => box)),
			wordRects,
			coverage
		});
	});
	return placements;
}

/** How much of each neighbouring page's passages to align alongside a page's
 * own, in words. A paragraph that straddles a page break is one passage list
 * anchored to the earlier page, so the later page has to look back far enough
 * to find the sentences that actually landed on it. */
const SPILL_WORDS = 400;

/** The passages to align against one page: everything anchored to it, plus a
 * stretch of each neighbour so a paragraph straddling the page break is placed
 * from whichever side is looking.
 *
 * `blockText` (block id → block text) is what lets a narrated construct be
 * looked for as it appears on paper rather than as it is spoken: a segment's
 * `start`/`end` index its block's text, so that slice is the construct's own
 * source — a table row's cells, an equation's characters — while
 * `segment.text` is the reading. Without it, tables and equations simply go
 * unplaced.
 */
export function segmentsForPage(
	segments: SpeechSegment[],
	page: number,
	blockText?: ReadonlyMap<string, string>,
	spillWords = SPILL_WORDS
): PlaceableSegment[] {
	let first = -1;
	let last = -1;
	segments.forEach((segment, index) => {
		if (segment.anchor.page !== page) return;
		if (first < 0) first = index;
		last = index;
	});
	if (first < 0) return [];
	let from = first;
	for (let budget = spillWords; from > 0 && budget > 0; from -= 1) {
		budget -= segments[from - 1].words.length;
	}
	let to = last;
	for (let budget = spillWords; to < segments.length - 1 && budget > 0; to += 1) {
		budget -= segments[to + 1].words.length;
	}
	const placeable: PlaceableSegment[] = [];
	for (let index = from; index <= to; index += 1) {
		const segment = segments[index];
		const source = blockText?.get(segment.blockId)?.slice(segment.start, segment.end);
		placeable.push({
			id: segment.id,
			text: segment.text,
			words: segment.words,
			page: segment.anchor.page ?? page,
			...(source && source !== segment.text ? { matchText: source } : {})
		});
	}
	return placeable;
}
