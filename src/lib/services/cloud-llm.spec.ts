import { describe, expect, it } from 'vitest';
import {
	anthropicRequestBody,
	cloudTokenBudget,
	geminiRequestBody,
	openaiRequestBody
} from './cloud-llm';
import type { LlmChatMessage } from './llm/llm-client';

const MESSAGES: LlmChatMessage[] = [
	{ role: 'system', content: 'Words only.' },
	{ role: 'user', content: 'Example in' },
	{ role: 'assistant', content: 'Example out' },
	{ role: 'user', content: 'Say the row.' }
];

describe('cloud token budget', () => {
	it('scales the on-device budget up within hard bounds', () => {
		expect(cloudTokenBudget(24)).toBe(160);
		expect(cloudTokenBudget(64)).toBe(256);
		expect(cloudTokenBudget(512)).toBe(512);
		expect(cloudTokenBudget(undefined)).toBe(512);
	});
});

describe('anthropic request body', () => {
	it('lifts system messages out of the turn list', () => {
		const body = anthropicRequestBody('claude-haiku-4-5', MESSAGES, {
			maxNewTokens: 56,
			temperature: 0
		});
		expect(body.model).toBe('claude-haiku-4-5');
		expect(body.system).toBe('Words only.');
		expect(body.temperature).toBe(0);
		expect(body.messages).toEqual([
			{ role: 'user', content: 'Example in' },
			{ role: 'assistant', content: 'Example out' },
			{ role: 'user', content: 'Say the row.' }
		]);
	});
});

describe('openai request body', () => {
	it('keeps system in the message list, disables reasoning, and omits temperature', () => {
		const body = openaiRequestBody('gpt-5.4-mini', MESSAGES, { maxNewTokens: 64 });
		expect(body.reasoning_effort).toBe('none');
		expect(body.max_completion_tokens).toBe(256);
		expect(body).not.toHaveProperty('temperature');
		expect((body.messages as unknown[]).length).toBe(4);
	});

	it('can drop the reasoning parameter for models that reject it', () => {
		const body = openaiRequestBody('gpt-5.4-mini', MESSAGES, {}, null);
		expect(body).not.toHaveProperty('reasoning_effort');
	});
});

describe('gemini request body', () => {
	it('maps assistant turns to model role and zeroes the thinking budget', () => {
		const body = geminiRequestBody(MESSAGES, { maxNewTokens: 112, temperature: 0.2 }) as {
			systemInstruction: { parts: Array<{ text: string }> };
			contents: Array<{ role: string; parts: Array<{ text: string }> }>;
			generationConfig: {
				maxOutputTokens: number;
				temperature: number;
				thinkingConfig: { thinkingBudget: number };
			};
		};
		expect(body.systemInstruction.parts[0].text).toBe('Words only.');
		expect(body.contents.map((turn) => turn.role)).toEqual(['user', 'model', 'user']);
		expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
		expect(body.generationConfig.maxOutputTokens).toBe(448);
	});
});
