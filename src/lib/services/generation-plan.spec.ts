import { describe, expect, it } from 'vitest';
import { generationPlan } from './generation-plan';

describe('synthesis queue planning', () => {
	it('prioritizes the current unit and a rolling three-unit buffer', () => {
		expect(generationPlan(10, 4)).toEqual([4, 5, 6, 7]);
		expect(generationPlan(3, 2)).toEqual([2]);
	});

	it('reprioritizes invalid seeks and orders generate-all from the current unit', () => {
		expect(generationPlan(5, 99)).toEqual([4]);
		expect(generationPlan(5, 2, 3, true)).toEqual([2, 3, 4, 0, 1]);
		expect(generationPlan(0, 0)).toEqual([]);
	});
});
