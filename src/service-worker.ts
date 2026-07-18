/// <reference lib="webworker" />

import { base, build, files, prerendered, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `voicebook-shell-${version}`;
const ASSETS = [...build, ...files, ...prerendered];
/** Heavy assets stay out of the install-time precache (the OCR engine alone
 * is ~7 MB and most users never import a scanned PDF) and are instead cached
 * on first successful fetch below, so the original-page view and OCR keep
 * working offline once used. */
const heavyAsset = (asset: string) =>
	asset.endsWith('.wasm') ||
	asset.includes('/workers/') ||
	asset.includes('worker.min') ||
	asset.includes('pdf.worker') ||
	asset.includes('soundtouch-processor') ||
	asset.includes('tesseract') ||
	asset.includes('traineddata');
const PRECACHE = ASSETS.filter((asset) => !heavyAsset(asset));
const RUNTIME_CACHEABLE = new Set(ASSETS.filter(heavyAsset));

worker.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

worker.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith('voicebook-shell-') && key !== CACHE)
						.map((key) => caches.delete(key))
				)
			)
			.then(() => worker.clients.claim())
	);
});

worker.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return;
	const url = new URL(event.request.url);
	if (url.origin !== worker.location.origin) return;

	if (event.request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				try {
					return await fetch(new Request(event.request, { cache: 'no-store' }));
				} catch {
					const relativePath = url.pathname.slice(base.length).replace(/^\//, '');
					const route = relativePath.startsWith('read')
						? `${base}/read`
						: relativePath.startsWith('settings')
							? `${base}/settings`
							: `${base}/`;
					// The prerendered shell may be cached with or without a trailing
					// slash depending on the adapter; a query string must never
					// defeat the match. The root shell is the last resort — an error
					// response here leaves the user staring at a dead tab.
					const shell =
						(await caches.match(route, { ignoreSearch: true })) ??
						(await caches.match(`${route}/`, { ignoreSearch: true })) ??
						(await caches.match(`${base}/`, { ignoreSearch: true }));
					return shell ?? Response.error();
				}
			})()
		);
		return;
	}

	event.respondWith(
		(async () => {
			const cached = await caches.match(event.request);
			if (cached) return cached;
			try {
				const response = await fetch(event.request);
				if (response.ok && RUNTIME_CACHEABLE.has(url.pathname)) {
					const copy = response.clone();
					void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				}
				return response;
			} catch {
				return Response.error();
			}
		})()
	);
});
