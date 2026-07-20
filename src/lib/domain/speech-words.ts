import type { WordSpan } from './types';

/** Absolute URLs, www-prefixed ones, and bare domains with a path are all
 * letter soup when spoken — point the listener at the document instead.
 * Bare domains without a path stay ("Node.js", "vite.config.ts" and short
 * mentions like "example.com" are readable and must not be swallowed). */
export const LINK_PATTERN =
	/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\/[^\s<>()]*/gi;

export const LINK_SPOKEN_TEXT = 'a link in the document';

/** The one word tokenizer. Word highlighting couples display words to
 * synthesized timing entries BY INDEX, so every producer of a word list —
 * the segmenter's display spans, the worker's estimated timing, and the
 * ElevenLabs alignment grouping — must tokenize identically or highlights
 * drift for the rest of the segment. */
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
