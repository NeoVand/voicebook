import type {
	DocumentBlock,
	NarrationConstructKind,
	NarrationEntry,
	NormalizedDocument,
	SpeechSegment,
	WordSpan
} from './types';
import {
	inlineConstructSpans,
	inlineMathFallback,
	mathBlockFallback,
	mermaidFallback,
	tableHeaderFallback,
	tableRowFallback,
	tableRowRanges,
	type InlineConstructSpan,
	type TextRange
} from './narration';

export const MAX_SEGMENT_CHARS = 280;

export function normalizeForSpeech(text: string): string {
	return text
		.replace(/https?:\/\/\S+/gi, (url) => {
			try {
				return new URL(url).hostname.replace(/^www\./, '');
			} catch {
				return 'link';
			}
		})
		.replace(/\s+/g, ' ')
		.trim();
}

function sentenceParts(text: string): Array<{ text: string; index: number }> {
	if (typeof Intl.Segmenter === 'function') {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
		return Array.from(segmenter.segment(text), ({ segment, index }) => ({ text: segment, index }));
	}

	const parts: Array<{ text: string; index: number }> = [];
	const pattern = /[^.!?]+(?:[.!?]+|$)/g;
	for (const match of text.matchAll(pattern)) {
		parts.push({ text: match[0], index: match.index ?? 0 });
	}
	return parts;
}

function splitLongSentence(
	text: string,
	absoluteStart: number
): Array<{ text: string; index: number }> {
	if (text.length <= MAX_SEGMENT_CHARS) return [{ text, index: absoluteStart }];
	const output: Array<{ text: string; index: number }> = [];
	let cursor = 0;

	while (cursor < text.length) {
		let end = Math.min(cursor + MAX_SEGMENT_CHARS, text.length);
		if (end < text.length) {
			const candidate = text.slice(cursor, end);
			const breakAt = Math.max(
				candidate.lastIndexOf('; '),
				candidate.lastIndexOf(', '),
				candidate.lastIndexOf(' — ')
			);
			if (breakAt > MAX_SEGMENT_CHARS * 0.55) end = cursor + breakAt + 1;
		}
		const piece = text.slice(cursor, end);
		output.push({ text: piece, index: absoluteStart + cursor });
		cursor = end;
	}
	return output;
}

export function wordsFor(text: string): WordSpan[] {
	if (typeof Intl.Segmenter === 'function') {
		const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
		return Array.from(segmenter.segment(text))
			.filter((part) => part.isWordLike)
			.map((part) => ({
				text: part.segment,
				start: part.index,
				end: part.index + part.segment.length
			}));
	}
	return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu), (match) => ({
		text: match[0],
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length
	}));
}

export function estimateDuration(text: string): number {
	const wordCount = Math.max(wordsFor(text).length, 1);
	const punctuationPause =
		(text.match(/[,;:]/g)?.length ?? 0) * 0.12 + (text.match(/[.!?]/g)?.length ?? 0) * 0.24;
	return Math.max(0.7, wordCount / 2.65 + punctuationPause);
}

/** Narration/fallback text resolution for one construct. */
function spokenFor(
	entry: NarrationEntry | undefined,
	fallback: string
): { text: string; pending: boolean } {
	if (entry?.status === 'ready' && entry.text?.trim()) {
		return { text: entry.text.trim(), pending: false };
	}
	return { text: fallback, pending: entry?.status === 'pending' };
}

/** Narration text stays one segment when it fits; longer narrations pack
 * whole sentences greedily into MAX_SEGMENT_CHARS chunks. */
function narrationChunks(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= MAX_SEGMENT_CHARS) return [trimmed];
	const chunks: string[] = [];
	let current = '';
	const flush = () => {
		if (current.trim()) chunks.push(current.trim());
		current = '';
	};
	for (const part of sentenceParts(trimmed)) {
		for (const piece of splitLongSentence(part.text, part.index)) {
			const sentence = piece.text.trim();
			if (!sentence) continue;
			if (current && current.length + sentence.length + 1 > MAX_SEGMENT_CHARS) flush();
			current = current ? `${current} ${sentence}` : sentence;
		}
	}
	flush();
	return chunks;
}

/** Emit the `${constructId}:n${k}` segments for one narrated construct,
 * subdividing the construct's character range so position remapping stays
 * monotonic within the block. */
