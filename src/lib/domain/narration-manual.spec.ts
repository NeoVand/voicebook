import { describe, expect, it } from 'vitest';
import { hashNarrationSource, reconcileNarrations, tableMarkdown } from './narration';
import type { DocumentBlock, DocumentTable, NarrationEntry } from './types';

function mathBlock(id: string, text: string): DocumentBlock {
	return { id, kind: 'math', text, speak: false, anchor: {} };
}

function manualEntry(constructId: string, source: string): NarrationEntry {
	return {
		constructId,
		kind: 'math-block',
		status: 'ready',
		text: 'My own words for this equation.',
		sourceHash: hashNarrationSource('math-block', source),
		// Deliberately stale prompt lineage — manual text has no prompt.
		promptVersion: 1,
		promptHash: 'stale',
		origin: 'manual',
		updatedAt: 1
	};
}

describe('manual narration entries', () => {
	it('survive prompt edits and version bumps', () => {
		const blocks = [mathBlock('b0', 'E = mc^2')];
		const existing = { b0: manualEntry('b0', 'E = mc^2') };
		const result = reconcileNarrations(blocks, existing, { 'math-block': 'brand-new-hash' });
		expect(result.narrations.b0.origin).toBe('manual');
		expect(result.narrations.b0.text).toBe('My own words for this equation.');
		expect(result.queue).toHaveLength(0);
	});

	it('are invalidated when the construct source changes', () => {
		const blocks = [mathBlock('b0', 'E = mc^3')];
		const existing = { b0: manualEntry('b0', 'E = mc^2') };
		const result = reconcileNarrations(blocks, existing, {});
		expect(result.narrations.b0.status).toBe('pending');
		expect(result.narrations.b0.origin).toBeUndefined();
		expect(result.queue).toHaveLength(1);
	});

	it('are rescued by content hash when block ids shift', () => {
		const blocks = [mathBlock('b7', 'E = mc^2')];
		const existing = { b0: manualEntry('b0', 'E = mc^2') };
		const result = reconcileNarrations(blocks, existing, {});
		expect(result.narrations.b7.text).toBe('My own words for this equation.');
		expect(result.narrations.b7.origin).toBe('manual');
	});
});

describe('tableMarkdown', () => {
	it('reconstructs a pipe table with alignment and escaping', () => {
		const table: DocumentTable = {
			align: [null, 'center', 'right'],
			header: [
				{ text: 'Name', inlines: [] },
				{ text: 'A|B', inlines: [] },
				{ text: 'N', inlines: [] }
			],
			rows: [
				[
					{ text: 'Alice', inlines: [] },
					{ text: 'yes', inlines: [] },
					{ text: '3', inlines: [] }
				]
			]
		};
		expect(tableMarkdown(table)).toBe(
			['| Name | A\\|B | N |', '| --- | :---: | ---: |', '| Alice | yes | 3 |'].join('\n')
		);
	});
});
