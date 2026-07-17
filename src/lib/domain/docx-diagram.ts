/**
 * Structured geometry for the diagrams Word documents draw with shapes.
 * Both dialects carry real coordinates — legacy VML (v:group/v:roundrect/
 * v:line) and DrawingML wordprocessingGroup (wps:wsp with EMU transforms) —
 * so the reader can draw the actual boxes, arrows, and labels as theme-aware
 * inline SVG instead of showing a caption. Box fills and strokes keep their
 * authored colors; connectors and floating labels take the reader theme's
 * ink at render time. Anything unrecognized degrades to null and the
 * caption-only path stands in.
 */
import { descendants } from './docx-extras';
import type { DiagramBox, DiagramConnector, DocumentDiagram } from './types';

const PX_PER_PT = 96 / 72;
const EMU_PER_PX = 9525;

/** Office default theme accents — precise enough for shape fills without
 * dragging theme1.xml parsing in. */
const SCHEME_COLORS: Record<string, string> = {
	accent1: '#4472C4',
	accent2: '#ED7D31',
	accent3: '#A5A5A5',
	accent4: '#FFC000',
	accent5: '#5B9BD5',
	accent6: '#70AD47',
	lt1: '#FFFFFF',
	lt2: '#E7E6E6',
	dk1: '#000000',
	dk2: '#44546A'
};

/** Text lines inside a shape's text box, with manual breaks preserved. */
function textBoxLines(shape: Element): { lines: string[]; bold: boolean; sizePt: number } {
	const lines: string[] = [];
	let bold = false;
	let sizePt = 10;
	for (const content of descendants(shape, 'w:txbxContent')) {
		for (const paragraph of descendants(content, 'w:p')) {
			let line = '';
			const visit = (node: Element) => {
				if (node.tagName === 'w:t') line += node.textContent ?? '';
				else if (node.tagName === 'w:br' || node.tagName === 'w:cr') {
					if (line.trim()) lines.push(line.trim());
					line = '';
				} else if (node.tagName === 'w:b') bold = true;
				else if (node.tagName === 'w:sz') {
					const half = Number(node.getAttribute('w:val'));
					if (Number.isFinite(half) && half > 0) sizePt = half / 2;
				}
				for (const next of Array.from(node.children)) visit(next);
			};
			visit(paragraph);
			if (line.trim()) lines.push(line.trim());
		}
	}
	return { lines, bold, sizePt };
}

/* ── Legacy VML (v:group / v:roundrect / v:line) ────────────────────────── */

function vmlStyle(element: Element): Record<string, string> {
	const style: Record<string, string> = {};
	for (const part of (element.getAttribute('style') ?? '').split(';')) {
		const [key, value] = part.split(':');
		if (key && value) style[key.trim()] = value.trim();
	}
	return style;
}

function points(value: string | null): number {
	if (!value) return 0;
	return Number.parseFloat(value);
}

/** VML arc size: "18%", "0.18", or "11796f" (fraction of 65536) — all mean a
 * corner radius fraction of the smaller side. */
function arcFraction(value: string | null): number {
	if (!value) return 0.15;
	const number = Number.parseFloat(value);
	if (!Number.isFinite(number)) return 0.15;
	if (value.trim().endsWith('%')) return number / 100;
	if (value.trim().endsWith('f')) return number / 65536;
	return number > 1 ? number / 100 : number;
}

