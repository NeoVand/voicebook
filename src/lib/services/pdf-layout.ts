import type { NormalizedDocument, SpeechSegment } from '../domain/types';
import {
	pageWordBoxes,
	placeSegments,
	segmentsForPage,
	type PageWordBox,
	type SegmentPlacement
} from '../domain/pdf-layout';
import { getSource } from './repository';

/**
 * Read-time word geometry for a document's original PDF.
 *
 * The import already ran LiteParse over these bytes, but deliberately kept
 * none of the boxes: storing a rectangle per word for every document in the
 * library would dwarf the documents themselves (see `DocumentPageInfo`).
 * Re-reading them is cheap when it is asked for by page — LiteParse's
 * `targetPages` parses a window in tens of milliseconds — so the page view
 * recomputes what it needs as the reader scrolls and keeps it in memory for
 * the session.
 */

export interface PageLayout {
	page: number;
	/** PDF points, as LiteParse read them — the coordinate space of `boxes`. */
	width: number;
	height: number;
	boxes: PageWordBox[];
}

/** Pages either side of the requested one to parse in the same pass. Reading
 * is directional, so the window leans forward. */
const WINDOW_BEHIND = 1;
const WINDOW_AHEAD = 2;

let liteparse: Promise<typeof import('@llamaindex/liteparse-wasm')> | undefined;

/** The wasm module, initialized once per session. LiteParse's own init guard
 * only dedupes after the first init resolves, so the promise is what callers
 * share. */
async function loadLiteparse(): Promise<typeof import('@llamaindex/liteparse-wasm')> {
	liteparse ??= (async () => {
		const [glue, wasm] = await Promise.all([
			import('@llamaindex/liteparse-wasm'),
			import('@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url')
		]);
		await glue.default({ module_or_path: wasm.default });
		return glue;
	})();
	return liteparse;
}

/**
 * One document's page geometry, parsed on demand and kept for the session.
 * Requests for the same page while a parse is in flight join it rather than
 * starting a second one — scrolling asks for the same page many times.
 */
class DocumentLayout {
	readonly documentId: string;
	#source: Promise<Uint8Array | null>;
	#pages = new Map<number, PageLayout | null>();
	#pending = new Map<number, Promise<PageLayout | null>>();
	#placements = new Map<string, Map<string, SegmentPlacement>>();
	#segments: SpeechSegment[] = [];

	constructor(document: NormalizedDocument) {
		this.documentId = document.id;
		this.#source = (async () => {
			const blob = await getSource(document);
			if (!blob) return null;
			return new Uint8Array(await blob.arrayBuffer());
		})().catch(() => null);
	}

	/** Word boxes for one page, or null when the source is gone (OPFS
	 * eviction) or LiteParse cannot read it. */
	pageLayout(page: number, pageCount: number): Promise<PageLayout | null> {
		const cached = this.#pages.get(page);
		if (cached !== undefined) return Promise.resolve(cached);
		const inFlight = this.#pending.get(page);
		if (inFlight) return inFlight;
		const from = Math.max(1, page - WINDOW_BEHIND);
		const to = Math.max(from, Math.min(pageCount || page + WINDOW_AHEAD, page + WINDOW_AHEAD));
		const work = this.#parseWindow(from, to).then(
			() => this.#pages.get(page) ?? null,
			() => null
		);
		for (let target = from; target <= to; target += 1) {
			if (!this.#pages.has(target)) this.#pending.set(target, work);
		}
		void work.finally(() => {
			for (let target = from; target <= to; target += 1) {
				if (this.#pending.get(target) === work) this.#pending.delete(target);
			}
		});
		return work;
	}

	async #parseWindow(from: number, to: number): Promise<void> {
		const data = await this.#source;
		if (!data) {
			for (let page = from; page <= to; page += 1) this.#pages.set(page, null);
			return;
		}
		const glue = await loadLiteparse();
		const parser = new glue.LiteParse({
			ocrEnabled: false,
			outputFormat: 'markdown',
			// Only the geometry is wanted here; images and links are the import's
			// business and decoding them again would dominate the parse.
			imageMode: 'off',
			extractLinks: false,
			skipDiagonalText: true,
			emitWordBoxes: true,
			quiet: true,
			targetPages: from === to ? String(from) : `${from}-${to}`
		});
		let parsed: Awaited<ReturnType<typeof parser.parse>>;
		try {
			// LiteParse transfers the buffer to wasm; hand it a copy so the next
			// window still has bytes to read.
			parsed = await parser.parse(data.slice());
		} finally {
			parser.free();
		}
		const seen = new Set<number>();
		for (const page of parsed.pages) {
			seen.add(page.pageNum);
			this.#pages.set(page.pageNum, {
				page: page.pageNum,
				width: page.width,
				height: page.height,
				boxes: pageWordBoxes(page.textItems ?? [])
			});
		}
		// A page the parse skipped has no geometry and never will; recording the
		// miss stops every scroll from asking again.
		for (let page = from; page <= to; page += 1) if (!seen.has(page)) this.#pages.set(page, null);
	}

	/**
	 * Where each passage sits on one page. Placement is pure but not free
	 * (tens of milliseconds on a dense page), so results are kept per page and
	 * dropped wholesale when the passages themselves change — a listening-mode
	 * switch or a narration swap re-cuts every segment id.
	 */
	async placements(
		page: number,
		pageCount: number,
		segments: SpeechSegment[],
		blockText: ReadonlyMap<string, string>
	): Promise<Map<string, SegmentPlacement>> {
		if (segments !== this.#segments) {
			this.#segments = segments;
			this.#placements.clear();
		}
		const key = String(page);
		const cached = this.#placements.get(key);
		if (cached) return cached;
		const layout = await this.pageLayout(page, pageCount);
		const placed = new Map<string, SegmentPlacement>();
		if (layout?.boxes.length) {
			const placeable = segmentsForPage(segments, page, blockText);
			for (const placement of placeSegments(layout.boxes, placeable, page)) {
				placed.set(placement.segmentId, placement);
			}
		}
		// The passages may have been rebound while this page was being parsed;
		// caching against a stale set would pin placements for ids nothing uses.
		if (segments === this.#segments) this.#placements.set(key, placed);
		return placed;
	}
}

let open: DocumentLayout | undefined;

/** The layout source for a document, kept warm one at a time — opening
 * another document releases the previous one, matching the page renderer. */
export function openPdfLayout(document: NormalizedDocument): DocumentLayout {
	if (open?.documentId !== document.id) open = new DocumentLayout(document);
	return open;
}

/** Frees the warm layout source. Safe to call twice or with nothing open. */
export function releasePdfLayout(documentId?: string): void {
	if (!open) return;
	if (documentId && open.documentId !== documentId) return;
	open = undefined;
}

export type { DocumentLayout };
