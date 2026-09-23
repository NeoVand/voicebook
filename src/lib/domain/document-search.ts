/**
 * Keyword search over a document for the assistant's search_document tool:
 * BM25 over blocks, so a hit lands on a paragraph, equation, table, or
 * heading with its ⟦n⟧ passage markers. Spoken text is indexed for every
 * block — an equation is found by the words its narration uses — and tables
 * and code add their source, whose cells and identifiers are real words.
 * Local and instant: no model call, no network.
 */
import { tableMarkdown } from './narration';
import type { DocumentBlock, NormalizedDocument, SpeechSegment } from './types';

export interface SearchHit {
	blockId: string;
	/** Inclusive passage range of the block, as ⟦n⟧ markers. */
	start: number;
	end: number;
	score: number;
	/** The best-matching passage, clipped around the first match. */
	snippet: string;
	/** The passage the snippet comes from. */
	snippetSegment: number;
}

const STOPWORDS = new Set(
	(
		'a an and are as at be been but by can could did do does for from had has have how i if in ' +
		'into is it its may me more most my no not of on or our she so some such than that the their ' +
		'them then there these they this those to too us was we were what when where which while who ' +
		'why will with would you your about also any each just like only other over same very'
	).split(' ')
);

/** Suffixes stripped for matching, longest first, with what replaces them. */
const SUFFIXES: Array<[suffix: string, replacement: string]> = [
	['ations', ''],
	['ation', ''],
	['ating', ''],
	['ated', ''],
	['ates', ''],
	['ate', ''],
	['ings', ''],
	['ing', ''],
	['ied', 'y'],
	['ies', 'y'],
	['ers', ''],
	['er', ''],
	['ed', ''],
	['es', ''],
	['s', ''],
	['e', '']
];
const UNDOUBLE = new Set(['ings', 'ing', 'ers', 'er', 'ed']);

/**
 * A light English stemmer — enough that "migrate", "migrating", and
 * "migration" meet, as they must when a spoken question paraphrases the
 * text. It runs alike on the document and the query, so where it errs it
 * errs on both sides.
 */
export function stem(word: string): string {
	if (/\d/.test(word)) return word;
	for (const [suffix, replacement] of SUFFIXES) {
		if (!word.endsWith(suffix)) continue;
		let base = word.slice(0, -suffix.length);
		if (base.length < 3 || !/[aeiouy]/.test(base)) continue;
		// glass, virus, analysis — and breed, need.
		if (suffix === 's' && /[siu]$/.test(base)) continue;
		if (suffix === 'ed' && base.endsWith('e')) continue;
		// running → run, stopped → stop; fall and miss keep their pair.
		if (UNDOUBLE.has(suffix) && /([^aeiouylsz])\1$/.test(base)) base = base.slice(0, -1);
		return base + replacement;
	}
	return word;
}

