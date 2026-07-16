/**
 * Storage management for narration-model weights. transformers.js persists
 * every fetched file in the Cache Storage cache named 'transformers-cache',
 * keyed by its full download URL:
 *   https://huggingface.co/{modelId}/resolve/{revision}/…
 * Deletion therefore matches entries by hostname + path prefix — never by
 * substring, so sibling repositories can't be caught by accident.
 */

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

export async function deleteLlmModelAssets(modelId: string): Promise<void> {
	if (typeof caches === 'undefined') return;
	try {
		const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			if (url.hostname.endsWith('huggingface.co') && url.pathname.startsWith(`/${modelId}/`)) {
				await cache.delete(request);
			}
		}
	} catch {
		// Cache Storage unavailable (private mode, etc.) — nothing to clean.
	}
}

/** Whether any weights for the model are present in the transformers cache.
 * Used to reconcile the installed flag with physical reality on boot. */
export async function hasLlmModelAssets(modelId: string): Promise<boolean> {
	if (typeof caches === 'undefined') return false;
	try {
		const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
		for (const request of await cache.keys()) {
			const url = new URL(request.url);
			if (url.hostname.endsWith('huggingface.co') && url.pathname.startsWith(`/${modelId}/`)) {
				return true;
			}
		}
	} catch {
		// Fall through to false.
	}
	return false;
}
