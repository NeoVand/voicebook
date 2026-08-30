/**
 * TeX macro expansion for imported pages.
 *
 * A paper published as HTML usually renders its own maths in the browser, and
 * it hands KaTeX (or MathJax) a table of the shorthands its author writes in:
 * `\idx` for `\phi`, `\R` for `\mathbb{R}`, `\Rot{\theta}` for
 * `\mathbf{R}_{\theta}`. That table lives in the page's own script, so a
 * reader that fetches the HTML and renders the TeX itself has never seen it —
 * every custom command comes out as literal `\idx` on the page and as raw
 * source in the spoken reading.
 *
 * Expanding the shorthands into the source at import time fixes all of that at
 * once: the equations render, the deterministic verbaliser reads them, and the
 * language model rewriting them sees ordinary TeX. Everything here is a pure
 * string transform — a page's macro table is data, never code, and is never
 * evaluated.
 */

/** Macro name (without the leading backslash) to its replacement body. */
export type TexMacros = Record<string, string>;

/** A hostile or broken page must not be able to blow up the import. */
const MAX_MACROS = 256;
const MAX_BODY_CHARS = 2048;
/** Total substitutions across one expansion, so a self-referential table
 * (`\a` → `\a\a`) cannot fan out. */
const MAX_EXPANSIONS = 50_000;
/** Depth of macro-inside-macro expansion before the chain is left alone. */
const MAX_DEPTH = 16;

/** Highest `#n` referenced by a macro body — its argument count. */
function arityOf(body: string): number {
	let arity = 0;
	for (const match of body.matchAll(/#(\d)/g)) arity = Math.max(arity, Number(match[1]));
	return arity;
}

/**
 * Normalizes a parsed macro table: KaTeX writes names with the backslash
 * (`"\\R"`), MathJax without it (`RR`), and MathJax lets a value be
 * `[body, arity]`. Oversized tables and bodies are dropped rather than
 * truncated — a partial macro would expand into broken TeX.
 */
function normalizeMacros(raw: Record<string, unknown>): TexMacros {
	const macros: TexMacros = {};
	for (const [key, value] of Object.entries(raw)) {
		if (Object.keys(macros).length >= MAX_MACROS) break;
		const body = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
		if (typeof body !== 'string' || body.length > MAX_BODY_CHARS) continue;
		const name = key.replace(/^\\/, '');
		// Only control words and single-character control symbols can ever be
		// matched back out of the source.
		if (!/^(?:[a-zA-Z]+|[^a-zA-Z\s])$/.test(name)) continue;
		macros[name] = body;
	}
	return macros;
}

/**
 * Best-effort repair of an almost-JSON object literal: bare identifier keys,
 * single-quoted strings and trailing commas are all legal JavaScript and all
 * common in hand-written macro tables. Anything still unparseable yields no
 * macros — a page whose table we cannot read simply reads as it did before.
 */
function parseObjectLiteral(source: string): Record<string, unknown> | null {
	const attempts = [source, repairJson(source)];
	for (const attempt of attempts) {
		try {
			const parsed: unknown = JSON.parse(attempt);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// try the next form
		}
	}
	return null;
}

function repairJson(source: string): string {
	return (
		source
			// 'single quoted' → "double quoted", with the escapes read the way
			// JavaScript reads them (`\\` is one backslash, not two).
			.replace(/'((?:[^'\\]|\\.)*)'/g, (_, body: string) => JSON.stringify(fromSingleQuoted(body)))
			// bare identifier keys → quoted keys
			.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
			// trailing commas
			.replace(/,(\s*[}\]])/g, '$1')
	);
}

/**
 * The contents of a single-quoted JavaScript string, read as JSON: the two
 * escape grammars agree except that JSON rejects `\'` and requires a bare `"`
 * escaped. A body that still will not parse is taken literally.
 */
function fromSingleQuoted(body: string): string {
	const asJson = body.replace(/\\(.)|"/gs, (whole, escaped: string | undefined) => {
		if (escaped === undefined) return '\\"';
		return escaped === "'" ? "'" : whole;
	});
	try {
		return JSON.parse(`"${asJson}"`) as string;
	} catch {
		return body;
	}
}

/**
 * The balanced `{…}` starting at `start`, string literals respected so a brace
 * inside a TeX body does not close the object. Returns null if it never
 * closes.
 */
