import { describe, expect, it } from 'vitest';
import { latexToSpeech } from './latex-speech';

describe('latexToSpeech', () => {
	it('reads the discounted-return equation like a lecturer', () => {
		expect(
			latexToSpeech(
				'G_t = \\mathbb{E}\\left[ \\sum_{k=0}^{\\infty} \\gamma^k \\, r_{t+k+1} \\right], \\qquad 0 \\le \\gamma < 1'
			)
		).toBe(
			'G sub t equals the expected value of, the sum from k equals zero to infinity of gamma to the k r sub t plus k plus one, zero is less than or equal to gamma is less than one'
		);
	});

	it('reads the Bellman equation', () => {
		expect(
			latexToSpeech(
				"V^{\\pi}(s) = \\sum_{a} \\pi(a \\mid s) \\sum_{s'} P(s' \\mid s, a)\\left[ R(s, a, s') + \\gamma \\, V^{\\pi}(s') \\right]"
			)
		).toBe(
			'V pi of s equals, the sum over a of pi of a given s, the sum over s prime of P of s prime given s and a, R of s and a and s prime plus gamma V pi of s prime'
		);
	});

	it('reads sampled-policy notation', () => {
		expect(latexToSpeech('a_t \\sim \\pi_\\theta(\\,\\cdot \\mid s_t\\,)')).toBe(
			'a sub t is distributed as pi sub theta of dot given s sub t'
		);
	});

	it('reads inline expressions as short phrases', () => {
		expect(latexToSpeech('\\pi(a \\mid s)')).toBe('pi of a given s');
		expect(latexToSpeech('p^n')).toBe('p to the n');
		expect(latexToSpeech('s_{t+1}')).toBe('s sub t plus one');
		expect(latexToSpeech('O(n \\log n)')).toBe('O of n log n');
		expect(latexToSpeech('E = mc^2')).toBe('E equals m c squared');
		expect(latexToSpeech('p = 0.98')).toBe('p equals 0.98');
	});

	it('reads fractions, means, and norms', () => {
		expect(latexToSpeech('\\bar{x} = \\frac{1}{n} \\sum_{i=1}^{n} x_i')).toBe(
			'x bar equals one over n, the sum from i equals one to n of x sub i'
		);
		expect(latexToSpeech('\\lambda \\lVert w \\rVert^2')).toBe('lambda the norm of w squared');
	});

	it('returns null for anything it does not fully understand', () => {
		expect(latexToSpeech('\\mystery{x}')).toBeNull();
		expect(latexToSpeech('\\begin{matrix} a & b \\end{matrix}')).toBeNull();
		expect(latexToSpeech('')).toBeNull();
	});
});
