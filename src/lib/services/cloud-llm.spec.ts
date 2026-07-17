import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	anthropicRequestBody,
	CloudLlmError,
	cloudTokenBudget,
	geminiRequestBody,
	generateCloud,
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

describe('generateCloud transport behavior', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}) {
		return new Response(JSON.stringify(data), { status, headers });
	}

	it('carries the server Retry-After through the thrown error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '7' })
			)
		);
		const failure = await generateCloud('anthropic', 'claude-haiku-4-5', 'key', MESSAGES).catch(
			(error) => error
		);
		expect(failure).toBeInstanceOf(CloudLlmError);
		expect(failure.status).toBe(429);
		expect(failure.retryAfterMs).toBe(7_000);
	});

	it('remembers the accepted OpenAI reasoning effort across calls', async () => {
		const bodies: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				if (body.reasoning_effort === 'none') {
					return jsonResponse(400, {
						error: { param: 'reasoning_effort', message: 'unsupported value' }
					});
				}
				return jsonResponse(200, { choices: [{ message: { content: 'A spoken row.' } }] });
			})
		);
		// First call probes 'none' (rejected) then 'minimal' (accepted)…
		await expect(generateCloud('openai', 'gpt-probe-test', 'key', MESSAGES)).resolves.toBe(
			'A spoken row.'
		);
		expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', 'minimal']);
		// …and the second call goes straight to the remembered variant.
		bodies.length = 0;
		await expect(generateCloud('openai', 'gpt-probe-test', 'key', MESSAGES)).resolves.toBe(
			'A spoken row.'
		);
		expect(bodies.map((body) => body.reasoning_effort)).toEqual(['minimal']);
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