function fold(word: string): string {
	return word.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** Content words in order: folded, stopwords out, stemmed. */
export function searchTokens(text: string): string[] {
	const tokens: string[] = [];
	for (const [raw] of text.matchAll(WORD)) {
		const word = fold(raw);
		if (word.length > 1 && !STOPWORDS.has(word)) tokens.push(stem(word));
	}
	return tokens;
}

interface IndexedBlock {
	block: DocumentBlock | undefined;
	blockId: string;
	segments: number[];
	terms: Map<string, number>;
	length: number;
	/** References and notes: still findable, but ranked below the body. */
	backMatter: boolean;
}

interface SearchIndex {
	blocks: IndexedBlock[];
	documentFrequency: Map<string, number>;
	averageLength: number;
}

/** Keyed by the segment array: a rebind replaces it, which is exactly when
 * the index goes stale. */
const indexes = new WeakMap<SpeechSegment[], SearchIndex>();

function searchText(doc: NormalizedDocument, block: DocumentBlock | undefined, segments: number[]) {
	const text = segments.map((index) => doc.segments[index].text).join(' ');
	if (block?.table) return `${text} ${tableMarkdown(block.table)}`;
	if (block?.kind === 'code') return `${text} ${block.text}`;
	return text;
}

function buildIndex(doc: NormalizedDocument): SearchIndex {
	const blockById = new Map(doc.blocks.map((block) => [block.id, block]));
	const grouped = new Map<string, number[]>();
	doc.segments.forEach((segment, index) => {
		const list = grouped.get(segment.blockId);
		if (list) list.push(index);
		else grouped.set(segment.blockId, [index]);
	});
	const blocks: IndexedBlock[] = [];
	const documentFrequency = new Map<string, number>();
	let totalLength = 0;
	for (const [blockId, segments] of grouped) {
		const block = blockById.get(blockId);
		const words = searchTokens(searchText(doc, block, segments));
		if (!words.length) continue;
		// Headings name what a section is about: count their words twice.
		if (block?.kind === 'heading') words.push(...words);
		const terms = new Map<string, number>();
		for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
		for (const term of terms.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
		blocks.push({
			block,
			blockId,
			segments,
			terms,
			length: words.length,
			backMatter: segments.every((index) => doc.segments[index].role === 'back-matter')
		});
		totalLength += words.length;
	}
	return {
		blocks,
		documentFrequency,
		averageLength: blocks.length ? totalLength / blocks.length : 0
	};
}

/** The passage clipped to `limit` characters around its first matching word. */
function clipAround(text: string, terms: Set<string>, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (flat.length <= limit) return flat;
	let hit = 0;
	for (const match of flat.matchAll(WORD)) {
		if (terms.has(stem(fold(match[0])))) {
			hit = match.index;
			break;
		}
	}
	const from = Math.max(0, hit - Math.floor(limit / 3));
	const piece = flat.slice(from, from + limit);
	return `${from > 0 ? '…' : ''}${piece}${from + limit < flat.length ? '…' : ''}`;
}

const K1 = 1.2;
const B = 0.75;
/** A block holding every adjacent pair of query words side by side — the
 * query as a phrase, stopwords aside — scores half again; some pairs, less. */
const PHRASE_BONUS = 0.5;
const BACK_MATTER_WEIGHT = 0.5;
/** Best BM25 blocks re-read for the phrase bonus. */
const RERANK_POOL = 30;
const SNIPPET_CHARS = 240;

/** The best-matching blocks for a query, highest score first. */
export function searchDocument(doc: NormalizedDocument, query: string, limit = 6): SearchHit[] {
	const queryTokens = searchTokens(query);
	const terms = new Set(queryTokens);
	if (!terms.size) return [];
	let index = indexes.get(doc.segments);
	if (!index) {
		index = buildIndex(doc);
		indexes.set(doc.segments, index);
	}
	const total = index.blocks.length;
	const scored: Array<{ block: IndexedBlock; score: number }> = [];
	for (const block of index.blocks) {
		let score = 0;
		for (const term of terms) {
			const frequency = block.terms.get(term);
			if (!frequency) continue;
			const documents = index.documentFrequency.get(term) ?? 0;
			const idf = Math.log(1 + (total - documents + 0.5) / (documents + 0.5));
			const norm = 1 - B + (B * block.length) / (index.averageLength || 1);
			score += (idf * frequency * (K1 + 1)) / (frequency + K1 * norm);
		}
		if (score) scored.push({ block, score: block.backMatter ? score * BACK_MATTER_WEIGHT : score });
	}
	scored.sort((a, b) => b.score - a.score);
	const pool = scored.slice(0, Math.max(limit * 5, RERANK_POOL));
	const pairs = new Set<string>();
	for (let at = 1; at < queryTokens.length; at += 1) {
		pairs.add(`${queryTokens[at - 1]} ${queryTokens[at]}`);
	}
	if (pairs.size) {
		for (const item of pool) {
			const tokens = searchTokens(searchText(doc, item.block.block, item.block.segments));
			const found = new Set<string>();
			for (let at = 1; at < tokens.length; at += 1) {
				const pair = `${tokens[at - 1]} ${tokens[at]}`;
				if (pairs.has(pair)) found.add(pair);
			}
			item.score *= 1 + (PHRASE_BONUS * found.size) / pairs.size;
		}
		pool.sort((a, b) => b.score - a.score);
	}
	return pool.slice(0, limit).map(({ block, score }) => {
		// The block's passage with the most query words carries the snippet.
		let best = block.segments[0];
		let bestHits = -1;
		for (const at of block.segments) {
			const words = new Set(searchTokens(doc.segments[at].text));
			const hits = [...terms].filter((term) => words.has(term)).length;
			if (hits > bestHits) {
				best = at;
				bestHits = hits;
			}
		}
		return {
			blockId: block.blockId,
			start: block.segments[0],
			end: block.segments[block.segments.length - 1],
			score: Math.round(score * 100) / 100,
			snippet: clipAround(doc.segments[best].text, terms, SNIPPET_CHARS),
			snippetSegment: best
		};
	});
}
