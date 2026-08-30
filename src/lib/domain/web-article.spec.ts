import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
	composeWebArticleMarkdown,
	hostLabel,
	parseJinaReader,
	polishArticleMarkdown,
	prepareArticleDom,
	webArticleFingerprint,
	webArticleSourceName,
	wikipediaRestUrl
} from './web-article';

function dom(html: string): Document {
	return new DOMParser().parseFromString(
		`<html><body>${html}</body></html>`,
		'text/html'
	) as unknown as Document;
}

describe('wikipediaRestUrl', () => {
	it('maps article URLs to the CORS-open REST endpoint', () => {
		expect(wikipediaRestUrl(new URL('https://en.wikipedia.org/wiki/Quantum_mechanics'))).toBe(
			'https://en.wikipedia.org/api/rest_v1/page/html/Quantum_mechanics'
		);
	});

	it('normalizes mobile hosts and preserves the language', () => {
		expect(wikipediaRestUrl(new URL('https://de.m.wikipedia.org/wiki/Quantenmechanik'))).toBe(
			'https://de.wikipedia.org/api/rest_v1/page/html/Quantenmechanik'
		);
	});

	it('percent-encodes titles, including slashes and parentheses', () => {
		expect(
			wikipediaRestUrl(new URL('https://en.wikipedia.org/wiki/Hamiltonian_(quantum_mechanics)'))
		).toBe(
			'https://en.wikipedia.org/api/rest_v1/page/html/Hamiltonian_(quantum_mechanics)'.replace(
				'Hamiltonian_(quantum_mechanics)',
				encodeURIComponent('Hamiltonian_(quantum_mechanics)')
			)
		);
		expect(wikipediaRestUrl(new URL('https://en.wikipedia.org/wiki/AC/DC'))).toBe(
			`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent('AC/DC')}`
		);
	});

	it('decodes already-encoded titles before re-encoding', () => {
		expect(
			wikipediaRestUrl(new URL('https://en.wikipedia.org/wiki/Schr%C3%B6dinger_equation'))
		).toBe(
			`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent('Schrödinger equation'.replace(' ', '_'))}`
		);
	});

	it('ignores non-article and non-Wikipedia URLs', () => {
		expect(wikipediaRestUrl(new URL('https://en.wikipedia.org/w/index.php?search=x'))).toBeNull();
		expect(wikipediaRestUrl(new URL('https://www.wikipedia.org/'))).toBeNull();
		expect(
			wikipediaRestUrl(new URL('https://plato.stanford.edu/entries/consciousness/'))
		).toBeNull();
		expect(wikipediaRestUrl(new URL('https://notwikipedia.org/wiki/Thing'))).toBeNull();
	});
});

