import { describe, expect, it } from 'vitest';
import { meaningGroundedInReading } from './narration-rewriter';

const READING =
	'G sub t equals the expected value of, the sum from k equals zero to infinity of gamma to the k r sub t plus k plus one';

describe('meaningGroundedInReading', () => {
	it('accepts sentences that only name symbols present in the reading', () => {
		expect(
			meaningGroundedInReading('Here gamma is the discount factor and G is the return.', READING)
		).toBe(true);
	});

	it('rejects exemplar/context bleed naming symbols the equation lacks', () => {
		expect(meaningGroundedInReading('Here x bar is the average of the data.', READING)).toBe(false);
		expect(meaningGroundedInReading('Here theta is a parameter of the model.', READING)).toBe(
			false
		);
		expect(meaningGroundedInReading('Here V is the value function.', READING)).toBe(false);
	});

	it('ignores ordinary prose words', () => {
		expect(meaningGroundedInReading('Here the reward accumulates over time.', READING)).toBe(true);
	});
});
