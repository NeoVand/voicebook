/**
 * On-device OCR for scanned PDF pages: pdf.js rasterizes the page, a single
 * tesseract.js worker recognizes it, and the recognized text replaces that
 * page's markdown in the import pipeline.
 *
 * This deliberately does NOT use LiteParse's `ocrEngine` hook: in 2.6.0 the
 * wasm's merge path calls tokio's `Handle::current()` and panics in every JS
 * environment (verified against the shipped artifact and the tagged source).
 *
 * Everything here is lazy — the module itself is only imported when a
 * document actually has scanned pages, and the ~7 MB of engine assets
 * (core wasm, worker, English language data) are separate Vite assets
 * fetched on first use, never part of the entry chunk.
 */
import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import coreUrl from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import engDataUrl from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url';
import { createPageRasterizer } from './pdf-pages';

/** ~150 DPI relative to PDF points (72/inch): plenty for print-size text. */
const OCR_SCALE = 150 / 72;

/** Below this tesseract is reading noise (figure fragments, dust). */
const MIN_PARAGRAPH_CONFIDENCE = 30;

interface TesseractParagraphLike {
	text?: string;
	confidence?: number;
}

export interface TesseractBlockLike {
	paragraphs?: TesseractParagraphLike[] | null;
	text?: string;
}

/** Tesseract's block tree → markdown-ish text: one paragraph per recognized
 * paragraph, whitespace collapsed, low-confidence noise dropped. */
export function tesseractBlocksToMarkdown(blocks: TesseractBlockLike[] | null | undefined): string {
	if (!blocks?.length) return '';
	const paragraphs: string[] = [];
	for (const candidate of blocks) {
		const source = candidate.paragraphs?.length
			? candidate.paragraphs
			: [{ text: candidate.text, confidence: undefined }];
		for (const paragraph of source) {
			const text = paragraph.text?.replace(/\s+/g, ' ').trim();
			if (!text) continue;
			if (
				paragraph.confidence !== undefined &&
				paragraph.confidence < MIN_PARAGRAPH_CONFIDENCE
			) {
				continue;
			}
			paragraphs.push(text);
		}
	}
	return paragraphs.join('\n\n');
}

interface TesseractWorkerLike {
	recognize(
		image: Blob,
		options?: object,
		output?: object
	): Promise<{ data: { blocks?: TesseractBlockLike[] | null } }>;
	terminate(): Promise<unknown>;
}

async function createTesseractWorker(): Promise<TesseractWorkerLike | null> {
	try {
		const [{ createWorker, OEM }, langData] = await Promise.all([
			import('tesseract.js'),
			fetch(engDataUrl).then((response) => {
				if (!response.ok) throw new Error(`language data: HTTP ${response.status}`);
				return response.arrayBuffer();
			})
		]);
		// Language bytes are fetched here and handed over directly (the worker
		// gunzips by magic number), so tesseract's own caching/network layers
		// stay out of the picture and the app remains fully same-origin.
		return (await createWorker([{ code: 'eng', data: new Uint8Array(langData) }], OEM.LSTM_ONLY, {
			workerPath: workerUrl,
			corePath: coreUrl,
			cacheMethod: 'none'
		})) as unknown as TesseractWorkerLike;
	} catch {
		return null;
	}
}

/**
 * Recognizes the given pages (1-based) of a PDF. Returns page → recognized
 * text for pages that produced any, or null when the OCR engine cannot run
 * here at all (asset fetch failed, no wasm support). Pages are processed
 * sequentially on one worker; `onProgress` fires as each page starts.
 */
export async function recognizePdfPages(
	data: Uint8Array,
	pages: number[],
	onProgress?: (page: number) => void
): Promise<Map<number, string> | null> {
	if (typeof window === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
	const worker = await createTesseractWorker();
	if (!worker) return null;
	const recognized = new Map<number, string>();
	let rasterizer: Awaited<ReturnType<typeof createPageRasterizer>> | undefined;
	try {
		rasterizer = await createPageRasterizer(data);
		for (const page of pages) {
			if (page < 1 || page > rasterizer.pageCount) continue;
			onProgress?.(page);
			try {
				const canvas = await rasterizer.rasterize(page, OCR_SCALE);
				const blob = await canvas.convertToBlob({ type: 'image/png' });
				const result = await worker.recognize(blob, {}, { blocks: true, text: false });
				const text = tesseractBlocksToMarkdown(result.data.blocks);
				if (text) recognized.set(page, text);
			} catch {
				// One unreadable page should not sink the rest.
			}
		}
	} finally {
		await Promise.allSettled([worker.terminate(), rasterizer?.destroy()]);
	}
	return recognized;
}
