/**
 * Prompt templates and output sanitation for the narration LLM. Pure module:
 * builds chat messages from a NarrationConstruct and cleans/validates the
 * model's raw output.
 *
 * Templates are user-editable (Settings → Narration). Placeholders:
 *   {{source}}   the construct itself (LaTeX, serialized row, mermaid source, caption)
 *   {{reading}}  the deterministic lecturer reading of an equation (latexToSpeech)
 *   {{header}}   table column names, comma-joined (table rows only)
 *   {{type}}     the detected mermaid diagram kind ("a flowchart", …)
 *   {{context}}  the prose around the construct (for equations this includes
 *                the following sentence, which usually defines the symbols)
 * Few-shot examples are rendered through the ACTIVE template so the model
 * always sees a consistent form, even after edits — except equations, which
 * are deliberately zero-shot (small models copy exemplar symbol names into
 * unrelated equations). Each narration stores a hash of the prompt that
 * produced it, so edits re-queue affected constructs lazily.
 */
import { latexToSpeech } from './latex-speech';
import {
	codeNoun,
	fnv64,
	mermaidNoun,
	type NarrationConstruct,
	type NarrationPromptHashes
} from './narration';
import type { NarrationConstructKind } from './types';

export interface NarrationPromptMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export type NarrationPromptKey =
	'system' | 'math-block' | 'math-inline' | 'table-row' | 'mermaid' | 'code-block' | 'image';

export type NarrationPromptTemplates = Record<NarrationPromptKey, string>;
export type NarrationPromptOverrides = Partial<NarrationPromptTemplates>;

export const DEFAULT_NARRATION_PROMPTS: NarrationPromptTemplates = {
	system: [
		'You turn document fragments into short spoken narration for a text-to-speech reader.',
		'Rules:',
		'- Reply with plain English words only. Nothing else.',
		'- Never output symbols, formulas, LaTeX, code, or markdown. No characters like = + * / ^ _ { } ( ) [ ] | % # or backslash.',
		'- Say everything in words: "x squared", "equals", "seventy one point four percent".',
		'- Do not repeat the input, explain your task, or add introductions.'
	].join('\n'),
	'math-block': [
		'A document reads an equation aloud as: "{{reading}}"',
		'Nearby text: {{context}}',
		'',
		'Write one short sentence naming what the symbols stand for, in the form "Here <symbol> is <what the nearby text calls it>". Use only symbols from the reading and only facts from the nearby text. If the nearby text does not explain the symbols, reply exactly: skip'
	].join('\n'),
	'math-inline': [
		'Say this math expression as a short spoken phrase in plain words. A backslash starts a Greek letter name, "\\mid" reads as "given", an underscore reads as "sub". Reply with only the phrase, nothing else:',
		'',
		'{{source}}'
	].join('\n'),
	'table-row': [
		'A table row with columns {{header}}. Say this row as one short natural sentence in words only, covering every column:',
		'',
		'{{source}}'
	].join('\n'),
	mermaid: [
		'This code draws {{type}}. In at most two short sentences, tell a listener what it shows, in words only:',
		'',
		'{{source}}'
	].join('\n'),
	'code-block': [
		'A document shows this {{type}} snippet:',
		'',
		'{{source}}',
		'',
		'Read it aloud for a listener in plain words. If it is a short list of rules or values, speak each line naturally with numbers and signs as words; otherwise say what it does in one or two short sentences. Words only.'
	].join('\n'),
	image: [
		'A figure has this caption: {{source}}',
		'Announce the figure to a listener in one short sentence, mentioning only what the caption says.'
	].join('\n')
};

export interface NarrationGenerationParams {
	maxNewTokens: number;
	/** Post-sanitation character cap; longer outputs truncate at a sentence. */
	maxChars: number;
	/** Per-kind sampling temperature; 0 = greedy. Math kinds decode greedily —
	 * exemplar faithfulness matters more than variety there. */
	temperature: number;
	/** Equation meanings: 'sentence' keeps only the first sentence (default);
	 * 'explanation' (the educational preset) allows a few sentences up to
	 * maxChars. */
	mathProse?: 'sentence' | 'explanation';
}

export const NARRATION_GENERATION_PARAMS: Record<
	NarrationConstructKind,
	NarrationGenerationParams
