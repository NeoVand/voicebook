const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;
const CHUNK_QUERY = 'voicebook-model-chunk';

export interface ModelDownloadProgress {
	loaded: number;
	total: number;
	phase: 'download' | 'restore';
}

interface ModelDownloadOptions {
	url: string;
	fetcher: typeof fetch;
	cacheName: string;
	chunkBytes?: number;
	cacheStorage?: CacheStorage;
	onProgress?: (progress: ModelDownloadProgress) => void;
}

function responseSize(response: Response): number {
	const size = Number(response.headers.get('content-length') ?? 0);
	if (!Number.isSafeInteger(size) || size <= 0) {
		throw new Error('The model host did not provide a usable file size. Retry the installation.');
	}
	return size;
}

function chunkRequest(url: string, index: number, chunkBytes: number): Request {
	const key = new URL(url);
	key.searchParams.set(CHUNK_QUERY, `v1-${chunkBytes}-${index}`);
	return new Request(key, { method: 'GET' });
}

function cachedChunkIsValid(response: Response | undefined, expectedSize: number): boolean {
	if (!response) return false;
	return (
		Number(response.headers.get('content-length')) === expectedSize &&
		response.headers.get('x-voicebook-model-chunk') === 'v1'
	);
}

async function ensureStorageCapacity(requiredBytes: number): Promise<void> {
	if (!requiredBytes || typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
	try {
		const estimate = await navigator.storage.estimate();
		const available = Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0));
		if (estimate.quota && requiredBytes > available) {
			throw new Error(
				'This device does not have enough browser storage for the remaining voice model. Free some device storage, then retry.'
			);
		}
	} catch (error) {
		if (error instanceof Error && error.message.includes('enough browser storage')) throw error;
		// Some privacy modes do not expose a usable estimate. Cache Storage will
		// still report QuotaExceededError if the durable write cannot continue.
	}
}

async function readResponse(
	response: Response,
	total: number,
	onProgress?: (loaded: number) => void
): Promise<Uint8Array> {
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength !== total) throw new Error('The cached model file is incomplete.');
		onProgress?.(total);
		return bytes;
	}

	const bytes = new Uint8Array(total);
	const reader = response.body.getReader();
	let offset = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (offset + value.byteLength > total) {
			await reader.cancel();
			throw new Error('The model host returned more data than expected.');
		}
		bytes.set(value, offset);
		offset += value.byteLength;
		onProgress?.(offset);
	}
	if (offset !== total) throw new Error('The model download ended before the file was complete.');
	return bytes;
}

async function cacheChunk(
	cache: Cache,
	request: Request,
	response: Response,
	expectedSize: number,
	onProgress: (loaded: number) => void
): Promise<void> {
	if (!response.ok || !response.body) {
		throw new Error(`Could not download a model chunk (${response.status || 'no response'}).`);
	}

	let loaded = 0;
	const measured = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			loaded += chunk.byteLength;
			if (loaded > expectedSize) {
				controller.error(new Error('The model host returned an oversized download chunk.'));
				return;
			}
			onProgress(loaded);
			controller.enqueue(chunk);
		},
		flush(controller) {
			if (loaded !== expectedSize) {
				controller.error(new Error('The model download chunk ended before it was complete.'));
			}
		}
	});
	const headers = new Headers(response.headers);
	headers.set('content-length', String(expectedSize));
	headers.set('content-type', 'application/octet-stream');
	headers.set('x-voicebook-model-chunk', 'v1');

	try {
		await cache.put(
			request,
			new Response(response.body.pipeThrough(measured), { status: 200, headers })
		);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			throw new Error(
				'This device does not have enough browser storage for the voice model. Free some device storage, then retry.',
				{ cause: error }
			);
		}
		throw error;
	}
}

