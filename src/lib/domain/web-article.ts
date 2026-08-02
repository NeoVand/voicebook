/**
 * Pure helpers for importing web pages: the Wikipedia REST endpoint mapping,
 * the DOM prepass before article extraction, markdown cleanup after it, the
 * Jina Reader fallback format, and the composed document header. The network
 * and extraction steps live in services/article-fetch.ts; everything here is
 * deterministic and unit-testable.
 */

/** Marks a stored source blob as extracted web-article markdown, so
 * normalization migrations re-parse it through the markdown pipeline while
 * the document keeps its 'web' identity. */
export const WEB_ARTICLE_MIME = 'text/vnd.voicebook.web-article';

export interface WebArticleMeta {
	url: string;
	title?: string;
	author?: string;
	site?: string;
	/** Publication date, usually ISO-formatted; injected only when parseable. */
	published?: string;
}

/**
 * Wikipedia pages are the one major source a static app can fetch without any
 * relay: the Wikimedia REST API serves full Parsoid article HTML with
 * `Access-Control-Allow-Origin: *`. Maps article URLs (desktop and mobile) to
 * that endpoint; anything else returns null and takes the general path.
 */
export function wikipediaRestUrl(url: URL): string | null {
	const host = /^([a-z0-9-]+)(?:\.m)?\.wikipedia\.org$/i.exec(url.hostname);
	if (!host || host[1].toLowerCase() === 'www') return null;
	const article = /^\/wiki\/(.+)$/.exec(url.pathname);
	if (!article) return null;
	let title: string;
	try {
		title = decodeURIComponent(article[1]);
	} catch {
		title = article[1];
	}
	return `https://${host[1].toLowerCase()}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(title)}`;
}

function normalizedText(value: string | null | undefined): string {
	return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * DOM fixes before extraction, for structures the extractor keeps but
 * mishandles:
 * - TeX annotations are not always intact: Parsoid nests markers inside
 *   them (`<span typeof="mw:DisplaySpace">&nbsp;</span>` for explicit
 *   spaces), and the browser's HTML parser foster-parents such spans OUT of
 *   the MathML tree together with everything after them — a multi-line
 *   `aligned` equation loses its tail at the first marker. The math
 *   element's `alttext` attribute carries the complete TeX and survives
 *   parsing untouched, so annotations are restored from it (falling back to
 *   flattening whatever a lenient parser kept inline), with non-breaking
 *   spaces as ordinary spaces;
 * - citation superscripts inside figure captions survive as bare digits in
 *   the caption text (the footnote pass only reaches body refs) — drop them;
 * - images whose alt is empty adopt their figcaption, so the narration layer
 *   has a caption to describe (the local engine never invents what it cannot
 *   see) while the visible caption paragraph reads as usual.
 */
export function prepareArticleDom(document: Document): void {
	for (const math of Array.from(document.querySelectorAll('math'))) {
		const annotation = math.querySelector('annotation');
		if (!annotation) continue;
		const alttext = (math.getAttribute('alttext') ?? '').replace(/\u00a0/g, ' ').trim();
		const flattened = (annotation.textContent ?? '').replace(/\u00a0/g, ' ');
		const restored = alttext || flattened;
		if (annotation.firstElementChild || annotation.textContent !== restored) {
			annotation.textContent = restored;
		}
	}
	for (const sup of Array.from(
		document.querySelectorAll('figcaption sup.mw-ref, figcaption sup.reference')
	)) {
		sup.remove();
	}
	for (const figure of Array.from(document.querySelectorAll('figure'))) {
		const image = figure.querySelector('img');
		const caption = normalizedText(figure.querySelector('figcaption')?.textContent);
		if (image && caption && !normalizedText(image.getAttribute('alt'))) {
			image.setAttribute('alt', caption);
		}
	}
}

/**
 * Markdown cleanup after extraction. Wikipedia's page-location markers
 * ({{rp}} templates) survive as raw sup/span HTML next to footnote refs and
 * would be read aloud as stray numbers; empty sup shells sometimes remain
 * when a ref had no text.
 */
export function polishArticleMarkdown(markdown: string): string {
	return markdown
		.replace(
			/<sup>\s*<span[^>]*title="Page \/ location:[^"]*"[^>]*>[\s\S]*?<\/span>\s*<\/sup>/gi,
			''
		)
		.replace(/<sup>\s*<\/sup>/gi, '')
		.replace(/\n{4,}/g, '\n\n\n')
		.trim();
}

