/**
 * Description styles: how much the language model says about each construct.
 * A preset bundles the prompt templates with per-kind token budgets — from
 * Concise (deterministic equation readings only, one-line rows) through
 * Balanced (the tuned defaults) to Educational (a short plain-words
 * explanation of what each equation means). 'custom' is the user's own
 * edited template set, stored as overrides in settings.
 */
import {
	DEFAULT_NARRATION_PROMPTS,
	NARRATION_GENERATION_PARAMS,
	type NarrationGenerationParams,
	type NarrationPromptTemplates
} from './narration-prompts';
import type { NarrationConstructKind } from './types';

export type NarrationPresetId = 'concise' | 'balanced' | 'educational' | 'custom';

export type NarrationParamsMap = Record<NarrationConstructKind, NarrationGenerationParams>;

export interface NarrationPreset {
	id: Exclude<NarrationPresetId, 'custom'>;
	label: string;
	tagline: string;
	prompts: NarrationPromptTemplates;
	params: NarrationParamsMap;
}

const BALANCED_PARAMS: NarrationParamsMap = NARRATION_GENERATION_PARAMS;

const CONCISE_PARAMS: NarrationParamsMap = {
	...BALANCED_PARAMS,
	// Equations: the exact deterministic reading only — no meaning sentence.
	'math-block': { maxNewTokens: 0, maxChars: 0, temperature: 0 },
	'table-row': { maxNewTokens: 48, maxChars: 140, temperature: 0.2 },
	mermaid: { maxNewTokens: 56, maxChars: 170, temperature: 0.2 },
	'code-block': { maxNewTokens: 64, maxChars: 180, temperature: 0.2 },
	image: { maxNewTokens: 40, maxChars: 120, temperature: 0.2 }
};

const EDUCATIONAL_PARAMS: NarrationParamsMap = {
	...BALANCED_PARAMS,
	'math-block': { maxNewTokens: 140, maxChars: 440, temperature: 0, mathProse: 'explanation' },
	'table-row': { maxNewTokens: 96, maxChars: 280, temperature: 0.2 },
	mermaid: { maxNewTokens: 168, maxChars: 480, temperature: 0.2 },
	'code-block': { maxNewTokens: 168, maxChars: 480, temperature: 0.2 },
	image: { maxNewTokens: 96, maxChars: 280, temperature: 0.2 }
};

export const NARRATION_PRESETS: NarrationPreset[] = [
	{
		id: 'concise',
		label: 'Concise',
		tagline: 'Just the facts — exact readings, one-line rows',
		prompts: {
			...DEFAULT_NARRATION_PROMPTS,
			'table-row': [
				'A table row with columns {{header}}. Say this row as one very short sentence in words only, keeping only the values a listener needs:',
				'',
				'{{source}}'
			].join('\n'),
			mermaid: [
				'This code draws {{type}}. Tell a listener what it shows in one short sentence, words only:',
				'',
				'{{source}}'
			].join('\n'),
			'code-block': [
				'A document shows this {{type}} snippet:',
				'',
				'{{source}}',
				'',
				'Tell a listener what it is in one short sentence, words only. Speak a short list of rules or values directly; summarize anything longer.'
			].join('\n')
		},
		params: CONCISE_PARAMS
	},
	{
		id: 'balanced',
		label: 'Balanced',
		tagline: 'Readings plus a grounded symbol sentence',
		prompts: DEFAULT_NARRATION_PROMPTS,
		params: BALANCED_PARAMS
	},
	{
		id: 'educational',
		label: 'Educational',
		tagline: 'Explains what equations and diagrams mean',
		prompts: {
			...DEFAULT_NARRATION_PROMPTS,
			'math-block': [
				'A document reads an equation aloud as: "{{reading}}"',
				'Nearby text: {{context}}',
				'',
				'In two or three short sentences, explain in plain words what the equation says: name what the symbols stand for and what the equation tells us, starting with "Here". Use only symbols from the reading and only facts from the nearby text. If the nearby text does not explain the symbols, reply exactly: skip'
			].join('\n'),
			'table-row': [
				'A table row with columns {{header}}. Say this row as one or two natural sentences in words only, covering every column and pointing out anything notable:',
				'',
				'{{source}}'
			].join('\n'),
			mermaid: [
				'This code draws {{type}}. In three or four short sentences, walk a listener through what it shows and why the pieces connect the way they do, in words only:',
				'',
				'{{source}}'
			].join('\n'),
			'code-block': [
				'A document shows this {{type}} snippet:',
				'',
				'{{source}}',
				'',
				'In two or three short sentences, walk a listener through it in plain words: speak short rules or values line by line with numbers and signs as words, or explain what the code does and why. Words only.'
			].join('\n')
		},
		params: EDUCATIONAL_PARAMS
	}
];

export function getNarrationPreset(id: string): NarrationPreset | null {
	return NARRATION_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isNarrationPresetId(value: string): value is NarrationPresetId {
	return value === 'custom' || NARRATION_PRESETS.some((preset) => preset.id === value);
}
