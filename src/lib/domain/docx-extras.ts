/**
 * The parts of a Word document mammoth cannot see: OMML equations and
 * drawing-group diagrams. Reads word/document.xml straight out of the .docx
 * zip (a minimal central-directory reader over the platform's
 * DecompressionStream — no dependencies), converts OMML to textbook LaTeX so
 * latex-speech and math narration apply, and extracts drawing text labels so
 * diagrams become describable image constructs instead of silence. Each
 * extra carries the plain text of the paragraph before it, which parseDocx
 * uses to splice it into mammoth's block order.
 */

export interface DocxMathExtra {
	type: 'math';
	latex: string;
	/** Normalized text of the nearest preceding text paragraph ('' = start). */
	anchorText: string;
}

export interface DocxDrawingExtra {
	type: 'drawing';
	labels: string[];
	anchorText: string;
}

export type DocxExtra = DocxMathExtra | DocxDrawingExtra;

/* ── Minimal zip reader ─────────────────────────────────────────────────── */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extract one file from a zip archive. Returns null when absent. */
export async function readZipEntry(archive: Uint8Array, path: string): Promise<Uint8Array | null> {
	const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
	// End-of-central-directory: scan backwards past a possible comment.
	let eocd = -1;
	const scanFloor = Math.max(0, archive.length - 22 - 65_535);
	for (let offset = archive.length - 22; offset >= scanFloor; offset -= 1) {
		if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) return null;
	const entryCount = view.getUint16(eocd + 10, true);
	let cursor = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder();
	for (let index = 0; index < entryCount; index += 1) {
		if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) return null;
		const method = view.getUint16(cursor + 10, true);
		const compressedSize = view.getUint32(cursor + 20, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extraLength = view.getUint16(cursor + 30, true);
		const commentLength = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const name = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
		if (name === path) {
			// The local header repeats name/extra lengths; trust its own values.
			const localName = view.getUint16(localOffset + 26, true);
			const localExtra = view.getUint16(localOffset + 28, true);
			const dataStart = localOffset + 30 + localName + localExtra;
			const data = archive.subarray(dataStart, dataStart + compressedSize);
			if (method === 0) return data.slice();
			if (method === 8) return inflateRaw(data);
			return null;
		}
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return null;
}

/* ── OMML → LaTeX ───────────────────────────────────────────────────────── */

const NARY_OPERATORS: Record<string, string> = {
	'∑': '\\sum',
	'∏': '\\prod',
	'∐': '\\coprod',
	'∫': '\\int',
	'∬': '\\iint',
	'∭': '\\iiint',
	'∮': '\\oint',
	'⋃': '\\bigcup',
	'⋂': '\\bigcap'
};

function children(element: Element, tagName: string): Element[] {
	return Array.from(element.children).filter((child) => child.tagName === tagName);
}

function child(element: Element, tagName: string): Element | undefined {
	return children(element, tagName)[0];
}

function convertAll(element: Element): string {
	return Array.from(element.children).map(convertOmmlNode).join('');
}

/** Word writes math letters as Mathematical Alphanumeric Symbols (𝐸, 𝑚);
 * NFKC folds them back to plain ASCII for LaTeX and speech. */
function mathText(element: Element): string {
	return (element.textContent ?? '').normalize('NFKC');
}

function convertOmmlNode(element: Element): string {
	switch (element.tagName) {
		case 'm:t':
			return mathText(element);
		case 'm:r':
			return children(element, 'm:t').map(mathText).join('');
		case 'm:f': {
			const numerator = child(element, 'm:num');
			const denominator = child(element, 'm:den');
			return `\\frac{${numerator ? convertAll(numerator) : ''}}{${denominator ? convertAll(denominator) : ''}}`;
		}
		case 'm:sSup': {
			const base = child(element, 'm:e');
			const sup = child(element, 'm:sup');
			return `${base ? convertAll(base) : ''}^{${sup ? convertAll(sup) : ''}}`;
		}
		case 'm:sSub': {
			const base = child(element, 'm:e');
			const sub = child(element, 'm:sub');
			return `${base ? convertAll(base) : ''}_{${sub ? convertAll(sub) : ''}}`;
		}
		case 'm:sSubSup': {
			const base = child(element, 'm:e');
			const sub = child(element, 'm:sub');
			const sup = child(element, 'm:sup');
			return `${base ? convertAll(base) : ''}_{${sub ? convertAll(sub) : ''}}^{${sup ? convertAll(sup) : ''}}`;
		}
		case 'm:rad': {
			const degree = child(element, 'm:deg');
			const body = child(element, 'm:e');
			const degreeLatex = degree ? convertAll(degree) : '';
			return degreeLatex
				? `\\sqrt[${degreeLatex}]{${body ? convertAll(body) : ''}}`
				: `\\sqrt{${body ? convertAll(body) : ''}}`;
		}
		case 'm:d': {
			const properties = child(element, 'm:dPr');
			const open = properties ? (child(properties, 'm:begChr')?.getAttribute('m:val') ?? '(') : '(';
			const close = properties
				? (child(properties, 'm:endChr')?.getAttribute('m:val') ?? ')')
				: ')';
			const parts = children(element, 'm:e').map(convertAll);
			return `${open}${parts.join(', ')}${close}`;
		}
		case 'm:nary': {
			const properties = child(element, 'm:naryPr');
			const chr = properties ? child(properties, 'm:chr')?.getAttribute('m:val') : undefined;
			// OMML's default n-ary operator is the integral.
			const operator = NARY_OPERATORS[chr ?? '∫'] ?? chr ?? '\\int';
			const sub = child(element, 'm:sub');
			const sup = child(element, 'm:sup');
			const body = child(element, 'm:e');
			const subLatex = sub ? convertAll(sub) : '';
			const supLatex = sup ? convertAll(sup) : '';
			return (
				operator +
				(subLatex ? `_{${subLatex}}` : '') +
				(supLatex ? `^{${supLatex}}` : '') +
				(body ? ` ${convertAll(body)}` : '')
			);
		}
		case 'm:func': {
			const name = child(element, 'm:fName');
			const body = child(element, 'm:e');
			return `${name ? convertAll(name) : ''} ${body ? convertAll(body) : ''}`.trim();
		}
		case 'm:bar': {
			const body = child(element, 'm:e');
			return `\\bar{${body ? convertAll(body) : ''}}`;
		}
		// Property containers carry no spoken content.
		case 'm:rPr':
		case 'm:ctrlPr':
		case 'm:fPr':
		case 'm:sSupPr':
		case 'm:sSubPr':
		case 'm:sSubSupPr':
		case 'm:radPr':
		case 'm:dPr':
		case 'm:naryPr':
		case 'm:funcPr':
		case 'm:barPr':
		case 'm:oMathParaPr':
			return '';
		default:
			return convertAll(element);
	}
}

export function ommlToLatex(math: Element): string {
	return convertOmmlNode(math).replace(/\s+/g, ' ').trim();
}

/* ── Document walk ──────────────────────────────────────────────────────── */

function descendants(element: Element, tagName: string): Element[] {
	const found: Element[] = [];
	const visit = (node: Element) => {
		if (node.tagName === tagName) found.push(node);
		for (const next of Array.from(node.children)) visit(next);
	};
	visit(element);
	return found;
}

/** The paragraph's plain text with math and drawing content excluded, for
 * anchoring extras against mammoth-derived blocks. */
function paragraphPlainText(paragraph: Element): string {
	let text = '';
	const visit = (node: Element) => {
		if (node.tagName.startsWith('m:') || node.tagName === 'w:drawing') return;
		if (node.tagName === 'w:t') text += node.textContent ?? '';
		for (const next of Array.from(node.children)) visit(next);
	};
	visit(paragraph);
	return text.replace(/\s+/g, ' ').trim();
}

function drawingLabels(drawing: Element): string[] {
	const labels: string[] = [];
	for (const textBox of descendants(drawing, 'w:txbxContent')) {
		for (const paragraph of descendants(textBox, 'w:p')) {
			const label = descendants(paragraph, 'w:t')
				.map((node) => node.textContent ?? '')
				.join('')
				.replace(/\s+/g, ' ')
				.trim();
			if (label) labels.push(label);
		}
	}
	return labels;
}

/** Math equations and labeled drawings from document.xml, in document order,
 * each anchored to the text paragraph before it. */
export function docxExtrasFromXml(documentXml: string): DocxExtra[] {
	const dom = new DOMParser().parseFromString(documentXml, 'text/xml');
	const root = dom.documentElement;
	if (!root) return [];
	const body = descendants(root, 'w:body')[0];
	if (!body) return [];
	const extras: DocxExtra[] = [];
	let anchorText = '';
	for (const paragraph of descendants(body, 'w:p')) {
		// Nested paragraphs (inside drawings' text boxes) are handled by
		// drawingLabels; only top-level flow paragraphs anchor content.
		if (paragraph.parentElement !== body && paragraph.parentElement?.tagName !== 'w:body') {
			continue;
		}
		const text = paragraphPlainText(paragraph);
		for (const math of descendants(paragraph, 'm:oMath')) {
			// An oMath nested anywhere inside another (delimiters, matrix cells)
			// converts as part of its outermost ancestor — never twice.
			let ancestor = math.parentElement;
			let isNested = false;
			while (ancestor && ancestor !== paragraph) {
				if (ancestor.tagName === 'm:oMath') {
					isNested = true;
					break;
				}
				ancestor = ancestor.parentElement;
			}
			if (isNested) continue;
			const latex = ommlToLatex(math);
			if (latex) extras.push({ type: 'math', latex, anchorText: text || anchorText });
		}
		for (const drawing of descendants(paragraph, 'w:drawing')) {
			const labels = drawingLabels(drawing);
			if (labels.length) extras.push({ type: 'drawing', labels, anchorText: text || anchorText });
		}
		if (text) anchorText = text;
	}
	return extras;
}

export async function extractDocxExtras(archive: Uint8Array): Promise<DocxExtra[]> {
	const entry = await readZipEntry(archive, 'word/document.xml');
	if (!entry) return [];
	return docxExtrasFromXml(new TextDecoder().decode(entry));
}