function vmlDiagram(container: Element): DocumentDiagram | null {
	const group = descendants(container, 'v:group')[0];
	if (!group) return null;
	const style = vmlStyle(group);
	const [originX, originY] = (group.getAttribute('coordorigin') ?? '0,0')
		.split(',')
		.map((value) => Number.parseFloat(value) || 0);
	const [sizeWidth, sizeHeight] = (group.getAttribute('coordsize') ?? '')
		.split(',')
		.map((value) => Number.parseFloat(value));
	const widthPt = points(style.width);
	const heightPt = points(style.height);
	if (!sizeWidth || !sizeHeight || !widthPt || !heightPt) return null;
	const unitsPerPt = sizeWidth / widthPt;

	const boxes: DiagramBox[] = [];
	const connectors: DiagramConnector[] = [];
	const walk = (element: Element) => {
		for (const shape of Array.from(element.children)) {
			const tag = shape.tagName;
			if (tag === 'v:roundrect' || tag === 'v:rect' || tag === 'v:oval') {
				const shapeStyle = vmlStyle(shape);
				const width = Number.parseFloat(shapeStyle.width ?? '0');
				const height = Number.parseFloat(shapeStyle.height ?? '0');
				if (!width || !height) continue;
				const filled = shape.getAttribute('filled') !== 'f';
				const stroked = shape.getAttribute('stroked') !== 'f';
				const arc = arcFraction(shape.getAttribute('arcsize'));
				const text = textBoxLines(shape);
				boxes.push({
					shape: tag === 'v:oval' ? 'ellipse' : tag === 'v:roundrect' ? 'round' : 'rect',
					x: Number.parseFloat(shapeStyle.left ?? '0') || 0,
					y: Number.parseFloat(shapeStyle.top ?? '0') || 0,
					width,
					height,
					fill: filled ? (shape.getAttribute('fillcolor') ?? '#FFFFFF') : 'none',
					stroke: stroked ? (shape.getAttribute('strokecolor') ?? '#000000') : 'none',
					strokeWidth: stroked ? (points(shape.getAttribute('strokeweight')) || 1) * unitsPerPt : 0,
					cornerRadius: tag === 'v:roundrect' ? Math.min(width, height) * arc : 0,
					lines: text.lines,
					fontSize: text.sizePt * unitsPerPt,
					fontColor: '#24292F',
					bold: text.bold
				});
			} else if (tag === 'v:line') {
				const [x1, y1] = (shape.getAttribute('from') ?? '0,0').split(',').map(Number);
				const [x2, y2] = (shape.getAttribute('to') ?? '0,0').split(',').map(Number);
				connectors.push({
					x1,
					y1,
					x2,
					y2,
					strokeWidth: (points(shape.getAttribute('strokeweight')) || 1) * unitsPerPt,
					arrow: descendants(shape, 'v:stroke').some((stroke) => stroke.getAttribute('endarrow'))
				});
			} else {
				walk(shape);
			}
		}
	};
	walk(group);
	if (!boxes.length && !connectors.length) return null;
	return {
		viewBox: { x: originX, y: originY, width: sizeWidth, height: sizeHeight },
		pixelWidth: Math.round(widthPt * PX_PER_PT),
		pixelHeight: Math.round(heightPt * PX_PER_PT),
		boxes,
		connectors
	};
}

/* ── DrawingML wordprocessingGroup (wps:wsp) ────────────────────────────── */

function drawingColor(scope: Element | undefined, fallback: string): string {
	if (!scope) return fallback;
	const srgb = descendants(scope, 'a:srgbClr')[0]?.getAttribute('val');
	if (srgb) return `#${srgb}`;
	const scheme = descendants(scope, 'a:schemeClr')[0]?.getAttribute('val');
	if (scheme && SCHEME_COLORS[scheme]) return SCHEME_COLORS[scheme];
	return fallback;
}

function xfrmRect(scope: Element): { x: number; y: number; w: number; h: number } | null {
	const xfrm = descendants(scope, 'a:xfrm')[0];
	if (!xfrm) return null;
	const off = descendants(xfrm, 'a:off')[0];
	const ext = descendants(xfrm, 'a:ext')[0];
	if (!off || !ext) return null;
	return {
		x: Number(off.getAttribute('x')) || 0,
		y: Number(off.getAttribute('y')) || 0,
		w: Number(ext.getAttribute('cx')) || 0,
		h: Number(ext.getAttribute('cy')) || 0
	};
}

