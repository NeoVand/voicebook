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

/** Reads one window of pages out of the document's bytes. Supplied by the
 * module below; a parameter so the caching around it can be tested without a
 * wasm runtime. */
export type PageWindowReader = (
	data: Uint8Array,
	from: number,
	to: number
) => Promise<PageLayout[]>;

/**
 * One document's page geometry, parsed on demand and kept for the session.
 * Requests for the same page while a parse is in flight join it rather than
 * starting a second one — scrolling asks for the same page many times.
 */
export class DocumentLayout {
	readonly documentId: string;
	#source: Promise<Uint8Array | null>;
	#read: PageWindowReader;
	#pages = new Map<number, PageLayout | null>();
	/** The in-flight window read covering each page, shared by every caller
	 * waiting on it. */
	#pending = new Map<number, Promise<void>>();
	#placements = new Map<string, Map<string, SegmentPlacement>>();
	#segments: SpeechSegment[] = [];

	constructor(
		documentId: string,
		loadSource: () => Promise<Uint8Array | null>,
		read: PageWindowReader
	) {
		this.documentId = documentId;
		this.#read = read;
		this.#source = loadSource().catch(() => null);
	}

	/** Word boxes for one page, or null when the source is gone (OPFS
	 * eviction) or LiteParse cannot read it. */
	pageLayout(page: number, pageCount: number): Promise<PageLayout | null> {
		const cached = this.#pages.get(page);
		if (cached !== undefined) return Promise.resolve(cached);
		// What a waiting caller wants is its OWN page out of the finished read,
		// not the page whoever started the read had asked for.
		const settle = (work: Promise<void>) =>
			work.then(
				() => this.#pages.get(page) ?? null,
				() => null
			);
		const inFlight = this.#pending.get(page);
		if (inFlight) return settle(inFlight);
		const from = Math.max(1, page - WINDOW_BEHIND);
		const to = Math.max(from, Math.min(pageCount || page + WINDOW_AHEAD, page + WINDOW_AHEAD));
		const work = this.#parseWindow(from, to);
		for (let target = from; target <= to; target += 1) {
			if (!this.#pages.has(target)) this.#pending.set(target, work);
		}
		void work
			.catch(() => undefined)
			.finally(() => {
				for (let target = from; target <= to; target += 1) {
					if (this.#pending.get(target) === work) this.#pending.delete(target);
				}
			});
		return settle(work);
	}

	async #parseWindow(from: number, to: number): Promise<void> {
		const data = await this.#source;
		const parsed = data ? await this.#read(data, from, to) : [];
		const seen = new Set<number>();
		for (const layout of parsed) {
			seen.add(layout.page);
			this.#pages.set(layout.page, layout);
		}
		// A page the read skipped has no geometry and never will; recording the
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

/** The real reader: LiteParse over a page range, asked for geometry only. */
const readWithLiteparse: PageWindowReader = async (data, from, to) => {
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
	return parsed.pages.map((page) => ({
		page: page.pageNum,
		width: page.width,
		height: page.height,
		boxes: pageWordBoxes(page.textItems ?? [])
	}));
};

let open: DocumentLayout | undefined;

/** The layout source for a document, kept warm one at a time — opening
 * another document releases the previous one, matching the page renderer. */
export function openPdfLayout(document: NormalizedDocument): DocumentLayout {
	if (open?.documentId !== document.id) {
		open = new DocumentLayout(
			document.id,
			async () => {
				const blob = await getSource(document);
				return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
			},
			readWithLiteparse
		);
	}
	return open;
}

/** Frees the warm layout source. Safe to call twice or with nothing open. */
export function releasePdfLayout(documentId?: string): void {
	if (!open) return;
	if (documentId && open.documentId !== documentId) return;
	open = undefined;
}