async function fetchChunkBytes(
	fetcher: typeof fetch,
	url: string,
	start: number,
	end: number,
	onProgress?: (loaded: number) => void
): Promise<Uint8Array> {
	const expectedSize = end - start + 1;
	const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` } });
	if (!response.ok) throw new Error(`Could not download a model chunk (${response.status}).`);
	return readResponse(response, expectedSize, onProgress);
}

async function storeChunkBytes(cache: Cache, request: Request, bytes: Uint8Array): Promise<void> {
	const headers = new Headers({
		'content-length': String(bytes.byteLength),
		'content-type': 'application/octet-stream',
		'x-voicebook-model-chunk': 'v1'
	});
	try {
		await cache.put(request, new Response(new Uint8Array(bytes).buffer, { status: 200, headers }));
	} catch (error) {
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			throw new Error(
				'This device does not have enough browser storage for the voice model. Free some device storage, then retry.',
				{ cause: error }
			);
		}
		throw error;
	}
}

async function readCachedChunks(
	cache: Cache,
	url: string,
	total: number,
	chunkBytes: number,
	fetcher: typeof fetch,
	onProgress?: (progress: ModelDownloadProgress) => void
): Promise<Uint8Array> {
	const bytes = new Uint8Array(total);
	const chunkCount = Math.ceil(total / chunkBytes);
	let restored = 0;
	for (let index = 0; index < chunkCount; index += 1) {
		const start = index * chunkBytes;
		const expected = Math.min(chunkBytes, total - start);
		const request = chunkRequest(url, index, chunkBytes);
		const response = await cache.match(request);
		let chunk: Uint8Array | undefined;
		if (cachedChunkIsValid(response, expected)) {
			chunk = new Uint8Array(await response!.arrayBuffer());
		}
		if (!chunk || chunk.byteLength !== expected) {
			await cache.delete(request);
			const end = start + expected - 1;
			chunk = await fetchChunkBytes(fetcher, url, start, end, (loaded) =>
				onProgress?.({ loaded: restored + loaded, total, phase: 'download' })
			);
			await storeChunkBytes(cache, request, chunk);
		}
		bytes.set(chunk, start);
		restored += chunk.byteLength;
		onProgress?.({ loaded: restored, total, phase: 'restore' });
	}
	return bytes;
}

/**
 * Downloads large ONNX files into durable, individually committed chunks.
 * Only one small chunk is held while downloading, and an interrupted install
 * resumes from the chunks that Cache Storage finished writing.
 */
export async function downloadModelBytes({
	url,
	fetcher,
	cacheName,
	chunkBytes = DEFAULT_CHUNK_BYTES,
	cacheStorage = globalThis.caches,
	onProgress
}: ModelDownloadOptions): Promise<Uint8Array> {
	const cache = cacheStorage ? await cacheStorage.open(cacheName) : undefined;
	const legacy = await cache?.match(url);
	if (legacy) {
		const total = responseSize(legacy);
		return readResponse(legacy, total, (loaded) =>
			onProgress?.({ loaded, total, phase: 'restore' })
		);
	}

	const probe = await fetcher(url);
	if (!probe.ok) throw new Error(`Could not inspect the model file (${probe.status}).`);
	const total = responseSize(probe);
	await probe.body?.cancel();

	if (!cache) {
		const response = await fetcher(url);
		return readResponse(response, total, (loaded) =>
			onProgress?.({ loaded, total, phase: 'download' })
		);
	}

	const chunkCount = Math.ceil(total / chunkBytes);
	const cachedChunks: boolean[] = [];
	let missingBytes = 0;
	for (let index = 0; index < chunkCount; index += 1) {
		const start = index * chunkBytes;
		const expected = Math.min(chunkBytes, total - start);
		const cached = await cache.match(chunkRequest(url, index, chunkBytes));
		const valid = cachedChunkIsValid(cached, expected);
		cachedChunks.push(valid);
		if (!valid) missingBytes += expected;
	}
	await ensureStorageCapacity(missingBytes);

	let completed = 0;
	for (let index = 0; index < chunkCount; index += 1) {
		const start = index * chunkBytes;
		const end = Math.min(total - 1, start + chunkBytes - 1);
		const expected = end - start + 1;
		const request = chunkRequest(url, index, chunkBytes);
		if (cachedChunks[index]) {
			completed += expected;
			onProgress?.({ loaded: completed, total, phase: 'download' });
			continue;
		}
		const cached = await cache.match(request);
		if (cached) await cache.delete(request);

		const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` } });
		await cacheChunk(cache, request, response, expected, (loaded) =>
			onProgress?.({ loaded: completed + loaded, total, phase: 'download' })
		);
		completed += expected;
	}

	return readCachedChunks(cache, url, total, chunkBytes, fetcher, onProgress);
}
