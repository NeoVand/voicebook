import { describe, expect, it } from 'vitest';
import {
	DEFAULT_GENERATION_STEPS,
	GENERATION_STEP_OPTIONS,
	normalizeGenerationSteps
} from './synthesis';

describe('generation quality', () => {
	it('offers every supported step count and defaults to ten', () => {
		expect(GENERATION_STEP_OPTIONS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
		expect(DEFAULT_GENERATION_STEPS).toBe(10);
	});

	it('rounds and clamps persisted or user-provided values', () => {
		expect(normalizeGenerationSteps(1)).toBe(2);
		expect(normalizeGenerationSteps(10.4)).toBe(10);
		expect(normalizeGenerationSteps('12')).toBe(12);
		expect(normalizeGenerationSteps(99)).toBe(16);
		expect(normalizeGenerationSteps('not-a-number')).toBe(10);
	});
});