> = {
	// math-block generates only the symbol-meaning sentence; the reading
	// itself is deterministic (latexToSpeech) and prepended by the rewriter.
	'math-block': { maxNewTokens: 56, maxChars: 180, temperature: 0 },
	'math-inline': { maxNewTokens: 24, maxChars: 64, temperature: 0 },
	'table-row': { maxNewTokens: 64, maxChars: 200, temperature: 0.2 },
	'table-header': { maxNewTokens: 0, maxChars: 0, temperature: 0 }, // deterministic — never prompted
	mermaid: { maxNewTokens: 112, maxChars: 320, temperature: 0.2 },
	'code-block': { maxNewTokens: 112, maxChars: 320, temperature: 0.2 },
	image: { maxNewTokens: 64, maxChars: 200, temperature: 0.2 }
};

export const NARRATION_TEMPERATURE = 0.2;

const MAX_MERMAID_SOURCE_CHARS = 1500;

/** Few-shot pairs, rendered through the active template at build time. */
const EXEMPLARS: Partial<
	Record<
		NarrationConstructKind,
		Array<{ source: string; header?: string; context?: string; reading?: string; answer: string }>
	>
> = {
	// NOTE: no math-block exemplars on purpose — the 1.2B model copies exemplar
	// symbol names ("x bar", "x sub i") into equations that don't contain them.
	// Zero-shot with the reading in the prompt bleeds nothing.
	'math-inline': [
		{ source: '\\pi(a \\mid s)', answer: 'pi of a given s' },
		{ source: 's_{t+1}', answer: 's sub t plus one' },
		{ source: 'O(n \\log n)', answer: 'big O of n log n' },
		{ source: 'p^n', answer: 'p to the power n' }
	],
	'table-row': [
		{
			source: 'Model: LFM 2.5 | Parameters: 1.2 billion | Accuracy: 71.4%',
			header: 'Model, Parameters, Accuracy',
			answer:
				'The model LFM two point five has one point two billion parameters and seventy one point four percent accuracy.'
		}
	],
	'code-block': [
		{
			source: '+1 per second alive\n-100 if eaten',
			answer: 'Plus one point per second alive, and minus one hundred if eaten.'
		},
		{
			source: 'def mean(xs):\n    return sum(xs) / len(xs)',
			answer:
				'A short Python function that returns the mean of a list by dividing its sum by its length.'
		}
	],
	mermaid: [
		{
			source:
				'flowchart LR\n  A[User] --> B[Parser]\n  B --> C{Valid?}\n  C -->|yes| D[Renderer]\n  C -->|no| E[Error message]',
			answer:
				'A flowchart where user input goes to a parser and then a validity check. Valid input reaches the renderer and invalid input shows an error message.'
		},
		{
			source:
				'sequenceDiagram\n  participant C as Client\n  participant S as Server\n  C->>S: request page\n  S-->>C: HTML response',
			answer:
				'A sequence diagram where a client requests a page from a server and the server replies with the page.'
		}
	],
	image: [
		{
			source: 'Fig 3: validation loss vs epochs for three seeds',
			answer: 'A figure showing validation loss against training epochs for three random seeds.'
		}
	]
};

export function resolveNarrationPrompts(
	overrides?: NarrationPromptOverrides
): NarrationPromptTemplates {
	return { ...DEFAULT_NARRATION_PROMPTS, ...(overrides ?? {}) };
}

function templateKeyFor(kind: NarrationConstructKind): NarrationPromptKey | null {
	if (
		kind === 'math-block' ||
		kind === 'math-inline' ||
		kind === 'table-row' ||
		kind === 'mermaid' ||
		kind === 'code-block' ||
		kind === 'image'
	) {
		return kind;
	}
	return null;
}

/** The prompt hash per LLM-narrated kind, for reconcile invalidation. */
export function narrationPromptHashes(overrides?: NarrationPromptOverrides): NarrationPromptHashes {
	const prompts = resolveNarrationPrompts(overrides);
	const hashes: NarrationPromptHashes = {};
	for (const kind of [
		'math-block',
		'math-inline',
		'table-row',
		'mermaid',
		'code-block',
		'image'
	] as const) {
		hashes[kind] = fnv64(`${prompts.system}\n--\n${prompts[kind]}`);
	}
	return hashes;
}

