import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, getModel } from './model-catalog';
import type { ModelDescriptor } from './types';

describe('pinned model catalog', () => {
	it('uses immutable revisions, commercial-compatible licenses, and valid defaults', () => {
		expect(MODEL_CATALOG).toHaveLength(1);
		for (const model of MODEL_CATALOG) {
			expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
			expect(['Apache-2.0', 'OpenRAIL-M']).toContain(model.license);
			expect(model.voices.some((voice) => voice.id === model.defaultVoice)).toBe(true);
			expect(model.supportsWebGpu && model.supportsWasm).toBe(true);
			expect(model.voiceCloning).toBe(false);
		}
	});

	it('resolves known models and rejects unknown identifiers', () => {
		expect(getModel('supertonic-3').repository).toBe('Supertone/supertonic-3');
		expect(() => getModel('missing' as ModelDescriptor['id'])).toThrow('Unknown model: missing');
	});
});
