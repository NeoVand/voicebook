import type { Mermaid } from 'mermaid';

let mermaidPromise: Promise<Mermaid> | undefined;
let diagramSequence = 0;
let renderQueue: Promise<void> = Promise.resolve();

async function loadMermaid(): Promise<Mermaid> {
	mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => mermaid);
	return mermaidPromise;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
	return style.getPropertyValue(name).trim() || fallback;
}

function initializeForContainer(mermaid: Mermaid, container: HTMLElement): void {
	const style = getComputedStyle(container);
	const background = token(style, '--reader', '#18191d');
	const node = token(style, '--diagram-node', '#25262c');
	const nodeAlt = token(style, '--diagram-node-alt', '#302d45');
	const nodeMuted = token(style, '--diagram-node-muted', '#1d1e23');
	const border = token(style, '--diagram-border', '#716aa6');
	const borderAlt = token(style, '--diagram-border-alt', '#9188d4');
	const line = token(style, '--diagram-line', '#aaa2e3');
	const text = token(style, '--diagram-text', '#f4f4f2');
	const quiet = token(style, '--reader-quiet', '#8f919b');
	const note = token(style, '--diagram-note', '#29261f');
	const noteBorder = token(style, '--diagram-note-border', '#9b7e4d');

	mermaid.initialize({
		startOnLoad: false,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		theme: 'base',
		fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif',
		flowchart: { htmlLabels: false, useMaxWidth: false },
		sequence: { useMaxWidth: false },
		themeVariables: {
			background,
			mainBkg: node,
			primaryColor: node,
			primaryTextColor: text,
			primaryBorderColor: border,
			secondaryColor: nodeAlt,
			secondaryTextColor: text,
			secondaryBorderColor: borderAlt,
			tertiaryColor: nodeMuted,
			tertiaryTextColor: text,
			tertiaryBorderColor: quiet,
			lineColor: line,
			textColor: text,
			noteBkgColor: note,
			noteTextColor: text,
			noteBorderColor: noteBorder,
			actorBkg: node,
			actorBorder: border,
			actorTextColor: text,
			actorLineColor: quiet,
			signalColor: line,
			signalTextColor: text,
			labelBoxBkgColor: node,
			labelBoxBorderColor: border,
			labelTextColor: text,
			loopTextColor: text,
			activationBorderColor: borderAlt,
			activationBkgColor: nodeAlt,
			fontSize: '15px'
		}
	});
}

function parseSvg(svg: string): SVGSVGElement {
	const document = new DOMParser().parseFromString(svg, 'text/html');
	const element = document.querySelector('svg');
	if (!(element instanceof SVGSVGElement)) {
		throw new Error('Mermaid did not return an SVG diagram.');
	}

	for (const unsafe of element.querySelectorAll('script, iframe, object, embed')) unsafe.remove();
	for (const descendant of [element, ...element.querySelectorAll('*')]) {
		for (const attribute of [...descendant.attributes]) {
			if (attribute.name.toLowerCase().startsWith('on')) descendant.removeAttribute(attribute.name);
			if (
				['href', 'xlink:href'].includes(attribute.name.toLowerCase()) &&
				!attribute.value.startsWith('#')
			) {
				descendant.removeAttribute(attribute.name);
			}
		}
	}
	const theme = document.createElementNS('http://www.w3.org/2000/svg', 'style');
	theme.textContent = `
		.node rect, .node circle, .node ellipse, .node polygon, .node path,
		.actor, .labelBox, .cluster rect { fill: var(--diagram-node) !important; stroke: var(--diagram-border) !important; }
		.edgePath path, .flowchart-link, .messageLine0, .messageLine1, .actor-line,
		.relation, .transition { stroke: var(--diagram-line) !important; }
		marker path { fill: var(--diagram-line) !important; stroke: var(--diagram-line) !important; }
		text, .label, .messageText, .loopText, .labelText, .actor > text,
		.nodeLabel, .edgeLabel { fill: var(--diagram-text) !important; color: var(--diagram-text) !important; }
		.note { fill: var(--diagram-note) !important; stroke: var(--diagram-note-border) !important; }
		.noteText { fill: var(--diagram-text) !important; }
		.activation0, .activation1, .activation2 { fill: var(--diagram-node-alt) !important; stroke: var(--diagram-border-alt) !important; }
	`;
	element.append(theme);
	return element;
}

export function sequenceDiagramCompatibilitySource(source: string): string {
	if (!/^\s*sequenceDiagram\b/m.test(source)) return source;
	return source
		.split('\n')
		.map((line) => {
			const colon = line.indexOf(':');
			if (colon < 0) return line;
			const statement = line.slice(0, colon);
			if (!statement.includes('->') && !/^\s*Note\b/i.test(statement)) return line;
			return `${line.slice(0, colon + 1)}${line.slice(colon + 1).replaceAll(';', '#59;')}`;
		})
		.join('\n');
}

async function sourceForRendering(mermaid: Mermaid, source: string): Promise<string> {
	if (await mermaid.parse(source, { suppressErrors: true })) return source;
	const compatible = sequenceDiagramCompatibilitySource(source);
	if (compatible !== source && (await mermaid.parse(compatible, { suppressErrors: true }))) {
		return compatible;
	}
	throw new Error('The Mermaid syntax is incomplete or invalid.');
}

export function renderMermaid(source: string, container: HTMLElement): Promise<void> {
	const render = renderQueue
		.catch(() => undefined)
		.then(async () => {
			const mermaid = await loadMermaid();
			initializeForContainer(mermaid, container);
			const renderSource = await sourceForRendering(mermaid, source);

			diagramSequence += 1;
			const renderId = `voicebook-mermaid-${diagramSequence}`;
			const { svg } = await mermaid.render(renderId, renderSource, container);
			const parsed = parseSvg(svg);
			parsed.classList.add('voicebook-mermaid-svg');
			parsed.setAttribute('role', 'img');
			if (!parsed.hasAttribute('aria-labelledby'))
				parsed.setAttribute('aria-label', 'Mermaid diagram');
			parsed.removeAttribute('height');
			parsed.style.maxWidth = 'none';
			parsed.style.backgroundColor = 'transparent';
			container.replaceChildren(document.importNode(parsed, true));
		});
	renderQueue = render.then(
		() => undefined,
		() => undefined
	);
	return render;
}