function renderTemplate(
	template: string,
	vars: { source: string; header: string; context: string; type: string; reading: string }
): string {
	return template
		.replaceAll('{{source}}', vars.source)
		.replaceAll('{{header}}', vars.header)
		.replaceAll('{{context}}', vars.context)
		.replaceAll('{{type}}', vars.type)
		.replaceAll('{{reading}}', vars.reading)
		.trim();
}

function trimContext(context: string, limit = 240): string {
	const collapsed = context.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= limit) return collapsed;
	const slice = collapsed.slice(-limit);
	const sentence = slice.search(/[.!?]\s/);
	return sentence >= 0 && sentence < limit / 2 ? slice.slice(sentence + 2) : slice;
}

export function buildNarrationMessages(
	construct: NarrationConstruct,
	documentContext: string,
	options: { overrides?: NarrationPromptOverrides; strict?: boolean } = {}
): NarrationPromptMessage[] {
	const prompts = resolveNarrationPrompts(options.overrides);
	const key = templateKeyFor(construct.kind);
	if (!key || key === 'system') return [];
	const template = prompts[key];
	const header = (construct.context?.header ?? [])
		.map((cell) => cell.trim())
		.filter(Boolean)
		.join(', ');
	const source =
		(construct.kind === 'mermaid' || construct.kind === 'code-block') &&
		construct.source.length > MAX_MERMAID_SOURCE_CHARS
			? `${construct.source.slice(0, MAX_MERMAID_SOURCE_CHARS)}\n${construct.kind === 'mermaid' ? '%% diagram continues' : '… snippet continues'}`
			: construct.source;

	const nounFor = (candidateSource: string, language?: string): string => {
		if (construct.kind === 'mermaid') return mermaidNoun(candidateSource);
		if (construct.kind === 'code-block') return codeNoun(language);
		return '';
	};
	const messages: NarrationPromptMessage[] = [{ role: 'system', content: prompts.system }];
	for (const exemplar of EXEMPLARS[construct.kind] ?? []) {
		messages.push(
			{
				role: 'user',
				content: renderTemplate(template, {
					source: exemplar.source,
					header: exemplar.header ?? header,
					context: exemplar.context ?? '',
					type: nounFor(exemplar.source, undefined),
					reading: exemplar.reading ?? ''
				})
			},
			{ role: 'assistant', content: exemplar.answer }
		);
	}
	const live = renderTemplate(template, {
		source,
		header,
		context: trimContext(documentContext, 480),
		type: nounFor(construct.source, construct.context?.language),
		reading:
			construct.kind === 'math-block' ? (latexToSpeech(construct.source) ?? construct.source) : ''
	});
	messages.push({
		role: 'user',
		content: live + (options.strict ? '\nRemember: words only, one or two short sentences.' : '')
	});
	return messages;
}

/** Small models drop Unicode math and Greek into otherwise-good prose;
 * transliterate the speakable ones to words before validating. */
const UNICODE_TO_WORDS: Array<[RegExp, string]> = [
	[/[×·⋅]/g, ' times '],
	[/±/g, ' plus or minus '],
	[/≤/g, ' at most '],
	[/≥/g, ' at least '],
	[/≠/g, ' not equal to '],
	[/≈/g, ' approximately '],
	[/[→⇒]/g, ' to '],
	[/∞/g, ' infinity '],
	[/α/gi, ' alpha '],
	[/β/gi, ' beta '],
	[/γ/gi, ' gamma '],
	[/δ/gi, ' delta '],
	[/ε/gi, ' epsilon '],
	[/ζ/gi, ' zeta '],
	[/η/gi, ' eta '],
	[/θ/gi, ' theta '],
	[/κ/gi, ' kappa '],
	[/λ/gi, ' lambda '],
	[/μ/gi, ' mu '],
	[/ν/gi, ' nu '],
	[/ξ/gi, ' xi '],
	[/π/gi, ' pi '],
	[/ρ/gi, ' rho '],
	[/σ/gi, ' sigma '],
	[/τ/gi, ' tau '],
	[/φ/gi, ' phi '],
	[/χ/gi, ' chi '],
	[/ψ/gi, ' psi '],
	[/ω/gi, ' omega ']
];