function pushConstructSegments(
	segments: SpeechSegment[],
	block: DocumentBlock,
	constructId: string,
	constructKind: NarrationConstructKind,
	spoken: string,
	pending: boolean,
	range: TextRange
): void {
	const chunks = narrationChunks(spoken);
	if (!chunks.length) return;
	const span = range.end - range.start;
	chunks.forEach((chunk, index) => {
		const start = range.start + Math.floor((span * index) / chunks.length);
		const end =
			index === chunks.length - 1
				? range.end
				: range.start + Math.floor((span * (index + 1)) / chunks.length);
		segments.push({
			id: `${constructId}:n${index}`,
			blockId: block.id,
			text: chunk,
			normalizedText: normalizeForSpeech(chunk),
			start,
			end,
			words: wordsFor(chunk),
			estimatedDuration: estimateDuration(chunk),
			anchor: {
				...block.anchor,
				start: (block.anchor.start ?? 0) + start,
				end: (block.anchor.start ?? 0) + end
			},
			narration: { constructIds: [constructId], kind: 'construct', constructKind, pending }
		});
	});
}

/** The replacement spoken for an inline construct span. */
function inlineReplacement(
	span: InlineConstructSpan,
	narrations: Record<string, NarrationEntry>
): { text: string; pending: boolean; hasEntry: boolean } {
	const entry = span.eligible ? narrations[span.id] : undefined;
	if (entry?.status === 'ready' && entry.text?.trim()) {
		return { text: entry.text.trim(), pending: false, hasEntry: true };
	}
	const fallback = span.kind === 'math-inline' ? inlineMathFallback(span.run.text) : span.run.text;
	return { text: fallback, pending: entry?.status === 'pending', hasEntry: Boolean(entry) };
}

export function segmentBlocks(
	blocks: DocumentBlock[],
	includeCode = false,
	narrations: Record<string, NarrationEntry> = {}
): SpeechSegment[] {
	const segments: SpeechSegment[] = [];

	for (const block of blocks) {
		// Narrated constructs first — math and mermaid blocks are not speakable
		// as source, but their narration (or deterministic fallback) is.
		if (block.kind === 'math' || block.kind === 'mermaid') {
			const fallback =
				block.kind === 'math' ? mathBlockFallback(block.text) : mermaidFallback(block.text);
			const { text, pending } = spokenFor(narrations[block.id], fallback);
			pushConstructSegments(
				segments,
				block,
				block.id,
				block.kind === 'math' ? 'math-block' : 'mermaid',
				text,
				pending,
				{ start: 0, end: block.text.length }
			);
			continue;
		}

		// Tables: a deterministic header announcement plus one narrated segment
		// group per row, each anchored to the row's range in the flattened text.
		if (block.kind === 'table' && block.table) {
			const ranges = tableRowRanges(block.text, block.table);
			const header = block.table.header.map((cell) => cell.text);
			// The header announcement is deterministic (never sent to the LLM),
			// but a manually edited description still overrides it.
			const headerSpoken = spokenFor(narrations[`${block.id}:rh`], tableHeaderFallback(header));
			pushConstructSegments(
				segments,
				block,
				`${block.id}:rh`,
				'table-header',
				headerSpoken.text,
				false,
				ranges.header ?? { start: 0, end: 0 }
			);
			block.table.rows.forEach((row, rowIndex) => {
				const cells = row.map((cell) => cell.text);
				const fallback = tableRowFallback(header, cells);
				const { text, pending } = spokenFor(narrations[`${block.id}:r${rowIndex}`], fallback);
				if (!text) return;
				pushConstructSegments(
					segments,
					block,
					`${block.id}:r${rowIndex}`,
					'table-row',
					text,
					pending,
					ranges.rows[rowIndex] ?? { start: block.text.length, end: block.text.length }
				);
			});
			continue;
		}

		if ((!block.speak && block.kind !== 'code') || (block.kind === 'code' && !includeCode))
			continue;

		const spans = inlineConstructSpans(block);
		let blockSegmentIndex = 0;
		const sourceParts =
			block.kind === 'heading' || block.kind === 'list-item'
				? [{ text: block.text, index: 0 }]
				: sentenceParts(block.text);

		for (const part of sourceParts) {
			for (const piece of splitLongSentence(part.text, part.index)) {
				const leading = piece.text.length - piece.text.trimStart().length;
				const text = piece.text.trim();
				if (!text) continue;
				const start = piece.index + leading;
				const end = start + text.length;
				const id = `${block.id}:s${blockSegmentIndex++}`;

				// Substitute inline math/image runs with their narration or
				// fallback in the SPOKEN text only; the displayed slice, ids and
				// offsets stay exactly as before so positions remain stable.
				const overlapping = spans.filter((span) => span.start < end && span.end > start);
				let speech = text;
				let pending = false;
				const constructIds: string[] = [];
				if (overlapping.length) {
					let rendered = '';
					let cursor = start;
					for (const span of overlapping) {
						const from = Math.max(span.start, start);
						const to = Math.min(span.end, end);
						rendered += block.text.slice(cursor, from);
						if (span.start >= start) {
							const replacement = inlineReplacement(span, narrations);
							rendered += replacement.text;
							pending ||= replacement.pending;
							// A span only makes this a narration segment when it
							// actually changes the spoken text or an LLM rewrite
							// exists/is expected for it — a short readable E=mc^2
							// keeps plain word-highlighted treatment.
							if (replacement.hasEntry || replacement.text !== block.text.slice(from, to)) {
								constructIds.push(span.id);
							}
						}
						cursor = to;
					}
					rendered += block.text.slice(cursor, end);
					speech = rendered;
				}
				const substituted = speech !== text || constructIds.length > 0;

				segments.push({
					id,
					blockId: block.id,
					text,
					normalizedText: normalizeForSpeech(speech),
					start,
					end,
					// Word-level highlighting needs displayed text === spoken text;
					// substituted sentences highlight at the sentence level instead.
					words: substituted ? [] : wordsFor(text),
					estimatedDuration: estimateDuration(speech),
					anchor: {
						...block.anchor,
						start: (block.anchor.start ?? 0) + start,
						end: (block.anchor.start ?? 0) + start + text.length
					},
					...(substituted ? { narration: { constructIds, kind: 'inline' as const, pending } } : {})
				});
			}
		}
	}

	return segments;
}

