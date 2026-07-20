import type { WordSpan } from './types';
import { LINK_PATTERN, LINK_SPOKEN_TEXT, wordsFor } from './speech-words';

/**
 * The spoken layer: what a document SOUNDS like, kept separate from what it
 * shows. A human narrator doesn't voice "[2]", spell out "Fig.", or read a
 * URL letter by letter — so an ordered set of rules rewrites the spoken form
 * of a sentence while the displayed text stays untouched.
 *
 * The load-bearing invariant (see speech-words.ts): word highlighting couples
 * display words to synthesized timing entries BY INDEX. Both the spoken string
 * and the per-word display spans are therefore produced from ONE pass here, so
 * they always agree: `applySpokenStyle(t).spans` aligns index-for-index with
 * `wordsFor(applySpokenStyle(t).spoken)`. A rule that ELIDES text contributes
 * no spoken words (its display characters simply never highlight); a rule that
 * EXPANDS text maps every spoken word of the replacement onto the whole
 * matched display range (so "Fig." stays lit while "Figure" is spoken).
 */
export interface SpokenRule {
	readonly name: string;
	/** Must be a global (`g`) regex. */
	readonly pattern: RegExp;
	/** Spoken form for a match; an empty string elides it from speech. */
	readonly replace: (match: RegExpExecArray) => string;
}

export interface SpokenStyle {
	spoken: string;
	spans: WordSpan[];
}

const LINK_TRAILER_PATTERN = /[.,;:!?'"\]]+$/;

/** URLs become a single readable phrase (unchanged behavior). */
const urlRule: SpokenRule = {
	name: 'url',
	pattern: LINK_PATTERN,
	replace: (match) => {
		const trailer = LINK_TRAILER_PATTERN.exec(match[0])?.[0] ?? '';
		return `${LINK_SPOKEN_TEXT}${trailer}`;
	}
};

/** Numeric reference markers: "[2]", "[3, 5]", "[12-15]", and runs like
 * "[1][2]" — voiced by nobody, elided from speech. */
const bracketCitationRule: SpokenRule = {
	name: 'bracket-citation',
	pattern: /\[\s*\d+(?:\s*[–—,;-]\s*\d+)*\s*\]/g,
	replace: () => ''
};

/** Superscript footnote markers attached to a word ("word²"). */
const superscriptFootnoteRule: SpokenRule = {
	name: 'superscript-footnote',
	pattern: /(?<=\p{L})[¹²³⁰-⁹]+/gu,
	replace: () => ''
};

/**
 * Author–year citations, conservatively. The tell that separates a citation
 * from prose that merely mentions a year is the "Author, Year" comma (or an
 * "et al." right before the year): "(Vaswani et al., 2017)" and "(Smith,
 * 2019)" match, while "(In 2020 we found)" and "(n = 30)" do not. Must open
 * with a capitalized token so a lone "(2020)" measurement is left alone.
 */
const parentheticalCitationRule: SpokenRule = {
	name: 'parenthetical-citation',
	pattern:
		/\((?:see\s+)?\p{Lu}[^()]*?(?:,\s*|\bet al\.?\s+)(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*[^()]*?(?:,\s*|\bet al\.?\s+)?(?:19|20)\d{2}[a-z]?)*\)/gu,
	replace: () => ''
};

const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bet al\.?/gi, 'and colleagues'],
	[/\be\.g\.,?/gi, 'for example,'],
	[/\bi\.e\.,?/gi, 'that is,'],
	[/\betc\./gi, 'and so on'],
	[/\bcf\./gi, 'compare'],
	[/\bvs\.?/gi, 'versus'],
	[/\bapprox\./gi, 'approximately'],
	[/\bFigs?\./g, 'Figure'],
	[/\bEqs?\./g, 'Equation'],
	[/\bRefs?\./g, 'Reference'],
	[/\bSec\./g, 'Section'],
	[/\bCh\./g, 'Chapter'],
	[/§\s*/g, 'Section '],
	[/\bpp?\.\s*(?=\d)/gi, 'page '],
	[/\bNo\.\s*(?=\d)/g, 'number '],
	[/\bChap\./g, 'Chapter']
];

const abbreviationRules: SpokenRule[] = ABBREVIATIONS.map(([pattern, replacement], index) => ({
	name: `abbrev-${index}`,
	pattern,
	replace: () => replacement
}));

/**
 * "12–15" or "12-15" → "12 to 15", for short numbers only. The negative
 * look-behind and bounded digit counts keep it away from years ("2020-2021"),
 * phone numbers ("555-1234"), and identifiers ("ISO 8601-2").
 */
const numberRangeRule: SpokenRule = {
	name: 'number-range',
	pattern: /(?<![\d.])(\d{1,3})\s*[-–—]\s*(?=\d{1,3}(?![\d])(?!\.\d))/g,
	replace: (match) => `${match[1]} to `
};

const symbolRules: SpokenRule[] = [
	{ name: 'percent', pattern: /(\d+(?:\.\d+)?)\s*%/g, replace: (m) => `${m[1]} percent` },
	{ name: 'plus-minus', pattern: /±\s*/g, replace: () => 'plus or minus ' },
	{ name: 'approx-tilde', pattern: /~\s*(?=\d)/g, replace: () => 'approximately ' }
];