/**
 * The Jina Reader relay (`r.jina.ai`) returns pre-extracted content as
 * `Title: …` / `URL Source: …` header lines followed by a `Markdown Content:`
 * marker. Splits that apart; a response without the marker is treated as
 * plain markdown.
 */
export function parseJinaReader(text: string): { title?: string; markdown: string } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const marker = /^Markdown Content:[ \t]*$/m.exec(trimmed);
	if (!marker) return { markdown: trimmed };
	const header = trimmed.slice(0, marker.index);
	const markdown = trimmed.slice(marker.index + marker[0].length).trim();
	if (!markdown) return null;
	const title = /^Title:[ \t]*(.+)$/m.exec(header)?.[1]?.trim();
	return { ...(title ? { title } : {}), markdown };
}

function formattedDate(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function headingText(line: string): string | null {
	const match = /^#{1,6}\s+(.*)$/.exec(line.trim());
	if (!match) return null;
	return normalizedText(match[1].replace(/[*_`]/g, ''));
}

/**
 * Prefixes the extracted body with a title heading and a byline paragraph, so
 * the reading opens the way an article does. The heading is skipped when the
 * body already leads with one that matches the title (Wikipedia's REST HTML
 * has no in-body title; encyclopedia entries often repeat a short form of
 * it).
 */
export function composeWebArticleMarkdown(meta: WebArticleMeta, body: string): string {
	const lines: string[] = [];
	const title = normalizedText(meta.title);
	const firstLine = body.split('\n').find((line) => line.trim()) ?? '';
	const leadingHeading = headingText(firstLine);
	const titleLower = title.toLowerCase();
	const headingLower = leadingHeading?.toLowerCase() ?? '';
	const alreadyTitled =
		Boolean(leadingHeading) &&
		(titleLower.startsWith(headingLower) || headingLower.startsWith(titleLower));
	if (title && !alreadyTitled) lines.push(`# ${title}`);
	const author = normalizedText(meta.author);
	// Some extractions echo the author into the site slot; the host is the
	// honest fallback either way.
	let site = normalizedText(meta.site);
	if (!site || site.toLowerCase() === author.toLowerCase()) site = hostLabel(meta.url);
	const byline = [
		author ? `By ${author}` : '',
		site && site.toLowerCase() !== author.toLowerCase() ? site : '',
		formattedDate(meta.published) ?? ''
	]
		.filter(Boolean)
		.join(' · ');
	if (byline) lines.push(`*${byline}*`);
	lines.push(body.trim());
	return lines.join('\n\n');
}

/** The page's host without a leading www, for bylines and library cards. */
export function hostLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/** A stable per-page identity: same address (ignoring the fragment) means
 * the same document, so re-adding a page surfaces the existing entry. */
export function webArticleFingerprint(url: URL): string {
	const path = url.pathname.replace(/\/+$/, '');
	return `web:${url.hostname.toLowerCase()}${path}${url.search}`;
}

/** A filesystem-safe source name derived from the page address. */
export function webArticleSourceName(url: URL): string {
	const segment = url.pathname
		.split('/')
		.filter(Boolean)
		.map((part) => {
			try {
				return decodeURIComponent(part);
			} catch {
				return part;
			}
		})
		.at(-1);
	const base = (segment || url.hostname)
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/^-+|-+$/g, '');
	return `${(base || 'web-article').slice(0, 80)}.md`;
}
