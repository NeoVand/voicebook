import { describe, expect, it } from 'vitest';
import { liveSessionBody } from './openai-live';

describe('liveSessionBody', () => {
	it('configures the voice and delegates to the brain with its tools', () => {
		const tools = [{ type: 'function', name: 'show_passage', description: '', parameters: {} }];
		expect(
			liveSessionBody({
				model: 'gpt-live-1',
				instructions: 'Be a calm reading companion.',
				voice: 'cedar',
				input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
				brain: {
					model: 'gpt-6-luna',
					instructions: 'You are the document expert.',
					tools,
					effort: 'none'
				}
			})
		).toEqual({
			model: 'gpt-live-1',
			instructions: 'Be a calm reading companion.',
			input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
			audio: { output: { voice: 'cedar' } },
			delegation: {
				type: 'responses',
				responses: {
					model: 'gpt-6-luna',
					instructions: 'You are the document expert.',
					tools,
					tool_choice: 'auto',
					parallel_tool_calls: true,
					reasoning: { effort: 'none' }
				}
			}
		});
	});

	it('leaves out an empty history and never names an audio format', () => {
		const body = liveSessionBody({
			model: 'gpt-live-1',
			instructions: '',
			voice: 'marin',
			input: [],
			brain: { model: 'gpt-6-sol', instructions: '', tools: [], effort: 'low' }
		});
		expect(body).not.toHaveProperty('input');
		expect(body.audio).toEqual({ output: { voice: 'marin' } });
	});
});
