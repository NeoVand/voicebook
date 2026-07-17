import { DOMParser } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { docxExtrasFromXml, ommlToLatex, readZipEntry } from './docx-extras';

beforeAll(() => {
	Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
});

function omml(inner: string): Element {
	const xml = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${inner}</m:oMath>`;
	const parsed = new DOMParser().parseFromString(xml, 'text/xml');
	return parsed.documentElement as unknown as Element;
}

describe('OMML to LaTeX', () => {
	it('folds Word math alphanumerics and superscripts into textbook LaTeX', () => {
		expect(
			ommlToLatex(
				omml(
					'<m:r><m:t>𝐸=𝑚</m:t></m:r>' +
						'<m:sSup><m:e><m:r><m:t>𝑐</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup>'
				)
			)
		).toBe('E=mc^{2}');
	});

	it('converts fractions, roots, subscripts, and delimiters', () => {
		expect(
			ommlToLatex(
				omml(
					'<m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f>'
				)
			)
		).toBe('\\frac{a}{b}');
		expect(ommlToLatex(omml('<m:rad><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>'))).toBe(
			'\\sqrt{x}'
		);
		expect(
			ommlToLatex(
				omml(
					'<m:sSub><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>0</m:t></m:r></m:sub></m:sSub>'
				)
			)
		).toBe('x_{0}');
		expect(ommlToLatex(omml('<m:d><m:e><m:r><m:t>y</m:t></m:r></m:e></m:d>'))).toBe('(y)');
	});

	it('converts combined sub/superscripts, degrees, custom delimiters, and functions', () => {
		expect(
			ommlToLatex(
				omml(
					'<m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e>' +
						'<m:sub><m:r><m:t>1</m:t></m:r></m:sub><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSubSup>'
				)
			)
		).toBe('x_{1}^{2}');
		expect(
			ommlToLatex(
				omml(
					'<m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>'
				)
			)
		).toBe('\\sqrt[3]{x}');
		expect(
			ommlToLatex(
				omml(
					'<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr>' +
						'<m:e><m:r><m:t>a</m:t></m:r></m:e><m:e><m:r><m:t>b</m:t></m:r></m:e></m:d>'
				)
			)
		).toBe('[a, b]');
		expect(
			ommlToLatex(
				omml(
					'<m:func><m:fName><m:r><m:t>sin</m:t></m:r></m:fName>' +
						'<m:e><m:r><m:t>x</m:t></m:r></m:e></m:func>'
				)
			)
		).toBe('sin x');
		expect(ommlToLatex(omml('<m:bar><m:e><m:r><m:t>z</m:t></m:r></m:e></m:bar>'))).toBe('\\bar{z}');
	});

	it('defaults the n-ary operator to an integral and skips property containers', () => {
		expect(
			ommlToLatex(
				omml(
					'<m:nary><m:sub><m:r><m:t>0</m:t></m:r></m:sub>' +
						'<m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>f</m:t></m:r></m:e></m:nary>'
				)
			)
		).toBe('\\int_{0} f');
	});

	it('degrades gracefully when structures are missing their children', () => {
		expect(ommlToLatex(omml('<m:f/>'))).toBe('\\frac{}{}');
		expect(ommlToLatex(omml('<m:sSup/>'))).toBe('^{}');
		expect(ommlToLatex(omml('<m:sSub/>'))).toBe('_{}');
		expect(ommlToLatex(omml('<m:sSubSup/>'))).toBe('_{}^{}');
		expect(ommlToLatex(omml('<m:rad/>'))).toBe('\\sqrt{}');
		expect(ommlToLatex(omml('<m:d/>'))).toBe('()');
		expect(ommlToLatex(omml('<m:nary><m:naryPr/></m:nary>'))).toBe('\\int');
		expect(ommlToLatex(omml('<m:func/>'))).toBe('');
		expect(ommlToLatex(omml('<m:bar/>'))).toBe('\\bar{}');
		expect(ommlToLatex(omml('<m:r/>'))).toBe('');
	});

	it('maps n-ary operators with bounds', () => {
		expect(
			ommlToLatex(
				omml(
					'<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr>' +
						'<m:sub><m:r><m:t>i=1</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup>' +
						'<m:e><m:r><m:t>i</m:t></m:r></m:e></m:nary>'
				)
			)
		).toBe('\\sum_{i=1}^{n} i');
	});
});

const DOCUMENT_XML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
  <w:body>
    <w:p><w:r><w:t>Here comes an equation.</w:t></w:r></w:p>
    <w:p><m:oMathPara><m:oMath><m:r><m:t>𝐸=𝑚</m:t></m:r><m:sSup><m:e><m:r><m:t>𝑐</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>
    <w:p><w:r><w:t>Now a diagram.</w:t></w:r></w:p>
    <w:p><w:r><w:drawing>
      <wps:txbx><w:txbxContent><w:p><w:r><w:t>First box</w:t></w:r></w:p></w:txbxContent></wps:txbx>
      <wps:txbx><w:txbxContent><w:p><w:r><w:t>Second box</w:t></w:r></w:p></w:txbxContent></wps:txbx>
    </w:drawing></w:r></w:p>
  </w:body>
</w:document>`;

describe('document.xml extras', () => {
	it('collects math and drawings in order with preceding-text anchors', () => {
		const extras = docxExtrasFromXml(DOCUMENT_XML);
		expect(extras).toEqual([
			{ type: 'math', latex: 'E=mc^{2}', anchorText: 'Here comes an equation.' },
			{ type: 'drawing', labels: ['First box', 'Second box'], anchorText: 'Now a diagram.' }
		]);
	});

	it('does not treat drawing text-box paragraphs as flow anchors', () => {
		const extras = docxExtrasFromXml(DOCUMENT_XML);
		expect(extras.every((extra) => !extra.anchorText.includes('box'))).toBe(true);
	});

	it('anchors document-leading math to the start and ignores empty drawings', () => {
		const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    <w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>
    <w:p><w:r><w:drawing/></w:r></w:p>
  </w:body>
</w:document>`;
		expect(docxExtrasFromXml(xml)).toEqual([{ type: 'math', latex: 'x', anchorText: '' }]);
	});
});

/** A single-entry zip with a STORED (uncompressed) file, built by hand. */
function storedZip(name: string, content: string): Uint8Array {
	const encoder = new TextEncoder();
	const nameBytes = encoder.encode(name);
	const data = encoder.encode(content);
	const local = new Uint8Array(30 + nameBytes.length + data.length);
	const localView = new DataView(local.buffer);
	localView.setUint32(0, 0x04034b50, true);
	localView.setUint16(8, 0, true); // stored
	localView.setUint32(18, data.length, true);
	localView.setUint32(22, data.length, true);
	localView.setUint16(26, nameBytes.length, true);
	local.set(nameBytes, 30);
	local.set(data, 30 + nameBytes.length);
	const central = new Uint8Array(46 + nameBytes.length);
	const centralView = new DataView(central.buffer);
	centralView.setUint32(0, 0x02014b50, true);
	centralView.setUint16(10, 0, true);
	centralView.setUint32(20, data.length, true);
	centralView.setUint32(24, data.length, true);
	centralView.setUint16(28, nameBytes.length, true);
	centralView.setUint32(42, 0, true);
	central.set(nameBytes, 46);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(8, 1, true);
	eocdView.setUint16(10, 1, true);
	eocdView.setUint32(12, central.length, true);
	eocdView.setUint32(16, local.length, true);
	const zip = new Uint8Array(local.length + central.length + eocd.length);
	zip.set(local, 0);
	zip.set(central, local.length);
	zip.set(eocd, local.length + central.length);
	return zip;
}

describe('zip entry reader', () => {
	it('reads a stored entry by path and misses others gracefully', async () => {
		const zip = storedZip('word/document.xml', '<w:document/>');
		const entry = await readZipEntry(zip, 'word/document.xml');
		expect(new TextDecoder().decode(entry!)).toBe('<w:document/>');
		expect(await readZipEntry(zip, 'word/missing.xml')).toBeNull();
		expect(await readZipEntry(new Uint8Array([1, 2, 3]), 'anything')).toBeNull();
	});

	it('refuses unsupported compression methods and corrupt directories', async () => {
		const unsupported = storedZip('word/document.xml', 'x');
		// Rewrite the central-directory compression method to an unknown value.
		const view = new DataView(unsupported.buffer);
		const central = unsupported.length - 22 - (46 + 'word/document.xml'.length);
		view.setUint16(central + 10, 12, true);
		expect(await readZipEntry(unsupported, 'word/document.xml')).toBeNull();

		const corrupt = storedZip('word/document.xml', 'x');
		new DataView(corrupt.buffer).setUint32(central, 0xdeadbeef, true);
		expect(await readZipEntry(corrupt, 'word/document.xml')).toBeNull();
	});
});

describe('degenerate documents', () => {
	it('returns nothing for a document without a body or with nested math', () => {
		expect(docxExtrasFromXml('<w:document xmlns:w="ns"/>')).toEqual([]);
		const nested = `<w:document xmlns:w="a" xmlns:m="b"><w:body>
			<w:p><m:oMath><m:d><m:e><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></m:e></m:d></m:oMath></w:p>
		</w:body></w:document>`;
		// The inner oMath converts as part of the outer one, not twice.
		expect(docxExtrasFromXml(nested)).toHaveLength(1);
	});
});