export function balancedBraces(source: string, start: number): string | null {
	if (source[start] !== '{') return null;
	let depth = 0;
	let quote: string | null = null;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (quote) {
			if (char === '\\') index += 1;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return null;
}

/**
 * The macro table a page hands its own maths renderer. Reads every inline
 * script for a `macros:` (KaTeX, MathJax v3) or `Macros:` (MathJax v2) object
 * and merges what parses; later scripts win, matching the order the page's own
 * renderer would see them in.
 */
export function texMacrosFromScripts(scripts: string[]): TexMacros {
	const macros: TexMacros = {};
	for (const script of scripts) {
		for (const match of script.matchAll(/\b[Mm]acros\s*:\s*(?=\{)/g)) {
			const literal = balancedBraces(script, match.index + match[0].length);
			if (!literal) continue;
			const parsed = parseObjectLiteral(literal);
			if (parsed) Object.assign(macros, normalizeMacros(parsed));
		}
	}
	return macros;
}

/** Reads `texMacrosFromScripts` off a parsed page's inline scripts. */
export function texMacrosFromDocument(document: Document): TexMacros {
	const scripts = Array.from(document.querySelectorAll('script:not([src])'), (script) =>
		String(script.textContent ?? '')
	).filter((text) => text.includes('acros'));
	return texMacrosFromScripts(scripts);
}

/**
 * The balanced `{…}` of a TeX group. Unlike an object literal, a quote here is
 * prime notation (`{-n'\theta}`) and never opens a string; only a backslash
 * escapes the brace that follows it.
 */
function balancedTexGroup(source: string, start: number): string | null {
	if (source[start] !== '{') return null;
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (char === '\\') index += 1;
		else if (char === '{') depth += 1;
		else if (char === '}') {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}
	return null;
}

/** One macro argument after `offset`: a braced group, or the single token
 * (character or control sequence) that follows. */
function readArgument(source: string, offset: number): { value: string; end: number } | null {
	let index = offset;
	while (index < source.length && /\s/.test(source[index])) index += 1;
	if (index >= source.length) return null;
	if (source[index] === '{') {
		const group = balancedTexGroup(source, index);
		if (!group) return null;
		return { value: group.slice(1, -1), end: index + group.length };
	}
	if (source[index] === '\\') {
		const control = /^\\(?:[a-zA-Z]+|.)/.exec(source.slice(index));
		if (!control) return null;
		return { value: control[0], end: index + control[0].length };
	}
	return { value: source[index], end: index + 1 };
}

/**
 * Rewrites every `\name` the table defines into its body, substituting `#1`…
 * `#9` from the arguments that follow. Expansion continues over the
 * substituted text so a macro defined in terms of another resolves, bounded by
 * `MAX_DEPTH`; a macro that cannot take its arguments (a truncated equation,
 * say) is left exactly as written.
 */
export function expandTexMacros(tex: string, macros: TexMacros): string {
	if (!tex.includes('\\') || !Object.keys(macros).length) return tex;
	return expandWithin(tex, macros, 0, { spent: 0 });
}

function expandWithin(
	tex: string,
	macros: TexMacros,
	depth: number,
	budget: { spent: number }
): string {
	if (!tex.includes('\\') || depth >= MAX_DEPTH) return tex;
	let out = '';
	let index = 0;
	while (index < tex.length) {
		const backslash = tex.indexOf('\\', index);
		if (backslash < 0) {
			out += tex.slice(index);
			break;
		}
		out += tex.slice(index, backslash);
		const control = /^\\(?:[a-zA-Z]+|[^a-zA-Z])/.exec(tex.slice(backslash));
		if (!control) {
			out += tex.slice(backslash);
			break;
		}
		const name = control[0].slice(1);
		const body = macros[name];
		if (body === undefined || budget.spent >= MAX_EXPANSIONS) {
			out += control[0];
			index = backslash + control[0].length;
			continue;
		}
		const arity = arityOf(body);
		const args: string[] = [];
		let cursor = backslash + control[0].length;
		let complete = true;
		for (let n = 0; n < arity; n += 1) {
			const argument = readArgument(tex, cursor);
			if (!argument) {
				complete = false;
				break;
			}
			args.push(argument.value);
			cursor = argument.end;
		}
		if (!complete) {
			out += control[0];
			index = backslash + control[0].length;
			continue;
		}
		budget.spent += 1;
		const substituted = body.replace(/#(\d)/g, (whole, digit: string) => {
			const argument = args[Number(digit) - 1];
			return argument === undefined ? whole : argument;
		});
		out += expandWithin(substituted, macros, depth + 1, budget);
		index = cursor;
	}
	return out;
}

/**
 * Every maths region of a markdown document, in either delimiter family.
 * Deliberately narrow: expansion must not touch prose, where a lone `\R`
 * belongs to a Windows path rather than to the page's macro table. Inline
 * `$…$` may wrap across a line — source TeX is hard-wrapped all the time — but
 * not across a blank one, which is where the paragraph, and any run of
 * unbalanced dollars with it, ends.
 */
const MATH_REGION =
	/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?!\s)(?:[^$\n]|\n(?!\s*\n))*?(?<!\s)\$/g;
const FENCE_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;

/**
 * Expands a page's own macros inside the maths of its extracted markdown.
 * Fenced code is skipped whole — an article about TeX may well quote the very
 * commands the page defines.
 */
export function expandMarkdownMacros(markdown: string, macros: TexMacros): string {
	if (!Object.keys(macros).length || !markdown.includes('\\')) return markdown;
	const expand = (prose: string) =>
		prose.replace(MATH_REGION, (region) => expandTexMacros(region, macros));
	let out = '';
	let cursor = 0;
	for (const fence of markdown.matchAll(FENCE_BLOCK)) {
		out += expand(markdown.slice(cursor, fence.index)) + fence[0];
		cursor = fence.index + fence[0].length;
	}
	return out + expand(markdown.slice(cursor));
}
