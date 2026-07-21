import { describe, expect, it } from 'vitest';
import type { DocumentBlock } from './types';
import {
	backMatterAnnouncement,
	backMatterBlockIds,
	isBackMatterHeading,
	normalizeHeadingTitle
} from './back-matter';

function heading(id: string, text: string, level = 2): DocumentBlock {
	return { id, kind: 'heading', text, level, speak: true, anchor: {} };
}
function para(id: string, text = 'Body.'): DocumentBlock {
	return { id, kind: 'paragraph', text, speak: true, anchor: {} };
}

describe('isBackMatterHeading', () => {
	it('matches section titles, tolerating numbering and punctuation', () => {
		expect(isBackMatterHeading('References')).toBe(true);
		expect(isBackMatterHeading('7. References')).toBe(true);
		expect(isBackMatterHeading('IV. Bibliography')).toBe(true);
		expect(isBackMatterHeading('Acknowledgements:')).toBe(true);
		expect(isBackMatterHeading('Notes')).toBe(true);
	});

	it('leaves content sections that merely start with the word alone', () => {
		expect(isBackMatterHeading('Reference Implementation')).toBe(false);
		expect(isBackMatterHeading('Notes on Related Work')).toBe(false);
		expect(isBackMatterHeading('Introduction')).toBe(false);
	});

	it('normalizes headings for comparison', () => {
		expect(normalizeHeadingTitle('  3.  References. ')).toBe('references');
	});

	it('detects multi-level numbered headings', () => {
		expect(isBackMatterHeading('7.1 References')).toBe(true);
		expect(isBackMatterHeading('7.1. References')).toBe(true);
		expect(isBackMatterHeading('2.3.1 Notes')).toBe(true);
		expect(normalizeHeadingTitle('7.1 Bibliography')).toBe('bibliography');
	});
});

describe('backMatterBlockIds', () => {
	it('spans a references section to the end of the document', () => {
		const ids = backMatterBlockIds([
			heading('h0', 'Conclusion'),
			para('p0'),
			heading('h1', 'References'),
			para('r0'),
			para('r1')
		]);
		expect([...ids]).toEqual(['h1', 'r0', 'r1']);
	});

	it('closes at a following non-back-matter section of the same level', () => {
		const ids = backMatterBlockIds([
			heading('h1', 'References', 1),
			para('r0'),
			heading('h2', 'Appendix', 1),
			para('a0')
		]);
		expect(ids.has('r0')).toBe(true);
		expect(ids.has('h2')).toBe(false);
		expect(ids.has('a0')).toBe(false);
	});

	it('closes at a following non-back-matter heading even when it is deeper', () => {
		// A deeper "Appendix" after "References" is real content, not a subsection
		// of it — PDF/DOCX font-size heuristics can't be trusted to rank them, and
		// swallowing it would hide the rest of the document from playback.
		const ids = backMatterBlockIds([
			heading('h0', 'Conclusion', 1),
			para('p0'),
			heading('h1', 'References', 1),
			para('r0'),
			heading('h2', 'Appendix A', 2),
			para('a0'),
			para('a1')
		]);
		expect([...ids]).toEqual(['h1', 'r0']);
		expect(ids.has('h2')).toBe(false);
		expect(ids.has('a0')).toBe(false);
	});

	it('ends the section at a non-back-matter subheading (level-agnostic close)', () => {
		// The deliberate trade-off: a references section that carries its own
		// subheadings ends at the first one. Skipping a few fewer entries is far
		// cheaper than swallowing a following section and stalling playback.
		const ids = backMatterBlockIds([
			heading('h1', 'References', 1),
			heading('h2', 'Primary Sources', 2),
			para('r0')
		]);
		expect(ids.has('h1')).toBe(true);
		expect(ids.has('h2')).toBe(false);
		expect(ids.has('r0')).toBe(false);
	});

	it('merges adjacent back-matter sections (references then acknowledgements)', () => {
		const ids = backMatterBlockIds([
			heading('h1', 'References', 1),
			para('r0'),
			heading('h2', 'Acknowledgements', 1),
			para('a0')
		]);
		expect([...ids]).toEqual(['h1', 'r0', 'h2', 'a0']);
	});

	it('is empty for a document with no back matter', () => {
		expect(backMatterBlockIds([heading('h0', 'Introduction'), para('p0')]).size).toBe(0);
	});
});

describe('backMatterAnnouncement', () => {
	it('names the section it is skipping', () => {
		expect(backMatterAnnouncement('References')).toBe('Skipping the references.');
		expect(backMatterAnnouncement('7. Acknowledgements')).toBe('Skipping the acknowledgements.');
	});
});
