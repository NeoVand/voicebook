import { describe, expect, it, vi } from 'vitest';
import { DocumentLayout, type PageLayout, type PageWindowReader } from './pdf-layout';
import type { SpeechSegment } from '../domain/types';

const BYTES = new Uint8Array([1, 2, 3]);

/** A page of three words on one line, positioned so placement has something
 * to bite on. */
function page(number: number, words: string[]): PageLayout {
	let x = 72;
	return {
		page: number,
		width: 612,
		height: 792,
		boxes: words.map((text) => {
			const box = { text, x, y: 100, width: text.length * 6, height: 12 };
			x += text.length * 6 + 4;
			return box;
		})
	};
}

function reader(pages: Record<number, string[]>): {
	read: PageWindowReader;
	calls: Array<[number, number]>;
} {
	const calls: Array<[number, number]> = [];
	const read: PageWindowReader = async (_data, from, to) => {
		calls.push([from, to]);
		const out: PageLayout[] = [];
		for (let number = from; number <= to; number += 1) {
			if (pages[number]) out.push(page(number, pages[number]));
		}
		return out;
	};
	return { read, calls };
}

function layoutFor(pages: Record<number, string[]>, source: Uint8Array | null = BYTES) {
	const { read, calls } = reader(pages);
	return { layout: new DocumentLayout('doc', async () => source, read), calls };
}

function segment(id: string, text: string, pageNumber: number): SpeechSegment {
	return {
		id,
		blockId: 'b1',
		text,
		normalizedText: text,
		start: 0,
		end: text.length,
		words: [...text.matchAll(/\S+/g)].map((match) => ({
			text: match[0],
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length
		})),
		estimatedDuration: 1,
		anchor: { page: pageNumber }
	};
}

describe('DocumentLayout', () => {
	it('reads a window around the page asked for, leaning ahead', async () => {
		const { layout, calls } = layoutFor({ 3: ['alpha'] });
		await layout.pageLayout(3, 20);
		expect(calls).toEqual([[2, 5]]);
	});

	it('does not read past the end of the document', async () => {
		const { layout, calls } = layoutFor({ 5: ['alpha'] });
		await layout.pageLayout(5, 5);
		expect(calls).toEqual([[4, 5]]);
	});

	it('serves later pages of a window without reading again', async () => {
		const { layout, calls } = layoutFor({ 2: ['alpha'], 3: ['beta'], 4: ['gamma'] });
		await layout.pageLayout(2, 10);
		const ahead = await layout.pageLayout(4, 10);
		expect(ahead?.boxes[0].text).toBe('gamma');
		expect(calls).toHaveLength(1);
	});

	it('joins a read already in flight rather than starting a second', async () => {
		const { layout, calls } = layoutFor({ 1: ['alpha'], 2: ['beta'] });
		const [first, second] = await Promise.all([layout.pageLayout(1, 10), layout.pageLayout(2, 10)]);
		expect(first?.page).toBe(1);
		expect(second?.page).toBe(2);
		expect(calls).toHaveLength(1);
	});

	it('remembers a page the read had nothing for, and stops asking', async () => {
		const { layout, calls } = layoutFor({ 1: ['alpha'] });
		expect(await layout.pageLayout(2, 10)).toBeNull();
		expect(await layout.pageLayout(2, 10)).toBeNull();
		expect(calls).toHaveLength(1);
	});

	it('has no geometry when the file is gone from this device', async () => {
		const { layout, calls } = layoutFor({ 1: ['alpha'] }, null);
		expect(await layout.pageLayout(1, 10)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('survives a read that throws', async () => {
		const failing: PageWindowReader = () => Promise.reject(new Error('wasm said no'));
		const layout = new DocumentLayout('doc', async () => BYTES, failing);
		expect(await layout.pageLayout(1, 10)).toBeNull();
	});

	it('places the passages anchored to a page', async () => {
		const { layout } = layoutFor({ 1: ['the', 'harbour', 'master'] });
		const placed = await layout.placements(
			1,
			1,
			[segment('s1', 'The harbour master', 1)],
			new Map()
		);
		expect(placed.get('s1')?.rects[0].y).toBe(100);
	});

	it('places each page once and keeps the answer', async () => {
		const { layout, calls } = layoutFor({ 1: ['the', 'harbour', 'master'] });
		const segments = [segment('s1', 'The harbour master', 1)];
		const first = await layout.placements(1, 1, segments, new Map());
		const again = await layout.placements(1, 1, segments, new Map());
		expect(again).toBe(first);
		expect(calls).toHaveLength(1);
	});

	it('throws its placements away when the passages are rebound', async () => {
		const { layout, calls } = layoutFor({ 1: ['the', 'harbour', 'master'] });
		const first = await layout.placements(
			1,
			1,
			[segment('s1', 'The harbour master', 1)],
			new Map()
		);
		const rebound = await layout.placements(
			1,
			1,
			[segment('s1:n0', 'The harbour master', 1)],
			new Map()
		);
		expect(rebound).not.toBe(first);
		expect(rebound.has('s1:n0')).toBe(true);
		// The geometry is still good, though — only the placement was stale.
		expect(calls).toHaveLength(1);
	});

	it('does not cache a placement computed against passages already replaced', async () => {
		const gate = vi.fn();
		let release: (() => void) | undefined;
		const read: PageWindowReader = async () =>
			new Promise((resolve) => {
				release = () => resolve([page(1, ['the', 'harbour', 'master'])]);
				gate();
			});
		const layout = new DocumentLayout('doc', async () => BYTES, read);
		const stale = layout.placements(1, 1, [segment('old', 'The harbour master', 1)], new Map());
		await vi.waitFor(() => expect(gate).toHaveBeenCalled());
		const fresh = layout.placements(1, 1, [segment('new', 'The harbour master', 1)], new Map());
		release?.();
		await stale;
		const settled = await fresh;
		expect(settled.has('new')).toBe(true);
	});
});
