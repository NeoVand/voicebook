import type { Mermaid } from 'mermaid';

let mermaidPromise: Promise<Mermaid> | undefined;
let diagramSequence = 0;

async function loadMermaid(): Promise<Mermaid> {
	mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
		mermaid.initialize({
			startOnLoad: false,
			securityLevel: 'strict',
			suppressErrorRendering: true,
			theme: 'base',
			fontFamily: 'Inter Variable, Inter, ui-sans-serif, system-ui, sans-serif',
			flowchart: { htmlLabels: false, useMaxWidth: false },
			sequence: { useMaxWidth: false },
			themeVariables: {
				background: '#18191d',
				mainBkg: '#25262c',
				primaryColor: '#25262c',
				primaryTextColor: '#f4f4f2',
				primaryBorderColor: '#716aa6',
				secondaryColor: '#302d45',
				secondaryTextColor: '#f4f4f2',
				secondaryBorderColor: '#9188d4',
				tertiaryColor: '#1d1e23',
				tertiaryTextColor: '#d6d6d2',
				tertiaryBorderColor: '#4a4c55',
				lineColor: '#aaa2e3',
				textColor: '#f4f4f2',
				noteBkgColor: '#29261f',
				noteTextColor: '#f4f4f2',
				noteBorderColor: '#9b7e4d',
				actorBkg: '#25262c',
				actorBorder: '#716aa6',
				actorTextColor: '#f4f4f2',
				actorLineColor: '#666875',
				signalColor: '#d6d6d2',
				signalTextColor: '#f4f4f2',
				labelBoxBkgColor: '#25262c',
				labelBoxBorderColor: '#716aa6',
				labelTextColor: '#f4f4f2',
				loopTextColor: '#d6d6d2',
				activationBorderColor: '#9188d4',
				activationBkgColor: '#302d45',
				fontSize: '15px'
			}
		});
		return mermaid;
	});
	return mermaidPromise;
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

export async function renderMermaid(source: string, container: HTMLElement): Promise<void> {
	const mermaid = await loadMermaid();
	const renderSource = await sourceForRendering(mermaid, source);

	diagramSequence += 1;
	const renderId = `voicebook-mermaid-${diagramSequence}`;
	const { svg } = await mermaid.render(renderId, renderSource, container);
	const parsed = parseSvg(svg);
	parsed.classList.add('voicebook-mermaid-svg');
	parsed.setAttribute('role', 'img');
	if (!parsed.hasAttribute('aria-labelledby')) parsed.setAttribute('aria-label', 'Mermaid diagram');
	parsed.removeAttribute('height');
	parsed.style.maxWidth = 'none';
	parsed.style.backgroundColor = 'transparent';
	container.replaceChildren(document.importNode(parsed, true));
}
