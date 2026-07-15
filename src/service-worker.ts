/// <reference lib="webworker" />

import { base, build, files, prerendered, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `voicebook-shell-${version}`;
const ASSETS = [...build, ...files, ...prerendered];
const PRECACHE = ASSETS.filter(
	(asset) =>
		!asset.endsWith('.wasm') &&
		!asset.includes('/workers/') &&
		!asset.includes('pdf.worker') &&
		!asset.includes('soundtouch-processor')
);

worker.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => worker.skipWaiting())
	);
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
						? `${base}/read/`
						: relativePath.startsWith('settings')
							? `${base}/settings/`
							: `${base}/`;
					return (await caches.match(route)) ?? Response.error();
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
				return await fetch(event.request);
			} catch {
				return Response.error();
			}
		})()
	);
});
