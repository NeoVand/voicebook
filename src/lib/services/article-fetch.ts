/**
 * Fetch a web page and reduce it to readable article markdown, entirely in
 * the browser. Wikipedia is served by its CORS-open REST API; every other
 * site is tried directly first (many allow cross-origin reads), then through
 * a public CORS relay, and finally through the Jina Reader service, which
 * returns pre-extracted markdown when the raw page cannot be reached at all.
 * Extraction and markdown conversion run on-device via Defuddle — the page
 * content itself never goes anywhere except, when a relay is needed, to that
 * relay.
 */
import {
	composeWebArticleMarkdown,
	parseJinaReader,
	polishArticleMarkdown,
	prepareArticleDom,
	wikipediaRestUrl
} from '$lib/domain/web-article';
import { expandMarkdownMacros, texMacrosFromDocument } from '$lib/domain/tex-macros';

export class ArticleFetchError extends Error {
	constructor(
		message: string,
		readonly reason: 'invalid-url' | 'unreachable' | 'empty'
	) {
		super(message);
		this.name = 'ArticleFetchError';
	}
}

export interface FetchedWebArticle {
	/** The normalized page address the document should carry. */
	url: string;
	title?: string;
	/** Composed markdown (title heading + byline + extracted body). */
	markdown: string;
}

export interface FetchWebArticleOptions {
	onStage?: (stage: 'fetching' | 'extracting') => void;
}

const DIRECT_TIMEOUT_MS = 15_000;
const RELAY_TIMEOUT_MS = 20_000;
const READER_TIMEOUT_MS = 30_000;

const UNREACHABLE_MESSAGE =
	'This page could not be reached. It may be offline, or it may block the relays Voicebook can use from the browser.';
const EMPTY_MESSAGE =
	'No readable article was found on this page. It may need sign-in, or the content may load only with scripts.';

export function normalizeWebUrl(input: string): URL {
	const trimmed = input.trim();
	if (!trimmed) throw new ArticleFetchError('Enter a web address to read.', 'invalid-url');
	const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new ArticleFetchError(
			'That does not look like a web address. Try the full https:// link.',
			'invalid-url'
		);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new ArticleFetchError('Only http and https pages can be read.', 'invalid-url');
	}
	return url;
}

/** One fetch attempt; null means "try the next route" (network refusal, bad
 * status, or a body that is clearly not a page). */
async function tryFetchText(url: string, timeoutMs: number): Promise<string | null> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return null;
		const text = await response.text();
		return text.trim() ? text : null;
	} catch {
		return null;
	}
}

function looksLikeHtml(text: string): boolean {
	return /^\s*</.test(text);
}

interface DefuddleParseResult {
	content?: string;
	title?: string;
	author?: string;
	site?: string;
	published?: string;
}

interface DefuddleConstructor {
	new (
		doc: Document,
		options?: { url?: string; markdown?: boolean }
	): { parseAsync(): Promise<DefuddleParseResult> };
}

/** The full bundle ships UMD; depending on the bundler's interop the class is
 * the default export or nested one level below it. */
async function loadDefuddle(): Promise<DefuddleConstructor> {
	const loaded: unknown = (await import('defuddle/full')).default;
	if (typeof loaded === 'function') return loaded as DefuddleConstructor;
	const nested = (loaded as { default?: unknown } | null)?.default;
	if (typeof nested === 'function') return nested as DefuddleConstructor;
	throw new ArticleFetchError('The article reader failed to load.', 'unreachable');
}

function assertReadable(body: string): void {
	const substance = body.replace(/[^\p{L}\p{N}]+/gu, '');
	if (substance.length < 240) throw new ArticleFetchError(EMPTY_MESSAGE, 'empty');
}

export async function fetchWebArticle(
	input: string,
	options: FetchWebArticleOptions = {}
): Promise<FetchedWebArticle> {
	const url = normalizeWebUrl(input);
	options.onStage?.('fetching');

	const wikipedia = wikipediaRestUrl(url);
	let html: string | null;
	if (wikipedia) {
		html = await tryFetchText(wikipedia, DIRECT_TIMEOUT_MS);
	} else {
		html = await tryFetchText(url.href, DIRECT_TIMEOUT_MS);
		if (!html || !looksLikeHtml(html)) {
			html = await tryFetchText(
				`https://corsproxy.io/?url=${encodeURIComponent(url.href)}`,
				RELAY_TIMEOUT_MS
			);
		}
		if (!html || !looksLikeHtml(html)) {
			// Last resort: a reader relay that extracts on its own servers and
			// returns markdown — no HTML to run Defuddle on, but the page is
			// otherwise unreachable from a browser.
			const reader = await tryFetchText(`https://r.jina.ai/${url.href}`, READER_TIMEOUT_MS);
			const parsed = reader && !looksLikeHtml(reader) ? parseJinaReader(reader) : null;
			if (!parsed) throw new ArticleFetchError(UNREACHABLE_MESSAGE, 'unreachable');
			options.onStage?.('extracting');
			const body = polishArticleMarkdown(parsed.markdown);
			assertReadable(body);
			return {
				url: url.href,
				title: parsed.title,
				markdown: composeWebArticleMarkdown({ url: url.href, title: parsed.title }, body)
			};
		}
	}
	if (!html || !looksLikeHtml(html)) {
		throw new ArticleFetchError(UNREACHABLE_MESSAGE, 'unreachable');
	}

	options.onStage?.('extracting');
	const dom = new DOMParser().parseFromString(html, 'text/html');
	// Read before the prepass: the page's own script is the only place its TeX
	// shorthands are defined, and extraction drops scripts.
	const macros = texMacrosFromDocument(dom);
	prepareArticleDom(dom);
	const Defuddle = await loadDefuddle();
	const result = await new Defuddle(dom, { url: url.href, markdown: true }).parseAsync();
	const body = expandMarkdownMacros(polishArticleMarkdown(result.content ?? ''), macros);
	assertReadable(body);
	return {
		url: url.href,
		title: result.title,
		markdown: composeWebArticleMarkdown(
			{
				url: url.href,
				title: result.title,
				author: result.author,
				site: result.site,
				published: result.published
			},
			body
		)
	};
}
