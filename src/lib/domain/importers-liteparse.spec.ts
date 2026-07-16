import { describe, expect, it } from 'vitest';
import { liteparsePageMarkdown, pdfLooksScanned, stripBlanketBold } from './importers';

describe('liteparsePageMarkdown', () => {
	it('prefers page markdown and falls back to plain text', () => {
		expect(
			liteparsePageMarkdown([
				{ markdown: '# Title\n\nBody.', text: 'Title Body.' },
				{ markdown: '  ', text: 'Second page text.' },
				{ text: '' },
				{}
			])
		).toBe('# Title\n\nBody.\n\nSecond page text.');
	});

	it('returns an empty string for no usable pages', () => {
		expect(liteparsePageMarkdown([])).toBe('');
		expect(liteparsePageMarkdown([{ markdown: '', text: '' }])).toBe('');
	});
});

describe('stripBlanketBold', () => {
	it('unwraps body paragraphs when nearly everything is bold', () => {
		const markdown = [
			'# Field Notes',
			'',
			'**Reinforcement learning studies agents that improve through interaction.**',
			'',
			'## Core quantities',
			'',
			'**The three quantities below appear in nearly every formulation.**',
			'',
			'| Symbol | Name |',
			'|---|---|',
			'| S | State |'
		].join('\n');
		const cleaned = stripBlanketBold(markdown);
		expect(cleaned).toContain(
			'Reinforcement learning studies agents that improve through interaction.'
		);
		expect(cleaned).not.toContain('**Reinforcement');
		// Headings and tables are untouched.
		expect(cleaned).toContain('# Field Notes');
		expect(cleaned).toContain('| S | State |');
	});

	it('leaves selective emphasis alone', () => {
		const markdown = [
			'Plain paragraph one.',
			'',
			'**A deliberately bold callout.**',
			'',
			'Plain paragraph two.',
			'',
			'Plain paragraph three with **inline bold** kept.'
		].join('\n');
		expect(stripBlanketBold(markdown)).toBe(markdown);
	});
});

describe('pdfLooksScanned', () => {
	it('flags documents with almost no embedded text', () => {
		expect(pdfLooksScanned('', 3)).toBe(true);
		expect(pdfLooksScanned('| - | - |', 1)).toBe(true);
	});

	it('accepts documents with a real text layer', () => {
		const page = 'Reinforcement learning studies agents that improve through interaction.';
		expect(pdfLooksScanned(page, 1)).toBe(false);
		expect(pdfLooksScanned(Array(10).fill(page).join('\n\n'), 10)).toBe(false);
	});

	it('scales the threshold with page count', () => {
		const thin = 'twenty five letters here now'; // > 24 letters, < 8 per page × 30
		expect(pdfLooksScanned(thin, 1)).toBe(false);
		expect(pdfLooksScanned(thin, 30)).toBe(true);
	});
});
