import type { WordSpan } from './types';

/** Absolute URLs, www-prefixed ones, and bare domains with a path are all
 * letter soup when spoken — point the listener at the document instead.
 * Bare domains without a path stay ("Node.js", "vite.config.ts" and short
 * mentions like "example.com" are readable and must not be swallowed). */
export const LINK_PATTERN =
	/(?:https?:\/\/|www\.)[^\s<>()]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\/[^\s<>()]*/gi;

const LINK_TRAILER_PATTERN = /[.,;:!?'"\]]+$/;

export const LINK_SPOKEN_TEXT = 'a link in the document';

export function normalizeForSpeech(text: string): string {
	return text
		.replace(LINK_PATTERN, (url) => {
			const trailer = LINK_TRAILER_PATTERN.exec(url)?.[0] ?? '';
			return `${LINK_SPOKEN_TEXT}${trailer}`;
		})
		.replace(/\s+/g, ' ')
		.trim();
}

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

/** One span per SPOKEN word of `normalizeForSpeech(text)`, each carrying the
 * display range it should light up. Plain words map to themselves; every word
 * of a link's spoken replacement maps to the whole link, mirroring how inline
 * construct substitution keeps an equation highlighted while its reading is
 * spoken. Invariant: the result aligns index-for-index with
 * `wordsFor(normalizeForSpeech(text))`. */
export function spokenWordSpans(text: string): WordSpan[] {
	const spans: WordSpan[] = [];
	let cursor = 0;
	for (const match of text.matchAll(LINK_PATTERN)) {
		const start = match.index ?? 0;
		const url = match[0];
		const trailer = LINK_TRAILER_PATTERN.exec(url)?.[0] ?? '';
		const linkEnd = start + url.length - trailer.length;
		for (const word of wordsFor(text.slice(cursor, start))) {
			spans.push({ text: word.text, start: cursor + word.start, end: cursor + word.end });
		}
		for (const word of wordsFor(LINK_SPOKEN_TEXT)) {
			spans.push({ text: word.text, start, end: linkEnd });
		}
		cursor = start + url.length;
	}
	for (const word of wordsFor(text.slice(cursor))) {
		spans.push({ text: word.text, start: cursor + word.start, end: cursor + word.end });
	}
	return spans;
}
