import { describe, expect, it } from 'vitest';
import { tesseractBlocksToMarkdown } from './ocr-engine';

describe('tesseractBlocksToMarkdown', () => {
	it('joins paragraphs with blank lines and collapses whitespace', () => {
		expect(
			tesseractBlocksToMarkdown([
				{
					paragraphs: [
						{ text: 'First   recognized\nparagraph.', confidence: 92 },
						{ text: ' Second paragraph. ', confidence: 88 }
					]
				},
				{ paragraphs: [{ text: 'Third from another block.', confidence: 90 }] }
			])
		).toBe('First recognized paragraph.\n\nSecond paragraph.\n\nThird from another block.');
	});

	it('drops low-confidence noise from figures', () => {
		expect(
			tesseractBlocksToMarkdown([
				{
					paragraphs: [
						{ text: 'Legible text.', confidence: 95 },
						{ text: '|/-~"* .,', confidence: 4 }
					]
				}
			])
		).toBe('Legible text.');
	});

	it('falls back to block text when paragraphs are absent', () => {
		expect(tesseractBlocksToMarkdown([{ text: 'Whole block text.' }])).toBe('Whole block text.');
	});

	it('handles null and empty inputs', () => {
		expect(tesseractBlocksToMarkdown(null)).toBe('');
		expect(tesseractBlocksToMarkdown([])).toBe('');
		expect(tesseractBlocksToMarkdown([{ paragraphs: [] }])).toBe('');
	});
});
