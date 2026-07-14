import { downloadFile } from '@huggingface/hub';

interface HuggingFaceAsset {
	repository: string;
	revision: string;
	path: string;
}

function assetFromUrl(input: RequestInfo | URL): HuggingFaceAsset | null {
	const rawUrl = input instanceof Request ? input.url : input.toString();
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}
	if (url.hostname !== 'huggingface.co' && url.hostname !== 'hf.co') return null;

	const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
	if (!match) return null;
	return {
		repository: `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
		revision: decodeURIComponent(match[3]),
		path: match[4]
			.split('/')
			.map((part) => decodeURIComponent(part))
			.join('/')
	};
}

function requestRange(input: RequestInfo | URL, init?: RequestInit): [number, number?] | null {
	const headers = new Headers(input instanceof Request ? input.headers : undefined);
	if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
	const match = headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/i);
	if (!match) return null;
	return [Number(match[1]), match[2] ? Number(match[2]) : undefined];
}

/**
 * Fetches Hub assets through the browser Xet reader instead of following the
 * legacy CAS redirect. Some Xet-backed public files currently return a 403 at
 * that redirect even though the repository and artifact are public.
 */
export function createHuggingFaceFetch(nativeFetch: typeof fetch): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const asset = assetFromUrl(input);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : 'GET')
		).toUpperCase();
		if (!asset || method !== 'GET') return nativeFetch(input, init);

		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const hubFetch: typeof fetch = (hubInput, hubInit) =>
			nativeFetch(hubInput, { ...hubInit, signal: signal ?? hubInit?.signal });
		const blob = await downloadFile({
			repo: { type: 'model', name: asset.repository },
			path: asset.path,
			revision: asset.revision,
			fetch: hubFetch
		});
		if (!blob) return new Response(null, { status: 404, statusText: 'Not Found' });

		const range = requestRange(input, init);
		if (range) {
			const start = Math.min(range[0], blob.size);
			const end = Math.min(range[1] ?? blob.size - 1, blob.size - 1);
			const slice = blob.slice(start, end + 1);
			return new Response(slice.stream(), {
				status: 206,
				headers: {
					'accept-ranges': 'bytes',
					'content-length': String(slice.size),
					'content-range': `bytes ${start}-${end}/${blob.size}`,
					'content-type': 'application/octet-stream'
				}
			});
		}

		return new Response(blob.stream(), {
			status: 200,
			headers: {
				'accept-ranges': 'bytes',
				'content-length': String(blob.size),
				'content-type': 'application/octet-stream'
			}
		});
	}) as typeof fetch;
}
