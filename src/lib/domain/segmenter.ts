import type { DocumentBlock, NormalizedDocument, SpeechSegment, WordSpan } from './types';

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

export function segmentBlocks(blocks: DocumentBlock[], includeCode = false): SpeechSegment[] {
	const segments: SpeechSegment[] = [];

	for (const block of blocks) {
		if ((!block.speak && block.kind !== 'code') || (block.kind === 'code' && !includeCode))
			continue;
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
				segments.push({
					id: `${block.id}:s${blockSegmentIndex++}`,
					blockId: block.id,
					text,
					normalizedText: normalizeForSpeech(text),
					start,
					end: start + text.length,
					words: wordsFor(text),
					estimatedDuration: estimateDuration(text),
					anchor: { ...block.anchor, start, end: start + text.length }
				});
			}
		}
	}

	return segments;
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
	if (document.segments.every((segment) => segment.normalizedText.length <= MAX_SEGMENT_CHARS))
		return document;
	const previousSegments = document.segments;
	const segments = segmentBlocks(document.blocks, document.includeCode);
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
