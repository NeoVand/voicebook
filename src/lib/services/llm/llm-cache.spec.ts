import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteLlmModelAssets, hasLlmModelAssets, TRANSFORMERS_CACHE_NAME } from './llm-cache';

class FakeCache {
	entries = new Map<string, Request>();

	seed(urls: string[]) {
		for (const url of urls) this.entries.set(url, new Request(url));
	}

	async keys(): Promise<Request[]> {
		return [...this.entries.values()];
	}

	async delete(request: Request): Promise<boolean> {
		return this.entries.delete(request.url);
	}
}

describe('llm-cache', () => {
	const fake = new FakeCache();
	let original: unknown;

	beforeEach(() => {
		fake.entries.clear();
		original = Reflect.get(globalThis, 'caches');
		Object.defineProperty(globalThis, 'caches', {
			value: {
				open: async (name: string) => {
					expect(name).toBe(TRANSFORMERS_CACHE_NAME);
					return fake;
				}
			},
			configurable: true
		});
	});

	afterEach(() => {
		if (original === undefined) Reflect.deleteProperty(globalThis, 'caches');
		else Object.defineProperty(globalThis, 'caches', { value: original, configurable: true });
	});

	it('deletes only entries under the exact model path prefix', async () => {
		fake.seed([
			'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/resolve/main/config.json',
			'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/resolve/main/onnx/model_q4f16.onnx',
			'https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX/resolve/main/config.json',
			// Sibling repo whose name merely contains the model id as substring.
			'https://huggingface.co/evil/LiquidAI/LFM2.5-1.2B-Instruct-ONNX-clone/resolve/main/x.onnx',
			'https://cdn.example.com/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/thing.bin'
		]);
		await deleteLlmModelAssets('LiquidAI/LFM2.5-1.2B-Instruct-ONNX');
		const remaining = [...fake.entries.keys()];
		expect(remaining).toEqual([
			'https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX/resolve/main/config.json',
			'https://huggingface.co/evil/LiquidAI/LFM2.5-1.2B-Instruct-ONNX-clone/resolve/main/x.onnx',
			'https://cdn.example.com/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/thing.bin'
		]);
	});

	it('reports whether a model has cached assets', async () => {
		await expect(hasLlmModelAssets('LiquidAI/LFM2.5-1.2B-Instruct-ONNX')).resolves.toBe(false);
		fake.seed([
			'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX/resolve/main/config.json'
		]);
		await expect(hasLlmModelAssets('LiquidAI/LFM2.5-1.2B-Instruct-ONNX')).resolves.toBe(true);
		await expect(hasLlmModelAssets('onnx-community/Qwen3.5-2B-ONNX')).resolves.toBe(false);
	});
});
