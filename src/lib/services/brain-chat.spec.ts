import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainChatError, runBrainTurn, serverSentEvents } from './brain-chat';

/** A streamed Responses reply: server-sent events, one JSON event each. */
function stream(events: Array<Record<string, unknown>>, chunkSize = 7): Response {
	const body = events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join('');
	const bytes = new TextEncoder().encode(body);
	return new Response(
		new ReadableStream({
			start(controller) {
				// Uneven chunks: events split mid-line must still parse.
				for (let at = 0; at < bytes.length; at += chunkSize) {
					controller.enqueue(bytes.slice(at, at + chunkSize));
				}
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

const call = (
	name: string,
	args: Record<string, unknown>,
	extra: Record<string, unknown> = {}
) => ({
	type: 'response.output_item.done',
	item: {
		type: 'function_call',
		call_id: `call_${name}`,
		name,
		arguments: JSON.stringify(args),
		...extra
	}
});
const text = (delta: string) => ({ type: 'response.output_text.delta', delta });
const message = (words: string) => ({
	type: 'response.output_item.done',
	item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: words }] }
});

const base = {
	apiKey: 'sk-test',
	model: 'gpt-6-luna',
	effort: 'none',
	instructions: 'You are the document expert.',
	tools: [],
	input: [{ role: 'user', content: 'Why do whales sing?' }]
};

afterEach(() => vi.unstubAllGlobals());

describe('serverSentEvents', () => {
	it('parses events split across chunks and skips the rest', async () => {
		const body = new Response(
			'event: a\ndata: {"type":"a"}\n\n: comment\n\ndata: [DONE]\n\ndata: not json\n\ndata: {"type":"b"}\n\n'
		).body!;
		const seen = [];
		for await (const event of serverSentEvents(body)) seen.push(event.type);
		expect(seen).toEqual(['a', 'b']);
	});
});

describe('runBrainTurn', () => {
	it('streams the reply and runs async screen tools without another round', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				stream([
					call('show_passage', { start_segment: 4 }, { async: true }),
					text('They sing '),
					text('to find mates.'),
					message('They sing to find mates.'),
					{ type: 'response.completed' }
				])
			);
		vi.stubGlobal('fetch', fetch);
		const runTool = vi.fn().mockReturnValue({ ok: true });
		const deltas: string[] = [];
		const reply = await runBrainTurn({ ...base, runTool, onText: (delta) => deltas.push(delta) });
		expect(reply).toBe('They sing to find mates.');
		expect(deltas.join('')).toBe(reply);
		expect(runTool).toHaveBeenCalledWith('show_passage', '{"start_segment":4}');
		expect(fetch).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetch.mock.calls[0][1].body);
		expect(body).toMatchObject({
			model: 'gpt-6-luna',
			reasoning: { effort: 'none' },
			store: false,
			stream: true,
			include: ['reasoning.encrypted_content']
		});
	});

	it('loops back with the outputs of tools the model waits on', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				stream([call('read_section', { section: 'S3' }), { type: 'response.completed' }])
			)
			.mockResolvedValueOnce(
				stream([text('Section three says so.'), { type: 'response.completed' }])
			);
		vi.stubGlobal('fetch', fetch);
		const runTool = vi.fn().mockResolvedValue({ text: '⟦7⟧ Whales sing.' });
		const reply = await runBrainTurn({ ...base, runTool, onText: () => undefined });
		expect(reply).toBe('Section three says so.');
		expect(fetch).toHaveBeenCalledTimes(2);
		const second = JSON.parse(fetch.mock.calls[1][1].body);
		expect(second.input.slice(-2)).toEqual([
			{
				type: 'function_call',
				call_id: 'call_read_section',
				name: 'read_section',
				arguments: '{"section":"S3"}'
			},
			{
				type: 'function_call_output',
				call_id: 'call_read_section',
				output: JSON.stringify({ text: '⟦7⟧ Whales sing.' })
			}
		]);
	});

	it('keeps rounds apart and turns a failing tool into an error output', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				stream([
					text('Let me check.'),
					call('web_research', { query: 'x' }),
					{ type: 'response.completed' }
				])
			)
			.mockResolvedValueOnce(stream([text('Nothing turned up.'), { type: 'response.completed' }]));
		vi.stubGlobal('fetch', fetch);
		const runTool = vi.fn().mockRejectedValue(new Error('offline'));
		const reply = await runBrainTurn({ ...base, runTool, onText: () => undefined });
		expect(reply).toBe('Let me check. Nothing turned up.');
		const second = JSON.parse(fetch.mock.calls[1][1].body);
		expect(second.input.at(-1)).toEqual({
			type: 'function_call_output',
			call_id: 'call_web_research',
			output: JSON.stringify({ error: 'offline' })
		});
	});

	it('explains a rejected key and a failed response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
		await expect(
			runBrainTurn({ ...base, runTool: vi.fn(), onText: () => undefined })
		).rejects.toThrow('The OpenAI API key was rejected');

		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					stream([{ type: 'response.failed', response: { error: { message: 'overloaded' } } }])
				)
		);
		await expect(
			runBrainTurn({ ...base, runTool: vi.fn(), onText: () => undefined })
		).rejects.toThrow(new BrainChatError('overloaded'));
	});
});
