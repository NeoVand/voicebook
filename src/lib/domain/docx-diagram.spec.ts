import { DOMParser } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { diagramSvg } from './docx-diagram';

beforeAll(() => {
	Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
});

function paragraph(inner: string): Element {
	const xml = `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
		xmlns:v="urn:schemas-microsoft-com:vml"
		xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
		xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
		xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${inner}</w:p>`;
	return new DOMParser().parseFromString(xml, 'text/xml').documentElement as unknown as Element;
}

const VML_GROUP = `<w:pict><v:group style="width:200pt;height:100pt" coordorigin="0,0" coordsize="400,200">
	<v:roundrect style="position:absolute;left:10;top:20;width:120;height:60" arcsize="18%" fillcolor="#E8F1FB" strokecolor="#2F5597" strokeweight="1.25pt">
		<v:textbox><w:txbxContent><w:p><w:r><w:rPr><w:b/><w:sz w:val="18"/></w:rPr><w:t>alpha</w:t><w:br/><w:t>&amp;beta</w:t></w:r></w:p></w:txbxContent></v:textbox>
	</v:roundrect>
	<v:line from="130,50" to="220,50" strokecolor="#5B6573" strokeweight="1.5pt"><v:stroke endarrow="block"/></v:line>
	<v:rect style="position:absolute;left:240;top:20;width:100;height:60" filled="f" stroked="f">
		<v:textbox><w:txbxContent><w:p><w:r><w:t>gamma</w:t></w:r></w:p></w:txbxContent></v:textbox>
	</v:rect>
</v:group></w:pict>`;

describe('VML diagrams', () => {
	it('renders rounded boxes, arrowed connectors, and multi-line labels', () => {
		const svg = diagramSvg(paragraph(VML_GROUP))!;
		expect(svg).toContain('viewBox=');
		// Rounded rect with a corner radius from arcsize 18% of the short side.
		expect(svg).toContain('rx="10.8"');
		expect(svg).toContain('fill="#E8F1FB"');
		expect(svg).toContain('stroke="#2F5597"');
		// The connector carries an arrowhead marker of its own color.
		expect(svg).toContain('marker-end="url(#arrow0)"');
		expect(svg).toContain('fill="#5B6573"');
		// Manual break produces two centered tspans; XML entities are escaped.
		expect(svg).toContain('>alpha</tspan>');
		expect(svg).toContain('>&amp;beta</tspan>');
		expect(svg).toContain('>gamma</tspan>');
		expect(svg).toContain('font-weight="600"');
		// White canvas backing keeps authored colors readable on dark themes.
		expect(svg).toContain('fill="#FFFFFF"');
	});

	it('returns null when no shape carries a label', () => {
		const svg = diagramSvg(
			paragraph(
				'<w:pict><v:group style="width:100pt;height:50pt" coordsize="200,100">' +
					'<v:rect style="left:0;top:0;width:50;height:20"/></v:group></w:pict>'
			)
		);
		expect(svg).toBeNull();
	});

	it('returns null without a recognizable container', () => {
		expect(diagramSvg(paragraph('<w:r><w:t>plain text</w:t></w:r>'))).toBeNull();
	});
});

const DRAWING_GROUP = `<w:drawing><wpg:wgp>
	<wpg:grpSpPr><a:xfrm>
		<a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/>
		<a:chOff x="0" y="0"/><a:chExt cx="1905000" cy="952500"/>
	</a:xfrm></wpg:grpSpPr>
	<wps:wsp>
		<wps:spPr>
			<a:xfrm><a:off x="0" y="0"/><a:ext cx="762000" cy="381000"/></a:xfrm>
			<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>
		</wps:spPr>
		<wps:style>
			<a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef>
			<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>
			<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>
		</wps:style>
		<wps:txbx><w:txbxContent><w:p><w:r><w:t>node</w:t></w:r></w:p></w:txbxContent></wps:txbx>
	</wps:wsp>
	<wps:wsp>
		<wps:spPr>
			<a:xfrm flipV="1"><a:off x="762000" y="190500"/><a:ext cx="381000" cy="190500"/></a:xfrm>
			<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
			<a:ln><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>
		</wps:spPr>
	</wps:wsp>
</wpg:wgp></w:drawing>`;

describe('DrawingML diagrams', () => {
	it('renders theme-colored shapes and flipped connectors from EMU geometry', () => {
		const svg = diagramSvg(paragraph(DRAWING_GROUP))!;
		// Office default accent1 fill with light (white) label text.
		expect(svg).toContain('fill="#4472C4"');
		expect(svg).toContain('fill="#FFFFFF"');
		expect(svg).toContain('>node</tspan>');
		// flipV connector runs bottom-left to top-right in red.
		expect(svg).toContain('stroke="#FF0000"');
		expect(svg).toContain('y1="381000"');
		expect(svg).toContain('y2="190500"');
	});
});
