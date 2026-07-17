import { DOMParser } from 'linkedom';
import { beforeAll, describe, expect, it } from 'vitest';
import { diagramModel } from './docx-diagram';

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
		<v:textbox><w:txbxContent><w:p><w:r><w:rPr><w:b/><w:sz w:val="18"/></w:rPr><w:t>alpha</w:t><w:br/><w:t>beta</w:t></w:r></w:p></w:txbxContent></v:textbox>
	</v:roundrect>
	<v:line from="130,50" to="220,50" strokecolor="#5B6573" strokeweight="1.5pt"><v:stroke endarrow="block"/></v:line>
	<v:rect style="position:absolute;left:240;top:20;width:100;height:60" filled="f" stroked="f">
		<v:textbox><w:txbxContent><w:p><w:r><w:t>gamma</w:t></w:r></w:p></w:txbxContent></v:textbox>
	</v:rect>
</v:group></w:pict>`;

describe('VML diagrams', () => {
	it('models rounded boxes, arrowed connectors, and multi-line labels', () => {
		const diagram = diagramModel(paragraph(VML_GROUP))!;
		expect(diagram.viewBox).toEqual({ x: 0, y: 0, width: 400, height: 200 });
		// 200pt × 100pt at 96dpi.
		expect(diagram.pixelWidth).toBe(267);
		expect(diagram.pixelHeight).toBe(133);
		expect(diagram.boxes[0]).toMatchObject({
			shape: 'round',
			x: 10,
			y: 20,
			width: 120,
			height: 60,
			fill: '#E8F1FB',
			stroke: '#2F5597',
			// arcsize 18% of the short side.
			cornerRadius: expect.closeTo(10.8, 5),
			lines: ['alpha', 'beta'],
			bold: true,
			// sz 18 half-points = 9pt, at 2 units per pt.
			fontSize: 18
		});
		// The invisible label container keeps its text but draws no shape.
		expect(diagram.boxes[1]).toMatchObject({ fill: 'none', stroke: 'none', lines: ['gamma'] });
		expect(diagram.connectors[0]).toMatchObject({
			x1: 130,
			y1: 50,
			x2: 220,
			y2: 50,
			arrow: true
		});
	});

	it('returns null when no shape carries a label', () => {
		const diagram = diagramModel(
			paragraph(
				'<w:pict><v:group style="width:100pt;height:50pt" coordsize="200,100">' +
					'<v:rect style="left:0;top:0;width:50;height:20"/></v:group></w:pict>'
			)
		);
		expect(diagram).toBeNull();
	});

	it('returns null without a recognizable container', () => {
		expect(diagramModel(paragraph('<w:r><w:t>plain text</w:t></w:r>'))).toBeNull();
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
	it('models theme-colored shapes and flipped connectors from EMU geometry', () => {
		const diagram = diagramModel(paragraph(DRAWING_GROUP))!;
		expect(diagram.viewBox).toEqual({ x: 0, y: 0, width: 1905000, height: 952500 });
		expect(diagram.boxes[0]).toMatchObject({
			shape: 'round',
			// Office default accent1 fill with light (white) label text.
			fill: '#4472C4',
			fontColor: '#FFFFFF',
			lines: ['node']
		});
		// flipV connector runs bottom-left to top-right.
		expect(diagram.connectors[0]).toMatchObject({
			x1: 762000,
			y1: 381000,
			x2: 1143000,
			y2: 190500,
			arrow: true
		});
	});
});
