/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `voicebook-shell-${version}`;
const PAGES = ['./', './read/', './settings/'];
const ASSETS = [...build, ...files, ...PAGES];
const PRECACHE = ASSETS.filter(
	(asset) =>
		!asset.endsWith('.wasm') &&
		!asset.includes('/workers/') &&
		!asset.includes('pdf.worker') &&
		!asset.includes('soundtouch-processor')
);

worker.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
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

	event.respondWith(
		caches.match(event.request).then(async (cached) => {
			if (cached) return cached;
			try {
				const response = await fetch(event.request);
				if (response.ok && ASSETS.some((asset) => url.pathname.endsWith(asset))) {
					const cache = await caches.open(CACHE);
					await cache.put(event.request, response.clone());
				}
				return response;
			} catch {
				if (event.request.mode === 'navigate') {
					const scope = worker.registration.scope;
					const relativePath = url.pathname.slice(new URL(scope).pathname.length);
					const page = relativePath.startsWith('read')
						? './read/'
						: relativePath.startsWith('settings')
							? './settings/'
							: './';
					return (await caches.match(new URL(page, scope))) ?? Response.error();
				}
				return Response.error();
			}
		})
	);
});
