import { describe, expect, it } from 'vitest';
import type { DocumentBlock, OutlineEntry } from './types';
import { breadcrumbFor, outlineText, type DocumentLensSource } from './document-lens';

function block(id: string): DocumentBlock {
	return { id, kind: 'paragraph', text: id, speak: true, anchor: {} };
}

function entry(id: string, blockId: string, title: string, level: number): OutlineEntry {
	return { id, blockId, title, level };
}

function source(): DocumentLensSource {
	return {
		title: 'Deep Oceans',
		blocks: ['h1', 'p1', 'h2', 'p2', 'h2b', 'p3'].map(block),
		outline: [
			entry('o1', 'h1', 'The Midnight Zone', 1),
			entry('o2', 'h2', 'Bioluminescence', 2),
			entry('o3', 'h2b', 'Hydrothermal Vents', 2)
		]
	};
}

describe('breadcrumbFor', () => {
	it('stacks the outline levels above the block', () => {
		expect(breadcrumbFor(source(), 'p2')).toBe('Deep Oceans › The Midnight Zone › Bioluminescence');
	});

	it('replaces siblings at the same level instead of nesting them', () => {
		expect(breadcrumbFor(source(), 'p3')).toBe(
			'Deep Oceans › The Midnight Zone › Hydrothermal Vents'
		);
	});

	it('falls back to the title before any heading or for unknown blocks', () => {
		expect(breadcrumbFor({ ...source(), outline: [] }, 'p1')).toBe('Deep Oceans');
		expect(breadcrumbFor(source(), 'missing')).toBe('Deep Oceans');
	});
});

describe('outlineText', () => {
	it('indents by level and caps the entry count', () => {
		expect(outlineText(source())).toBe(
			'- The Midnight Zone\n  - Bioluminescence\n  - Hydrothermal Vents'
		);
		expect(outlineText(source(), 2)).toBe(
			'- The Midnight Zone\n  - Bioluminescence\n(+1 more sections)'
		);
	});

	it('returns an empty string without an outline', () => {
		expect(outlineText({ ...source(), outline: [] })).toBe('');
	});
});