export function segmentsEqual(a: SpeechSegment[], b: SpeechSegment[]): boolean {
	if (a.length !== b.length) return false;
	return a.every(
		(segment, index) =>
			segment.id === b[index].id &&
			segment.normalizedText === b[index].normalizedText &&
			(segment.narration?.pending ?? false) === (b[index].narration?.pending ?? false)
	);
}

function semanticPosition(
	segments: SpeechSegment[],
	segmentId: string,
	wordIndex: number
): { blockId: string; offset: number } | undefined {
	const segment = segments.find((candidate) => candidate.id === segmentId);
	if (!segment) return undefined;
	return {
		blockId: segment.blockId,
		offset: segment.start + (segment.words[wordIndex]?.start ?? 0)
	};
}

function remapPosition(
	segments: SpeechSegment[],
	position: { blockId: string; offset: number }
): { segment: SpeechSegment; wordIndex: number } | undefined {
	const blockSegments = segments.filter((segment) => segment.blockId === position.blockId);
	const segment =
		blockSegments.find(
			(candidate) => position.offset >= candidate.start && position.offset <= candidate.end
		) ?? blockSegments.at(-1);
	if (!segment) return undefined;
	const wordIndex = Math.max(
		0,
		segment.words.findLastIndex((word) => segment.start + word.start <= position.offset)
	);
	return { segment, wordIndex };
}

export function refreshDocumentSegments(document: NormalizedDocument): NormalizedDocument {
	const previousSegments = document.segments;
	const segments = segmentBlocks(document.blocks, document.includeCode, document.narrations ?? {});
	if (segmentsEqual(previousSegments, segments)) return document;
	const playbackPosition = document.playback
		? semanticPosition(previousSegments, document.playback.segmentId, document.playback.wordIndex)
		: undefined;
	const playbackTarget = playbackPosition ? remapPosition(segments, playbackPosition) : undefined;
	return {
		...document,
		segments,
		playback:
			document.playback && playbackTarget
				? {
						...document.playback,
						segmentId: playbackTarget.segment.id,
						wordIndex: playbackTarget.wordIndex,
						offset:
							(playbackTarget.segment.estimatedDuration * playbackTarget.wordIndex) /
							Math.max(1, playbackTarget.segment.words.length)
					}
				: document.playback,
		bookmarks: document.bookmarks.map((bookmark) => {
			const position = semanticPosition(previousSegments, bookmark.segmentId, bookmark.wordIndex);
			const target = position ? remapPosition(segments, position) : undefined;
			return target
				? { ...bookmark, segmentId: target.segment.id, wordIndex: target.wordIndex }
				: bookmark;
		})
	};
}