function drawingDiagram(container: Element): DocumentDiagram | null {
	const shapes = descendants(container, 'wps:wsp');
	if (!shapes.length) return null;
	// The group's child extent defines the coordinate space; without a group,
	// bounds come from the shapes themselves.
	const groupTransform = descendants(container, 'wpg:grpSpPr')[0];
	let viewBox = { x: 0, y: 0, width: 0, height: 0 };
	if (groupTransform) {
		const xfrm = descendants(groupTransform, 'a:xfrm')[0];
		const chOff = xfrm ? descendants(xfrm, 'a:chOff')[0] : undefined;
		const chExt = xfrm ? descendants(xfrm, 'a:chExt')[0] : undefined;
		if (chOff && chExt) {
			viewBox = {
				x: Number(chOff.getAttribute('x')) || 0,
				y: Number(chOff.getAttribute('y')) || 0,
				width: Number(chExt.getAttribute('cx')) || 0,
				height: Number(chExt.getAttribute('cy')) || 0
			};
		}
	}

	const boxes: DiagramBox[] = [];
	const connectors: DiagramConnector[] = [];
	for (const shape of shapes) {
		const properties = descendants(shape, 'wps:spPr')[0];
		if (!properties) continue;
		const rect = xfrmRect(properties);
		if (!rect || (!rect.w && !rect.h)) continue;
		const geometry = descendants(properties, 'a:prstGeom')[0]?.getAttribute('prst') ?? 'rect';
		const styleRef = descendants(shape, 'wps:style')[0];
		if (/connector|line/i.test(geometry)) {
			const xfrm = descendants(properties, 'a:xfrm')[0];
			const flipH = xfrm?.getAttribute('flipH') === '1';
			const flipV = xfrm?.getAttribute('flipV') === '1';
			connectors.push({
				x1: flipH ? rect.x + rect.w : rect.x,
				y1: flipV ? rect.y + rect.h : rect.y,
				x2: flipH ? rect.x : rect.x + rect.w,
				y2: flipV ? rect.y : rect.y + rect.h,
				strokeWidth: 1.5 * EMU_PER_PX,
				arrow: true
			});
			continue;
		}
		const text = textBoxLines(shape);
		const fillScope =
			descendants(properties, 'a:solidFill')[0] ??
			(styleRef ? descendants(styleRef, 'a:fillRef')[0] : undefined);
		const lineScope =
			descendants(properties, 'a:ln')[0] ??
			(styleRef ? descendants(styleRef, 'a:lnRef')[0] : undefined);
		const fontScope = styleRef ? descendants(styleRef, 'a:fontRef')[0] : undefined;
		boxes.push({
			shape: geometry === 'ellipse' ? 'ellipse' : geometry === 'roundRect' ? 'round' : 'rect',
			x: rect.x,
			y: rect.y,
			width: rect.w,
			height: rect.h,
			fill: drawingColor(fillScope, '#FFFFFF'),
			stroke: drawingColor(lineScope, '#44546A'),
			strokeWidth: EMU_PER_PX,
			cornerRadius: geometry === 'roundRect' ? Math.min(rect.w, rect.h) * 0.16 : 0,
			lines: text.lines,
			fontSize: text.sizePt * (EMU_PER_PX * PX_PER_PT),
			fontColor: drawingColor(fontScope, '#FFFFFF'),
			bold: text.bold
		});
	}
	if (!boxes.length && !connectors.length) return null;
	if (!viewBox.width || !viewBox.height) {
		const xs = [...boxes, ...connectors].flatMap((entry) =>
			'width' in entry ? [entry.x, entry.x + entry.width] : [entry.x1, entry.x2]
		);
		const ys = [...boxes, ...connectors].flatMap((entry) =>
			'height' in entry ? [entry.y, entry.y + entry.height] : [entry.y1, entry.y2]
		);
		viewBox = {
			x: Math.min(...xs),
			y: Math.min(...ys),
			width: Math.max(...xs) - Math.min(...xs),
			height: Math.max(...ys) - Math.min(...ys)
		};
	}
	if (!viewBox.width || !viewBox.height) return null;
	return {
		viewBox,
		pixelWidth: Math.round(viewBox.width / EMU_PER_PX),
		pixelHeight: Math.round(viewBox.height / EMU_PER_PX),
		boxes,
		connectors
	};
}

/** The paragraph's shape diagram as structured geometry, or null when it is
 * not something this parser understands. */
export function diagramModel(paragraph: Element): DocumentDiagram | null {
	const diagram = vmlDiagram(paragraph) ?? drawingDiagram(paragraph);
	if (!diagram) return null;
	// Boxes without any label anywhere usually mean decorative artwork
	// (pictures already flow through mammoth); only render labeled diagrams.
	if (!diagram.boxes.some((box) => box.lines.length)) return null;
	return diagram;
}
