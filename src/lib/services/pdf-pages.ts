import type { NormalizedDocument } from '../domain/types';
import { getSource } from './repository';

/** Safari caps canvases around 4096×4096 / 16M pixels; render within that. */
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;

export interface PageRasterizer {
	readonly pageCount: number;
	/** Draws a page (1-based) into `canvas` sized for `cssWidth` CSS pixels at
	 * the device pixel ratio. Sets the canvas buffer and style sizes.
	 *
	 * The page is painted off-screen and handed over whole, so `canvas` keeps
	 * whatever it was showing until the new picture is finished. Painting into
	 * it directly means clearing it first and then filling it in over however
	 * many frames the page takes — which reads as a flash on every redraw, and
	 * as a strobe while a zoom slider is being dragged.
	 *
	 * Aborting `signal` abandons the draw — while it is still queued, or partway
	 * through. A page of dense vector art can take seconds to paint, and renders
	 * run one at a time, so a reader who has scrolled past one must not leave it
	 * holding the queue against every page they are actually looking at. */
	renderPage(
		page: number,
		canvas: HTMLCanvasElement,
		cssWidth: number,
		signal?: AbortSignal
	): Promise<void>;
	/** Renders a page (1-based) to an OffscreenCanvas at `scale`× the page's
	 * natural point size — the OCR path's rasterizer. */
	rasterize(page: number, scale: number): Promise<OffscreenCanvas>;
	destroy(): Promise<void>;
}

function clampedScale(width: number, height: number, requested: number): number {
	let scale = requested;
	const largest = Math.max(width, height);
	if (largest * scale > MAX_DIMENSION) scale = MAX_DIMENSION / largest;
	if (width * scale * height * scale > MAX_PIXELS) {
		scale = Math.sqrt(MAX_PIXELS / (width * height));
	}
	return scale;
}

/**
 * A pdf.js document wrapped for page rendering — used at import time to
 * rasterize scanned pages for OCR, and at read time for the original-page
 * view. Renders are serialized: pdf.js does not allow two renders into the
 * same document concurrently, and callers page quickly through prev/next.
 */
export async function createPageRasterizer(data: Uint8Array): Promise<PageRasterizer> {
	const pdfjs = await import('pdfjs-dist');
	const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	// pdf.js transfers the buffer to its worker; copy so callers keep theirs.
	const loadingTask = pdfjs.getDocument({ data: data.slice() });
	const pdf = await loadingTask.promise;
	let queue: Promise<unknown> = Promise.resolve();
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const result = queue.then(work, work);
		queue = result.catch(() => undefined);
		return result;
	};

	const renderInto = async (
		pageNumber: number,
		canvas: HTMLCanvasElement | OffscreenCanvas,
		requestedScale: number,
		signal?: AbortSignal
	) => {
		signal?.throwIfAborted();
		const page = await pdf.getPage(pageNumber);
		try {
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({
				scale: clampedScale(base.width, base.height, requestedScale)
			});
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			const task = page.render({
				canvas: canvas as HTMLCanvasElement,
				viewport
			});
			const abort = () => task.cancel();
			signal?.addEventListener('abort', abort, { once: true });
			try {
				await task.promise;
			} finally {
				signal?.removeEventListener('abort', abort);
			}
			return viewport;
		} finally {
			page.cleanup();
		}
	};

	return {
		pageCount: pdf.numPages,
		renderPage: (pageNumber, canvas, cssWidth, signal) =>
			serialize(async () => {
				signal?.throwIfAborted();
				const page = await pdf.getPage(pageNumber);
				const width = page.getViewport({ scale: 1 }).width;
				page.cleanup();
				const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
				const offscreen = new OffscreenCanvas(1, 1);
				const viewport = await renderInto(
					pageNumber,
					offscreen,
					(cssWidth / width) * ratio,
					signal
				);
				// Abandoned while it painted: the finished picture is no longer the
				// one anybody asked for, so leave the canvas as it was.
				signal?.throwIfAborted();
				present(canvas, offscreen);
				canvas.style.width = `${Math.round(viewport.width / ratio)}px`;
				canvas.style.height = `${Math.round(viewport.height / ratio)}px`;
			}),
		rasterize: (pageNumber, scale) =>
			serialize(async () => {
				const canvas = new OffscreenCanvas(1, 1);
				await renderInto(pageNumber, canvas, scale);
				return canvas;
			}),
		destroy: async () => {
			// pdfjs v6 removed PDFDocumentProxy.destroy — teardown lives on the
			// loading task.
			await loadingTask.destroy();
		}
	};
}

/**
 * Put a finished off-screen page onto a visible canvas in one step. A bitmap
 * renderer takes ownership of the pixels outright; where that context is not
 * available the pixels are copied instead, which costs a blit but still swaps
 * the whole page at once.
 */
function present(canvas: HTMLCanvasElement, source: OffscreenCanvas): void {
	const bitmap = source.transferToImageBitmap();
	try {
		const renderer = canvas.getContext('bitmaprenderer');
		if (renderer) {
			// Sized explicitly: transferring a bitmap swaps what the canvas shows
			// without touching its width and height attributes, and those are what
			// the page view measures its memory against.
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			renderer.transferFromImageBitmap(bitmap);
			return;
		}
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
	} finally {
		bitmap.close();
	}
}

let openRenderer: { documentId: string; rasterizer: Promise<PageRasterizer | null> } | undefined;

/**
 * The read-time renderer for a document's original PDF, loaded from the
 * stored source bytes. One document's renderer is kept warm at a time —
 * opening another document releases the previous one. Returns null when the
 * document has no retrievable source (OPFS eviction, non-PDF).
 */
export function openPdfRenderer(document: NormalizedDocument): Promise<PageRasterizer | null> {
	if (openRenderer?.documentId === document.id) return openRenderer.rasterizer;
	void releasePdfRenderer();
	const rasterizer = (async () => {
		const source = await getSource(document);
		if (!source) return null;
		try {
			return await createPageRasterizer(new Uint8Array(await source.arrayBuffer()));
		} catch {
			return null;
		}
	})();
	const entry = { documentId: document.id, rasterizer };
	openRenderer = entry;
	// A failed open must not stick for the session — clear the slot so the
	// next click retries (transient OPFS reads do recover).
	void rasterizer.then((resolved) => {
		if (!resolved && openRenderer === entry) openRenderer = undefined;
	});
	return rasterizer;
}

/** Frees pdf.js resources. Safe to call twice or with nothing open. */
export async function releasePdfRenderer(documentId?: string): Promise<void> {
	if (!openRenderer) return;
	if (documentId && openRenderer.documentId !== documentId) return;
	const pending = openRenderer.rasterizer;
	openRenderer = undefined;
	const rasterizer = await pending.catch(() => null);
	await rasterizer?.destroy().catch(() => undefined);
}
