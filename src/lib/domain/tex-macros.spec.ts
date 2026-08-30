import { DOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
	balancedBraces,
	expandMarkdownMacros,
	expandTexMacros,
	texMacrosFromDocument,
	texMacrosFromScripts
} from './tex-macros';

function dom(html: string): Document {
	return new DOMParser().parseFromString(
		`<html><body>${html}</body></html>`,
		'text/html'
	) as unknown as Document;
}

describe('balancedBraces', () => {
	it('spans nested braces and ignores braces inside strings', () => {
		expect(balancedBraces('x = {"a": "{{{"} tail', 4)).toBe('{"a": "{{{"}');
		expect(balancedBraces('{ a: { b: 1 } }', 0)).toBe('{ a: { b: 1 } }');
	});

	it('returns null when the group never closes or does not start here', () => {
		expect(balancedBraces('{ unterminated', 0)).toBeNull();
		expect(balancedBraces('not a group', 0)).toBeNull();
	});
});

describe('texMacrosFromScripts', () => {
	it('reads a KaTeX auto-render table, backslashes and all', () => {
		const script = `renderMathInElement(document.body, {
			delimiters: [{ left: '$', right: '$', display: false }],
			macros: {"\\\\R":"\\\\mathbb{R}","\\\\idx":"\\\\phi","\\\\Rot":"\\\\mathbf{R}_{#1}"},
			strict: false
		});`;
		expect(texMacrosFromScripts([script])).toEqual({
			R: '\\mathbb{R}',
			idx: '\\phi',
			Rot: '\\mathbf{R}_{#1}'
		});
	});

	it('reads a MathJax table: bare keys, single quotes, [body, arity] values', () => {
		const script = `window.MathJax = { tex: { macros: {
			RR: '{\\\\bf R}',
			bold: ['{\\\\bf #1}', 1],
		} } };`;
		expect(texMacrosFromScripts([script])).toEqual({ RR: '{\\bf R}', bold: '{\\bf #1}' });
	});

	it('ignores tables it cannot read and names it could never match back', () => {
		expect(texMacrosFromScripts(['macros: { broken'])).toEqual({});
		expect(texMacrosFromScripts(['macros: [1, 2]'])).toEqual({});
		expect(texMacrosFromScripts([`macros: {"\\\\two words": "x", "\\\\ok": "y"}`])).toEqual({
			ok: 'y'
		});
	});

	it('takes the page scripts in order, later definitions winning', () => {
		expect(
			texMacrosFromScripts([`macros: {"\\\\R": "first"}`, `macros: {"\\\\R": "second"}`])
		).toEqual({ R: 'second' });
	});
});

describe('texMacrosFromDocument', () => {
	it('reads inline scripts and skips external ones', () => {
		const document = dom(
			`<script src="https://cdn.example.com/katex.js"></script>` +
				`<script>renderMathInElement(document.body, { macros: {"\\\\het": "\\\\eta"} });</script>`
		);
		expect(texMacrosFromDocument(document)).toEqual({ het: '\\eta' });
	});

	it('is empty for a page with no macro table', () => {
		expect(texMacrosFromDocument(dom('<script>console.log(1);</script>'))).toEqual({});
	});
});

describe('expandTexMacros', () => {
	const macros = {
		R: '\\mathbb{R}',
		idx: '\\phi',
		ph: '\\psi',
		Rot: '\\mathbf{R}_{#1}',
		pair: '(#1,\\;#2)'
	};

	it('rewrites bare macros and leaves longer names that merely start alike', () => {
		expect(expandTexMacros('p \\in \\R^2', macros)).toBe('p \\in \\mathbb{R}^2');
		expect(expandTexMacros('\\idx(p) - \\ph(p)', macros)).toBe('\\phi(p) - \\psi(p)');
		// \Rotate is a different command, not \Rot followed by "ate".
		expect(expandTexMacros('\\Rotate', macros)).toBe('\\Rotate');
	});

	it('takes braced groups and single tokens as arguments', () => {
		expect(expandTexMacros('\\Rot{\\theta}', macros)).toBe('\\mathbf{R}_{\\theta}');
		expect(expandTexMacros('\\Rot n', macros)).toBe('\\mathbf{R}_{n}');
		expect(expandTexMacros('\\Rot\\alpha', macros)).toBe('\\mathbf{R}_{\\alpha}');
		expect(expandTexMacros('\\pair{a}{b}', macros)).toBe('(a,\\;b)');
	});

	it('reads a group whose contents carry primes and escaped braces', () => {
		expect(expandTexMacros("\\Rot{-n'\\theta}", macros)).toBe("\\mathbf{R}_{-n'\\theta}");
		expect(expandTexMacros('\\Rot{\\{a\\}}', macros)).toBe('\\mathbf{R}_{\\{a\\}}');
	});

	it('expands macros written in terms of other macros', () => {
		expect(expandTexMacros('\\field', { ...macros, field: '\\R \\times \\R' })).toBe(
			'\\mathbb{R} \\times \\mathbb{R}'
		);
	});

	it('leaves a macro alone when its arguments are not there', () => {
		expect(expandTexMacros('\\Rot', macros)).toBe('\\Rot');
		expect(expandTexMacros('\\Rot{unterminated', macros)).toBe('\\Rot{unterminated');
	});

	it('terminates on a self-referential table', () => {
		expect(expandTexMacros('\\loop', { loop: '\\loop' })).toBe('\\loop');
		expect(expandTexMacros('\\fan', { fan: '\\fan\\fan' }).length).toBeGreaterThan(0);
	});

	it('passes through text with no macros to expand', () => {
		expect(expandTexMacros('plain words', macros)).toBe('plain words');
		expect(expandTexMacros('\\alpha + \\beta', {})).toBe('\\alpha + \\beta');
	});
});

describe('expandMarkdownMacros', () => {
	const macros = { het: '\\eta', R: '\\mathbb{R}' };

	it('expands inside every maths delimiter family', () => {
		expect(expandMarkdownMacros('ratio $\\het$ here', macros)).toBe('ratio $\\eta$ here');
		expect(expandMarkdownMacros('$$\n\\het \\in \\R\n$$', macros)).toBe(
			'$$\n\\eta \\in \\mathbb{R}\n$$'
		);
		expect(expandMarkdownMacros('\\[\\het\\]', macros)).toBe('\\[\\eta\\]');
		expect(expandMarkdownMacros('\\(\\het\\)', macros)).toBe('\\(\\eta\\)');
	});

	it('follows inline maths across a wrapped line but not past a blank one', () => {
		expect(expandMarkdownMacros('lines: $\\het =\n\\R/s$ here', macros)).toBe(
			'lines: $\\eta =\n\\mathbb{R}/s$ here'
		);
		// An unbalanced dollar must not swallow the next paragraph's macros.
		expect(expandMarkdownMacros('costs $5\n\nprose \\het and $\\het$', macros)).toBe(
			'costs $5\n\nprose \\het and $\\eta$'
		);
	});

	it('leaves prose and fenced code untouched', () => {
		expect(expandMarkdownMacros('a path C:\\het and $\\het$', macros)).toBe(
			'a path C:\\het and $\\eta$'
		);
		const fenced = '```tex\n$\\het$\n```\n\nand $\\het$ in prose';
		expect(expandMarkdownMacros(fenced, macros)).toBe(
			'```tex\n$\\het$\n```\n\nand $\\eta$ in prose'
		);
	});

	it('is a no-op without macros or without backslashes', () => {
		expect(expandMarkdownMacros('$\\het$', {})).toBe('$\\het$');
		expect(expandMarkdownMacros('no maths here', macros)).toBe('no maths here');
	});
});
