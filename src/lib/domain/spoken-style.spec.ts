import { describe, expect, it } from 'vitest';
import { wordsFor } from './speech-words';
import { applySpokenStyle, normalizeForSpeech, spokenWordSpans } from './spoken-style';

/** The contract the whole highlight pipeline depends on: one span per spoken
 * word, in the same order, pointing at monotonic display ranges inside the
 * source. Asserted for every example so no rule can quietly desync. */
function expectInvariant(text: string) {
	const { spoken, spans } = applySpokenStyle(text);
	const tokens = wordsFor(spoken);
	expect(spans.map((s) => s.text)).toEqual(tokens.map((t) => t.text));
	for (let i = 1; i < spans.length; i += 1) {
		expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].start);
	}
	for (const span of spans) {
		expect(span.start).toBeGreaterThanOrEqual(0);
		expect(span.end).toBeLessThanOrEqual(text.length);
	}
}

describe('citation elision', () => {
	it('drops bracketed numeric references from speech', () => {
		expect(normalizeForSpeech('The method [2] outperforms prior work [3, 5].')).toBe(
			'The method outperforms prior work.'
		);
		expect(normalizeForSpeech('Shown earlier [12-15] and later [1][2].')).toBe(
			'Shown earlier and later.'
		);
	});

	it('keeps superscripts (an exponent is not reliably a footnote marker)', () => {
		expect(normalizeForSpeech('This result² holds.')).toBe('This result² holds.');
	});

	it('preserves decimals when pulling punctuation (highlight invariant)', () => {
		// The punctuation-pull must not fuse "10 .5" into one number token, or
		// the spoken word count would diverge from the display spans.
		const { spoken, spans } = applySpokenStyle('See Fig. 3, the value 10 .5 held.');
		expect(spans.length).toBe(wordsFor(spoken).length);
	});

	it('drops conservative author–year parentheticals but keeps prose', () => {
		expect(normalizeForSpeech('Transformers (Vaswani et al., 2017) changed everything.')).toBe(
			'Transformers changed everything.'
		);
		expect(normalizeForSpeech('Prior work (Smith and Jones, 2019; Lee, 2020) agrees.')).toBe(
			'Prior work agrees.'
		);
		// A year mentioned in running prose is not a citation.
		expect(normalizeForSpeech('In 2020 we ran the study.')).toBe('In 2020 we ran the study.');
		// Non-citation parentheticals survive (declined by the citation rule).
		expect(normalizeForSpeech('The sample (n = 30) was small.')).toBe(
			'The sample (n = 30) was small.'
		);
		expect(normalizeForSpeech('A caution (a key aside) remains.')).toBe(
			'A caution (a key aside) remains.'
		);
	});

	it('stays linear on adversarial parentheticals (no catastrophic backtracking)', () => {
		const unclosed = '(A' + ', 2020;'.repeat(6000);
		const start = performance.now();
		normalizeForSpeech(unclosed);
		expect(performance.now() - start).toBeLessThan(500);
	});

	it('keeps every citation display range unhighlighted while neighbors map to themselves', () => {
		const text = 'Method [2] wins.';
		const spans = spokenWordSpans(text);
		expect(spans.map((s) => s.text)).toEqual(['Method', 'wins']);
		expect(spans[0]).toMatchObject({ start: 0, end: 6 });
		// "wins" sits after the elided "[2] ".
		expect(spans[1].start).toBe(text.indexOf('wins'));
	});
});

describe('abbreviation and symbol expansion', () => {
	it('expands common academic abbreviations', () => {
		expect(normalizeForSpeech('See Fig. 2 and Eq. 3 in Sec. 4.')).toBe(
			'See Figure 2 and Equation 3 in Section 4.'
		);
		expect(normalizeForSpeech('Others report similar gains, e.g., faster runs.')).toBe(
			'Others report similar gains, for example, faster runs.'
		);
		expect(normalizeForSpeech('Model A vs. Model B, approx. 5% better.')).toBe(
			'Model A versus Model B, approximately 5 percent better.'
		);
	});

	it('expands et al. wherever it appears, not only in citations', () => {
		expect(normalizeForSpeech('Following Vaswani et al. we use attention.')).toBe(
			'Following Vaswani and colleagues we use attention.'
		);
	});

	it('guards abbreviations that collide with ordinary words', () => {
		// "No" without a following number is not "number".
		expect(normalizeForSpeech('No, that is wrong.')).toBe('No, that is wrong.');
		expect(normalizeForSpeech('See No. 7 below.')).toBe('See number 7 below.');
	});

	it('reads number ranges and symbols the way a person would', () => {
		expect(normalizeForSpeech('Pages 12-15 cover it.')).toBe('Pages 12 to 15 cover it.');
		// A range at the end of a sentence still converts…
		expect(normalizeForSpeech('See pages 5-9.')).toBe('See pages 5 to 9.');
		// …but decimals, years, and phone numbers are left alone.
		expect(normalizeForSpeech('A ratio of 5-9.5 held.')).toBe('A ratio of 5-9.5 held.');
		expect(normalizeForSpeech('From 2020-2021 and call 555-1234.')).toBe(
			'From 2020-2021 and call 555-1234.'
		);
		expect(normalizeForSpeech('Accuracy was 95% ± 2%.')).toBe(
			'Accuracy was 95 percent plus or minus 2 percent.'
		);
		expect(normalizeForSpeech('About ~50 samples.')).toBe('About approximately 50 samples.');
	});
});

describe('links still resolve to the spoken pointer', () => {
	it('replaces URLs and keeps bare dotted names', () => {
		expect(normalizeForSpeech('Read https://example.com/docs now.')).toBe(
			'Read a link in the document now.'
		);
		expect(normalizeForSpeech('Node.js reads vite.config.ts fine.')).toBe(
			'Node.js reads vite.config.ts fine.'
		);
	});
});

describe('rules compose without breaking the invariant', () => {
	const samples = [
		'The method [2] beats Fig. 3 by approx. 10% (Smith et al., 2020).',
		'See Sec. 2, Eq. 4, and pages 5-9 for details [1, 2, 3].',
		'Plain prose with no rewrites at all here.',
		'A URL https://a.io/x, a range 3-7, and a note² together.',
		'Results (n = 12) improved vs. baseline, e.g., on task A.',
		'§3 and No. 4 and ± values and ~5 items.',
		'Edge [2][3][4] back to back citations only.',
		'Nothing but 2-3 numbers 4-5 in a row 6-7.'
	];

	it('holds the display-span alignment for every sample', () => {
		for (const sample of samples) expectInvariant(sample);
	});

	it('leaves empty and punctuation-only input intact', () => {
		expect(normalizeForSpeech('')).toBe('');
		expect(normalizeForSpeech('   ')).toBe('');
		expectInvariant('!!! ??? ...');
	});
});
