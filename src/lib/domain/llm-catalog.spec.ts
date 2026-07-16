import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LLM_ID,
	LLM_CATALOG,
	QUALITY_LLM_ID,
	canRunLlmModel,
	getLlmModel,
	llmAttemptCascade
} from './llm-catalog';

describe('llm-catalog', () => {
	it('exposes the two narration models with the default first', () => {
		expect(LLM_CATALOG.map((m) => m.id)).toEqual([DEFAULT_LLM_ID, QUALITY_LLM_ID]);
		expect(getLlmModel(DEFAULT_LLM_ID)?.sizeMb).toBe(760);
		expect(getLlmModel('nope')).toBeNull();
	});

	it('requires WebGPU for every current model', () => {
		for (const spec of LLM_CATALOG) {
			expect(spec.requiresWebGpu).toBe(true);
			expect(canRunLlmModel(spec, { webgpu: false, ramGb: null }).ok).toBe(false);
			expect(llmAttemptCascade(spec, { webgpu: false, ramGb: null })).toEqual([]);
			expect(llmAttemptCascade(spec, { webgpu: true, ramGb: null })).toEqual(['webgpu']);
		}
	});

	it('offers a model when WebGPU is present and memory is adequate', () => {
		const spec = getLlmModel(DEFAULT_LLM_ID)!;
		expect(canRunLlmModel(spec, { webgpu: true, ramGb: 8 })).toEqual({ ok: true });
		expect(canRunLlmModel(spec, { webgpu: true, ramGb: null })).toEqual({ ok: true });
	});

	it('declines a model on clearly insufficient memory', () => {
		const spec = getLlmModel(QUALITY_LLM_ID)!;
		const gate = canRunLlmModel(spec, { webgpu: true, ramGb: 2 });
		expect(gate.ok).toBe(false);
		expect(gate.reason).toMatch(/memory/);
	});

	it('keeps the wasm cascade available for future non-WebGPU models', () => {
		const hypothetical = { ...getLlmModel(DEFAULT_LLM_ID)!, requiresWebGpu: false };
		expect(llmAttemptCascade(hypothetical, { webgpu: true, ramGb: null })).toEqual([
			'webgpu',
			'wasm'
		]);
		expect(llmAttemptCascade(hypothetical, { webgpu: false, ramGb: null })).toEqual(['wasm']);
	});
});
