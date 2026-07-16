import { describe, expect, it } from 'vitest';
import {
	CLOUD_LLM_PROVIDERS,
	ELEVENLABS_MODELS,
	defaultCloudLlmModel,
	getCloudLlmProvider,
	isCloudLlmProvider
} from './provider-catalog';

describe('cloud LLM provider catalog', () => {
	it('exposes three providers, each with a default model first', () => {
		expect(CLOUD_LLM_PROVIDERS.map((provider) => provider.id)).toEqual([
			'anthropic',
			'openai',
			'gemini'
		]);
		for (const provider of CLOUD_LLM_PROVIDERS) {
			expect(provider.models.length).toBeGreaterThan(0);
			expect(defaultCloudLlmModel(provider.id)).toBe(provider.models[0].id);
		}
	});

	it('guards engine ids', () => {
		expect(isCloudLlmProvider('anthropic')).toBe(true);
		expect(isCloudLlmProvider('local')).toBe(false);
		expect(isCloudLlmProvider('elevenlabs')).toBe(false);
		expect(getCloudLlmProvider('nope')).toBeNull();
	});
});

describe('elevenlabs model catalog', () => {
	it('defaults to the highest-quality timestamp-capable model', () => {
		expect(ELEVENLABS_MODELS[0].id).toBe('eleven_multilingual_v2');
		// v3 has no with-timestamps support — word highlighting depends on it.
		expect(ELEVENLABS_MODELS.some((model) => model.id === 'eleven_v3')).toBe(false);
	});
});