/**
 * Navigational asides a focused listener does not need: cross-references
 * ("(see Section 3)", "(cf. Smith)") and pointer parentheticals ("(Fig. 3)",
 * "(Table 2)", "(Appendix A)"). Focused mode only — Natural keeps them.
 */
const crossReferenceRule: SpokenRule = {
	name: 'cross-reference',
	pattern:
		/\((?:see|cf\.?|e\.g\.,?|i\.e\.,?)[^()]*\)|\((?:fig(?:ure|s)?|tables?|tab|eqs?|equations?|sec(?:tion|s)?|appendix|appendices|chapters?|ch)\.?\s*[\dA-Za-z]+(?:\s*[–-]\s*[\dA-Za-z]+)?\)/gi,
	replace: () => ''
};

/** Verbatim mode reads the page literally — only URLs still collapse to a
 * spoken pointer, exactly as they did before the spoken layer existed. */
export const VERBATIM_SPOKEN_RULES: SpokenRule[] = [urlRule];

/**
 * Natural mode, in priority order — earlier rules win when two matches
 * overlap. Citations drop, abbreviations and symbols read as words.
 */
export const NATURAL_SPOKEN_RULES: SpokenRule[] = [
	urlRule,
	bracketCitationRule,
	superscriptFootnoteRule,
	parentheticalCitationRule,
	...abbreviationRules,
	numberRangeRule,
	...symbolRules
];

/** Focused mode: Natural plus cross-reference/pointer elision. */
export const FOCUSED_SPOKEN_RULES: SpokenRule[] = [crossReferenceRule, ...NATURAL_SPOKEN_RULES];

/** The default rule set applied when a caller does not choose one. */
export const DEFAULT_SPOKEN_RULES = NATURAL_SPOKEN_RULES;

interface Hit {
	start: number;
	end: number;
	priority: number;
	spoken: string;
}

function collectHits(text: string, rules: SpokenRule[]): Hit[] {
	const hits: Hit[] = [];
	rules.forEach((rule, priority) => {
		rule.pattern.lastIndex = 0;
		for (const match of text.matchAll(rule.pattern)) {
			const start = match.index ?? 0;
			hits.push({ start, end: start + match[0].length, priority, spoken: rule.replace(match) });
		}
	});
	// Earliest match wins; ties break by rule priority. Then drop any hit that
	// overlaps one already accepted, so replacements never collide.
	hits.sort((a, b) => a.start - b.start || a.priority - b.priority);
	const accepted: Hit[] = [];
	let guard = -1;
	for (const hit of hits) {
		if (hit.start < guard) continue;
		accepted.push(hit);
		guard = hit.end;
	}
	return accepted;
}

/**
 * Rewrite a sentence's spoken form and return the display-mapped word spans.
 * Replacements are padded with spaces so concatenation never fuses or splits a
 * word; the spoken string is whitespace-collapsed at the end. Spans point into
 * `text` (the caller offsets them into the block).
 */
export function applySpokenStyle(
	text: string,
	rules: SpokenRule[] = DEFAULT_SPOKEN_RULES
): SpokenStyle {
	const hits = collectHits(text, rules);
	if (!hits.length) {
		// No rewrite: spoken form is just the whitespace-collapsed text, and
		// each word maps to itself (offsets into the original text).
		return { spoken: text.replace(/\s+/g, ' ').trim(), spans: wordsFor(text) };
	}
	let spoken = '';
	const spans: WordSpan[] = [];
	let cursor = 0;
	for (const hit of hits) {
		const gap = text.slice(cursor, hit.start);
		for (const word of wordsFor(gap)) {
			spans.push({ text: word.text, start: cursor + word.start, end: cursor + word.end });
		}
		spoken += gap;
		// A space on each side keeps "Fig.2" → "Figure 2" and elisions from
		// gluing neighbors; the final collapse tidies the extra whitespace.
		spoken += ` ${hit.spoken} `;
		for (const word of wordsFor(hit.spoken)) {
			spans.push({ text: word.text, start: hit.start, end: hit.end });
		}
		cursor = hit.end;
	}
	const tail = text.slice(cursor);
	for (const word of wordsFor(tail)) {
		spans.push({ text: word.text, start: cursor + word.start, end: cursor + word.end });
	}
	spoken += tail;
	// Collapse the padding whitespace and pull sentence punctuation back
	// against its word ("work ." → "work."). Punctuation is not word-like, so
	// the token count — and thus the span alignment — is unchanged.
	const cleaned = spoken
		.replace(/\s+/g, ' ')
		.replace(/\s+([.,;:!?])/g, '$1')
		.trim();
	return { spoken: cleaned, spans };
}

/** The spoken form of a sentence (backward-compatible entry point). */
export function normalizeForSpeech(text: string): string {
	return applySpokenStyle(text).spoken;
}

/** One span per spoken word, each carrying the display range it lights up. */
export function spokenWordSpans(text: string): WordSpan[] {
	return applySpokenStyle(text).spans;
}
