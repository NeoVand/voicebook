import { describe, expect, it } from 'vitest';
import { applySpokenStyle } from './spoken-style';
import {
	DEFAULT_LISTENING_MODE,
	isListeningMode,
	skipsBackMatter,
	spokenRulesFor
} from './listening-modes';

describe('listening modes', () => {
	it('defaults to natural', () => {
		expect(DEFAULT_LISTENING_MODE).toBe('natural');
	});

	it('recognizes valid mode strings', () => {
		expect(isListeningMode('verbatim')).toBe(true);
		expect(isListeningMode('focused')).toBe(true);
		expect(isListeningMode('loud')).toBe(false);
		expect(isListeningMode(undefined)).toBe(false);
	});

	it('only skips back matter outside verbatim', () => {
		expect(skipsBackMatter('verbatim')).toBe(false);
		expect(skipsBackMatter('natural')).toBe(true);
		expect(skipsBackMatter('focused')).toBe(true);
	});

	const spoken = (mode: 'verbatim' | 'natural' | 'focused', text: string) =>
		applySpokenStyle(text, spokenRulesFor(mode)).spoken;

	it('verbatim reads citations and abbreviations literally (URLs still collapse)', () => {
		expect(spoken('verbatim', 'See Fig. 2 [3] for details.')).toBe('See Fig. 2 [3] for details.');
		expect(spoken('verbatim', 'Read https://example.com/x now.')).toBe(
			'Read a link in the document now.'
		);
	});

	it('natural drops citations and expands abbreviations', () => {
		expect(spoken('natural', 'See Fig. 2 [3] for details.')).toBe('See Figure 2 for details.');
	});

	it('focused also elides cross-references and pointer asides', () => {
		expect(spoken('focused', 'The trend holds (see Section 3) across runs.')).toBe(
			'The trend holds across runs.'
		);
		expect(spoken('focused', 'As shown (Fig. 4), accuracy rises.')).toBe(
			'As shown, accuracy rises.'
		);
		// Natural keeps those asides.
		expect(spoken('natural', 'The trend holds (see Section 3) across runs.')).toBe(
			'The trend holds (see Section 3) across runs.'
		);
	});

	it('keeps see/cf asides without a numeric target', () => {
		expect(spoken('focused', 'A caution (see, this matters) remains.')).toBe(
			'A caution (see, this matters) remains.'
		);
	});

	it('stays linear on adversarial cross-reference input (focused mode)', () => {
		// The combined-branch pattern this replaced was quadratic: two [^()]*
		// around \d with a required \) blew up when the paren never closed.
		const unclosed = '(see 1' + '1'.repeat(20_000);
		const start = performance.now();
		spoken('focused', unclosed);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