describe('prepareArticleDom', () => {
	it('restores truncated TeX annotations from the alttext attribute', () => {
		// Parsoid nests <span typeof="mw:DisplaySpace">&#160;</span> inside
		// annotations, and browser HTML parsing foster-parents the span OUT of
		// the MathML tree with everything after it — the annotation keeps only
		// the leading text. alttext carries the complete TeX.
		const tex = '{\\displaystyle {\\begin{aligned}&\\pi :{\\mathcal {S}}\\to [0,1]\\end{aligned}}}';
		const document = dom(
			`<math alttext="${tex.replace(/&/g, '&amp;')}"><semantics>` +
				'<annotation encoding="application/x-tex">{\\displaystyle {\\begin{aligned}&amp;\\pi</annotation>' +
				'</semantics></math>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('annotation')?.textContent).toBe(tex);
	});

	it('flattens markers a lenient parser keeps inline when alttext is absent', () => {
		const document = dom(
			'<math><semantics><annotation encoding="application/x-tex">' +
				'{\\displaystyle a<span typeof="mw:DisplaySpace">&#160;</span>=b}</annotation></semantics></math>'
		);
		prepareArticleDom(document);
		const annotation = document.querySelector('annotation');
		expect(annotation?.firstElementChild).toBeNull();
		expect(annotation?.textContent).toBe('{\\displaystyle a =b}');
	});

	it('leaves plain-text annotations untouched', () => {
		const document = dom(
			'<math><semantics><annotation encoding="application/x-tex">E=mc^{2}</annotation></semantics></math>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('annotation')?.textContent).toBe('E=mc^{2}');
	});

	it('drops citation superscripts inside figure captions', () => {
		const document = dom(
			'<figure><img src="a.png" alt=""><figcaption>Wave functions.<sup class="mw-ref reference">[5]</sup></figcaption></figure>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('figcaption')?.textContent).toBe('Wave functions.');
	});

	it('folds the caption into an empty image alt', () => {
		const document = dom(
			'<figure><img src="a.png" alt=""><figcaption>  A double-slit\n experiment. </figcaption></figure>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('img')?.getAttribute('alt')).toBe('A double-slit experiment.');
	});

	it('lifts a TeX-bearing caption out of its figure and leaves the alt empty', () => {
		// Defuddle reads an alt matching /\\[a-zA-Z]{2,}/ as a rendered
		// equation image (the picture is dropped, the caption re-emitted as one
		// enormous formula), and flattens a caption left inside the figure to
		// plain text. A paper's captions are full of maths, so they move out.
		const document = dom(
			'<figure id="f"><img src="a.png" alt=""><figcaption>Drawn <strong>only</strong> where $\\het\\le1/4$.</figcaption></figure>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('img')?.getAttribute('alt')).toBe('');
		expect(document.querySelector('figcaption')).toBeNull();
		const moved = document.querySelector('figure')?.nextElementSibling;
		expect(moved?.tagName).toBe('P');
		expect(moved?.textContent).toBe('Drawn only where $\\het\\le1/4$.');
		expect(moved?.querySelector('strong')?.textContent).toBe('only');
	});

	it('still folds in a caption whose only maths is delimiters', () => {
		const document = dom(
			'<figure><img src="a.png" alt=""><figcaption>Centres differ by $34$ units.</figcaption></figure>'
		);
		prepareArticleDom(document);
		expect(document.querySelector('img')?.getAttribute('alt')).toBe(
			'Centres differ by $34$ units.'
		);
	});

	it('keeps an authored alt and images outside figures untouched', () => {
		const document = dom(
			'<figure><img src="a.png" alt="Authored"><figcaption>Caption.</figcaption></figure><img src="b.png" alt="">'
		);
		prepareArticleDom(document);
		expect(document.querySelector('img')?.getAttribute('alt')).toBe('Authored');
		expect(document.querySelectorAll('img')[1]?.getAttribute('alt')).toBe('');
	});
});

describe('polishArticleMarkdown', () => {
	it('strips page-location superscript remnants', () => {
		expect(
			polishArticleMarkdown(
				'Stated plainly.[^6]<sup><span title="Page / location: 1.1">: 1.1</span> </sup> Next.'
			)
		).toBe('Stated plainly.[^6] Next.');
	});

	it('removes empty superscript shells and collapses blank-line runs', () => {
		expect(polishArticleMarkdown('One.<sup> </sup>\n\n\n\n\nTwo.\n')).toBe('One.\n\n\nTwo.');
	});
});

describe('parseJinaReader', () => {
	it('splits the reader header from the markdown body', () => {
		const parsed = parseJinaReader(
			'Title: Consciousness\n\nURL Source: https://plato.stanford.edu/entries/consciousness/\n\nMarkdown Content:\n## Consciousness\n\nBody text.'
		);
		expect(parsed).toEqual({ title: 'Consciousness', markdown: '## Consciousness\n\nBody text.' });
	});

	it('treats marker-less responses as plain markdown', () => {
		expect(parseJinaReader('Just some text.')).toEqual({ markdown: 'Just some text.' });
	});

	it('rejects empty responses and empty bodies', () => {
		expect(parseJinaReader('   ')).toBeNull();
		expect(parseJinaReader('Title: X\n\nMarkdown Content:\n   ')).toBeNull();
	});
});

describe('composeWebArticleMarkdown', () => {
	it('adds a title heading and a full byline', () => {
		const composed = composeWebArticleMarkdown(
			{
				url: 'https://www.quantamagazine.org/the-ai-revolution/',
				title: 'The AI Revolution in Math Has Arrived',
				author: 'Konstantin Kakaes',
				site: 'Quanta Magazine',
				published: '2026-04-13T14:54:41+00:00'
			},
			'The tipping point came in 2025.'
		);
		expect(composed).toBe(
			'# The AI Revolution in Math Has Arrived\n\n' +
				'*By Konstantin Kakaes · Quanta Magazine · April 13, 2026*\n\n' +
				'The tipping point came in 2025.'
		);
	});

	it('skips the heading when the body already leads with a short form of the title', () => {
		const composed = composeWebArticleMarkdown(
			{
				url: 'https://plato.stanford.edu/entries/consciousness/',
				title: 'Consciousness (Stanford Encyclopedia of Philosophy)',
				author: 'Robert Van Gulick',
				site: 'Robert Van Gulick'
			},
			'## Consciousness\n\nPerhaps no aspect of mind is more familiar.'
		);
		expect(
			composed.startsWith('*By Robert Van Gulick · plato.stanford.edu*\n\n## Consciousness')
		).toBe(true);
		expect(composed).not.toContain('# Consciousness (Stanford');
	});

	it('falls back to the host when author and site are absent, and skips unparseable dates', () => {
		const composed = composeWebArticleMarkdown(
			{
				url: 'https://en.wikipedia.org/wiki/Quantum_mechanics',
				title: 'Quantum mechanics',
				published: 'yesterday-ish'
			},
			'**Quantum mechanics** is fundamental.'
		);
		expect(composed).toBe(
			'# Quantum mechanics\n\n*en.wikipedia.org*\n\n**Quantum mechanics** is fundamental.'
		);
	});
});

describe('web article identity helpers', () => {
	it('labels hosts without the www prefix', () => {
		expect(hostLabel('https://www.quantamagazine.org/x/')).toBe('quantamagazine.org');
		expect(hostLabel('not a url')).toBe('');
	});

	it('fingerprints ignore fragments and trailing slashes but keep the query', () => {
		expect(
			webArticleFingerprint(new URL('https://EN.wikipedia.org/wiki/Quantum_mechanics/#History'))
		).toBe('web:en.wikipedia.org/wiki/Quantum_mechanics');
		expect(webArticleFingerprint(new URL('https://example.com/article?p=42'))).toBe(
			'web:example.com/article?p=42'
		);
	});

	it('derives a safe markdown source name from the path', () => {
		expect(webArticleSourceName(new URL('https://en.wikipedia.org/wiki/Quantum_mechanics'))).toBe(
			'Quantum_mechanics.md'
		);
		expect(
			webArticleSourceName(new URL('https://www.quantamagazine.org/the-ai-revolution-in-math/'))
		).toBe('the-ai-revolution-in-math.md');
		expect(webArticleSourceName(new URL('https://example.com/'))).toBe('example.com.md');
	});
});
