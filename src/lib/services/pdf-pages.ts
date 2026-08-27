import type { NormalizedDocument } from '../domain/types';
import { toneDistance, tonePixels, type Rgb } from '../domain/page-tone';
import { getSource } from './repository';

/** Safari caps canvases around 4096×4096 / 16M pixels; render within that. */
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;

export interface PageRasterizer {
	readonly pageCount: number;
	/** Draws a page (1-based) into `canvas` at the device pixel ratio, for a
	 * display width of `cssWidth`, and reports the CSS size the result wants to
	 * be shown at. It does NOT set that size on the canvas: a caller whose
	 * canvas is sized by its own layout (the page view stretches one to fill its
	 * sheet) must be free to resize the drawing between draws, and pinning it in
	 * pixels here left the picture at its old size while everything around it
	 * had already grown.
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
		options?: { signal?: AbortSignal; tone?: { paper: Rgb; ink: Rgb } }
	): Promise<{ width: number; height: number }>;
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

	type Page = Awaited<ReturnType<typeof pdf.getPage>>;
	const renderPageInto = async (
		page: Page,
		canvas: OffscreenCanvas,
		viewport: ReturnType<Page['getViewport']>,
		signal?: AbortSignal
	) => {
		const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport });
		const abort = () => task.cancel();
		signal?.addEventListener('abort', abort, { once: true });
		try {
			await task.promise;
		} finally {
			signal?.removeEventListener('abort', abort);
		}
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
		renderPage: (pageNumber, canvas, cssWidth, options = {}) =>
			serialize(async () => {
				const { signal, tone } = options;
				signal?.throwIfAborted();
				const page = await pdf.getPage(pageNumber);
				try {
					const base = page.getViewport({ scale: 1 });
					const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
					const viewport = page.getViewport({
						scale: clampedScale(base.width, base.height, (cssWidth / base.width) * ratio)
					});
					const offscreen = new OffscreenCanvas(
						Math.floor(viewport.width),
						Math.floor(viewport.height)
					);
					await renderPageInto(page, offscreen, viewport, signal);
					// Abandoned while it painted: the finished picture is no longer
					// the one anybody asked for, so leave the canvas as it was.
					signal?.throwIfAborted();
					if (tone) await printOnto(pdfjs, page, offscreen, viewport, tone);
					present(canvas, offscreen);
					return {
						width: Math.round(viewport.width / ratio),
						height: Math.round(viewport.height / ratio)
					};
				} finally {
					page.cleanup();
				}
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
 * Reprint a drawn page onto the reader's paper, in place.
 *
 * The ramp itself lives in domain/page-tone.ts; what belongs here is knowing
 * which parts of the page it may touch. Photographs and rendered figures must
 * be left exactly as the author made them — running paper-and-ink arithmetic
 * over a photograph produces a negative — and the page's operator list says
 * precisely where each image object lands, so those rectangles are lifted out
 * beforehand and put back after.
 *
 * Line art, rules and type are not images and do take the ramp, which is what
 * lets a page become genuinely dark rather than merely dimmed.
 *
 * A page that is already dark is left alone: the ramp reads lightness as
 * paper, so a dark plate would come back inverted.
 */
async function printOnto(
	pdfjs: typeof import('pdfjs-dist'),
	page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }> },
	surface: OffscreenCanvas,
	viewport: { transform: number[] },
	tone: { paper: Rgb; ink: Rgb }
): Promise<void> {
	// Under a theme whose paper is already white under black ink there is
	// nothing to do, and a full-page pixel pass is not free.
	if (toneDistance(tone.paper, tone.ink) < 0.06) return;
	if (!isLightPage(surface)) return;
	const context = surface.getContext('2d', { willReadFrequently: true });
	if (!context) return;
	const pictures = (await imageRects(pdfjs, page, viewport, surface)).map((rect) => ({
		rect,
		pixels: context.getImageData(rect.x, rect.y, rect.width, rect.height)
	}));
	const page_ = context.getImageData(0, 0, surface.width, surface.height);
	tonePixels(page_.data, tone.paper, tone.ink);
	context.putImageData(page_, 0, 0);
	for (const picture of pictures)
		context.putImageData(picture.pixels, picture.rect.x, picture.rect.y);
}

/** Sampled down to a thumbnail: paper is overwhelmingly the lightest thing on
 * a printed page, so a mean this high means there is paper to invert. */
function isLightPage(source: OffscreenCanvas): boolean {
	const size = 24;
	const thumbnail = new OffscreenCanvas(size, size);
	const context = thumbnail.getContext('2d', { willReadFrequently: true });
	if (!context) return true;
	context.drawImage(source, 0, 0, size, size);
	const { data } = context.getImageData(0, 0, size, size);
	let total = 0;
	for (let index = 0; index < data.length; index += 4) {
		total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
	}
	return total / (size * size) > 140;
}

/** [a, b, c, d, e, f] ∘ [a, b, c, d, e, f]. */
function concat(outer: number[], inner: number[]): number[] {
	return [
		outer[0] * inner[0] + outer[2] * inner[1],
		outer[1] * inner[0] + outer[3] * inner[1],
		outer[0] * inner[2] + outer[2] * inner[3],
		outer[1] * inner[2] + outer[3] * inner[3],
		outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
		outer[1] * inner[4] + outer[3] * inner[5] + outer[5]
	];
}

function apply(x: number, y: number, matrix: number[]): [number, number] {
	return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/** Where each image object on the page landed, in canvas pixels. Images are
 * drawn into the unit square, so the current transform is the placement; the
 * operator list has to be walked with a transform stack to know what it was. */
async function imageRects(
	pdfjs: typeof import('pdfjs-dist'),
	page: { getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }> },
	viewport: { transform: number[] },
	source: OffscreenCanvas
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
	const { OPS } = pdfjs;
	const paints = new Set([
		OPS.paintImageXObject,
		OPS.paintImageXObjectRepeat,
		OPS.paintInlineImageXObject,
		OPS.paintImageMaskXObject
	]);
	let operators: { fnArray: number[]; argsArray: unknown[][] };
	try {
		operators = await page.getOperatorList();
	} catch {
		return [];
	}
	const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
	const stack: number[][] = [];
	let transform = viewport.transform;
	for (let index = 0; index < operators.fnArray.length; index += 1) {
		const operator = operators.fnArray[index];
		if (operator === OPS.save) stack.push(transform);
		else if (operator === OPS.restore) transform = stack.pop() ?? transform;
		else if (operator === OPS.transform) {
			transform = concat(transform, operators.argsArray[index] as number[]);
		} else if (paints.has(operator)) {
			const corners = [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1]
			].map(([x, y]) => apply(x, y, transform));
			const left = Math.floor(Math.min(...corners.map((point) => point[0])));
			const top = Math.floor(Math.min(...corners.map((point) => point[1])));
			const right = Math.ceil(Math.max(...corners.map((point) => point[0])));
			const bottom = Math.ceil(Math.max(...corners.map((point) => point[1])));
			const x = Math.max(0, left);
			const y = Math.max(0, top);
			const width = Math.min(source.width, right) - x;
			const height = Math.min(source.height, bottom) - y;
			if (width > 1 && height > 1) rects.push({ x, y, width, height });
		}
	}
	return rects;
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
