import { describe, expect, it, vi } from 'vitest';
import { downloadModelBytes } from './model-download-cache';

function memoryCacheStorage(): {
	storage: CacheStorage;
	entries: Map<string, { bytes: Uint8Array; headers: Headers }>;
} {
	const entries = new Map<string, { bytes: Uint8Array; headers: Headers }>();
	const key = (request: RequestInfo | URL) =>
		request instanceof Request ? request.url : request.toString();
	const cache = {
		match: vi.fn(async (request: RequestInfo | URL) => {
			const entry = entries.get(key(request));
			return entry
				? new Response(entry.bytes.slice(), { status: 200, headers: new Headers(entry.headers) })
				: undefined;
		}),
		put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
			entries.set(key(request), {
				bytes: new Uint8Array(await response.arrayBuffer()),
				headers: new Headers(response.headers)
			});
		}),
		delete: vi.fn(async (request: RequestInfo | URL) => entries.delete(key(request)))
	} as unknown as Cache;
	return {
		storage: { open: vi.fn(async () => cache) } as unknown as CacheStorage,
		entries
	};
}

function rangeFetcher(source: Uint8Array, failAtStart?: number): typeof fetch {
	return vi.fn<typeof fetch>(async (_input, init) => {
		const range = new Headers(init?.headers).get('range');
		if (!range) {
			return new Response(source.slice(), {
				status: 200,
				headers: { 'content-length': String(source.byteLength) }
			});
		}
		const match = range.match(/^bytes=(\d+)-(\d+)$/);
		if (!match) throw new Error('Unexpected range');
		const start = Number(match[1]);
		const end = Number(match[2]);
		if (start === failAtStart) throw new Error('Network interrupted');
		const bytes = source.slice(start, end + 1);
		return new Response(bytes, {
			status: 206,
			headers: {
				'content-length': String(bytes.byteLength),
				'content-range': `bytes ${start}-${end}/${source.byteLength}`
			}
		});
	}) as typeof fetch;
}

describe('downloadModelBytes', () => {
	it('downloads large files as durable ranges and restores the exact bytes', async () => {
		const source = Uint8Array.from({ length: 11 }, (_, index) => index + 1);
		const { storage, entries } = memoryCacheStorage();
		const fetcher = rangeFetcher(source);
		const progress: number[] = [];

		const result = await downloadModelBytes({
			url: 'https://huggingface.co/org/model/resolve/revision/onnx/model.onnx',
			fetcher,
			cacheName: 'models',
			chunkBytes: 4,
			cacheStorage: storage,
			onProgress: (update) => progress.push(update.loaded)
		});

		expect(result).toEqual(source);
		expect(entries.size).toBe(3);
		expect(progress).toContain(11);
		expect(vi.mocked(fetcher)).toHaveBeenCalledTimes(4);
	});

	it('resumes after an interruption without fetching completed chunks again', async () => {
		const source = Uint8Array.from({ length: 12 }, (_, index) => index + 10);
		const { storage, entries } = memoryCacheStorage();
		const url = 'https://huggingface.co/org/model/resolve/revision/onnx/model.onnx';

		await expect(
			downloadModelBytes({
				url,
				fetcher: rangeFetcher(source, 4),
				cacheName: 'models',
				chunkBytes: 4,
				cacheStorage: storage
			})
		).rejects.toThrow('Network interrupted');
		expect(entries.size).toBe(1);

		const retry = rangeFetcher(source);
		const result = await downloadModelBytes({
			url,
			fetcher: retry,
			cacheName: 'models',
			chunkBytes: 4,
			cacheStorage: storage
		});

		expect(result).toEqual(source);
		const requestedRanges = vi
			.mocked(retry)
			.mock.calls.map(([, init]) => new Headers(init?.headers).get('range'));
		expect(requestedRanges).not.toContain('bytes=0-3');
		expect(requestedRanges).toContain('bytes=4-7');
		expect(requestedRanges).toContain('bytes=8-11');
	});
});
