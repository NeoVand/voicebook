import type { ModelDescriptor } from '$lib/domain/types';

export const MODEL_ASSET_CACHE = 'voicebook-model-assets-v1';

const LEGACY_REPOSITORY_PATHS = [
	'/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/',
	'/onnx-community/Supertonic-TTS-2-ONNX/resolve/'
];

export async function clearLegacyModelAssets(): Promise<void> {
	if (typeof caches === 'undefined') return;
	for (const cacheName of await caches.keys()) {
		const cache = await caches.open(cacheName);
		const requests = await cache.keys();
		await Promise.all(
			requests
				.filter((request) =>
					LEGACY_REPOSITORY_PATHS.some((path) => new URL(request.url).pathname.includes(path))
				)
				.map((request) => cache.delete(request))
		);
	}
}

export async function clearPinnedModelAssets(model: ModelDescriptor): Promise<void> {
	if (typeof caches === 'undefined') return;
	const cache = await caches.open(MODEL_ASSET_CACHE);
	const repositoryPath = `/${model.repository}/resolve/${model.revision}/`;
	const requests = await cache.keys();
	await Promise.all(
		requests
			.filter((request) => new URL(request.url).pathname.includes(repositoryPath))
			.map((request) => cache.delete(request))
	);
}