/** Characters that must never appear in spoken narration. Presentational
 * markdown (* _ ` #) is stripped first and speakable Unicode transliterated;
 * anything in this set that survives means the model answered with notation
 * instead of words. */
const FORBIDDEN_OUTPUT = /[\\=+^{}[\]|<>~$&@%()/]|[∀-⋿⟨⟩]|\d+\s*[*·]\s*\d/;

/**
 * Clean the model's raw output into speakable prose, or return null when the
 * output is unusable (the caller retries once with a strict prompt, then
 * falls back to the deterministic narration).
 */
export function sanitizeNarration(
	raw: string,
	kind: NarrationConstructKind,
	params: NarrationGenerationParams = NARRATION_GENERATION_PARAMS[kind]
): string | null {
	let text = (raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, ' ');
	text = text.replace(/<[^>\n]{0,120}>/g, ' ');
	const blank = text.search(/\n\s*\n/);
	if (blank >= 0) text = text.slice(0, blank);
	text = text.trim();
	text = text.replace(/^(?:sure|okay|of course|certainly)[,.!:]?\s+/i, '');
	text = text.replace(
		/^(?:here(?:'s| is)|this is)\s+(?:the\s+)?(?:narration|description|spoken (?:version|text)|text|sentence)[:.,]?\s*/i,
		''
	);
	text = text.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
	text = text.replace(/[*_#`]+/g, ' ');
	for (const [pattern, replacement] of UNICODE_TO_WORDS) {
		text = text.replace(pattern, replacement);
	}
	text = text.replace(/\s+/g, ' ').trim();
	if (!text) return null;
	if (FORBIDDEN_OUTPUT.test(text)) return null;
	const letters = (text.match(/\p{L}/gu) ?? []).length;
	if (letters < text.length * 0.55) return null;

	// Inline expressions are phrases spliced into a sentence: no terminal
	// period, and a phrase too long to splice is rejected outright rather
	// than truncated mid-thought.
	if (kind === 'math-inline') {
		text = text.replace(/[.!?]+$/, '').trim();
		if (text.length > params.maxChars) return null;
		return text || null;
	}

	// The equation prompt asks for one symbol-meaning sentence starting with
	// "Here …" (or an explicit "skip"); anything else is the model
	// summarizing again, and an unfinished ramble is worse than nothing.
	// Rejecting is safe — the deterministic reading alone is already a good
	// narration. Vacuous compliance ("Here we discuss the symbols") rejects
	// too; the rewriter additionally verifies that any symbol the sentence
	// names actually occurs in the reading.
	if (kind === 'math-block') {
		if (/^skip\b/i.test(text)) return null;
		if (!/^here\b/i.test(text)) return null;
		if (/^here (?:we|the symbols|are the)\b/i.test(text)) return null;
		const firstSentence = text.match(/^[^.!?]+[.!?]/)?.[0];
		if (!firstSentence || !/\b(?:is|are|stands for|means|denotes)\b/i.test(firstSentence)) {
			return null;
		}
		// The educational preset keeps the whole explanation (up to its cap,
		// trimmed at a sentence boundary); everything else keeps one sentence.
		if (params.mathProse !== 'explanation') return firstSentence.trim();
		if (params.maxChars > 0 && text.length > params.maxChars) {
			const slice = text.slice(0, params.maxChars);
			const sentenceEnd = Math.max(
				slice.lastIndexOf('. '),
				slice.lastIndexOf('! '),
				slice.lastIndexOf('? ')
			);
			text = sentenceEnd > 0 ? slice.slice(0, sentenceEnd + 1) : firstSentence;
		}
		return text.trim();
	}

	const cap = params.maxChars;
	if (cap > 0 && text.length > cap) {
		const slice = text.slice(0, cap);
		const sentenceEnd = Math.max(
			slice.lastIndexOf('. '),
			slice.lastIndexOf('! '),
			slice.lastIndexOf('? ')
		);
		if (sentenceEnd > cap * 0.4) {
			text = slice.slice(0, sentenceEnd + 1);
		} else {
			const wordEnd = slice.lastIndexOf(' ');
			text = wordEnd > 0 ? slice.slice(0, wordEnd) : slice;
		}
		text = text.trim();
	}
	return text || null;
}
