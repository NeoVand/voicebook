/**
 * Typed chat straight to the brain, with no voice session: the Responses API
 * with the instructions and tools a GPT-Live voice's brain uses, streamed so
 * the reply lands word by word. Tools marked async (screen-only: highlights,
 * notes) run the moment they are called and the model carries on without
 * them; tools whose results it needs — reading, the reader's focus, web
 * research — loop back as usual. Stateless: nothing is stored with OpenAI.
 */

export type BrainInputItem = Record<string, unknown>;

export interface BrainTurnOptions {
	apiKey: string;
	model: string;
	effort: string;
	instructions: string;
	tools: readonly object[];
	/** The conversation so far, ending with the reader's new message. */
	input: BrainInputItem[];
	runTool(
		name: string,
		argumentsJson: string
	): Record<string, unknown> | Promise<Record<string, unknown>>;
	onText(delta: string): void;
	signal?: AbortSignal;
}

export class BrainChatError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'BrainChatError';
	}
}

interface FunctionCall {
	type: 'function_call';
	call_id: string;
	name: string;
	arguments: string;
	async?: boolean;
}

/** More rounds than any answer needs; a loop past this is a loop. */
const MAX_ROUNDS = 8;

function errorMessage(status: number, data: unknown): string {
	const detail = (data as { error?: { message?: string } })?.error?.message ?? '';
	if (status === 401 || status === 403) {
		return 'The OpenAI API key was rejected. Check it under Settings → LLM.';
	}
	if (status === 429) return 'OpenAI is rate limiting this key right now. Try again in a moment.';
	return `The assistant could not answer (${status})${detail ? `: ${detail}` : '.'}`;
}

/** One reader turn: stream the reply, running tools until the model is done.
 * Resolves to the reply text. */
export async function runBrainTurn(options: BrainTurnOptions): Promise<string> {
	const input = [...options.input];
	let text = '';
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${options.apiKey}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				model: options.model,
				instructions: options.instructions,
				input,
				tools: options.tools,
				parallel_tool_calls: true,
				reasoning: { effort: options.effort },
				// Nothing kept server-side; reasoning travels back encrypted.
				store: false,
				include: ['reasoning.encrypted_content'],
				stream: true
			}),
			signal: options.signal
		}).catch((error: unknown) => {
			if (options.signal?.aborted) throw new BrainChatError('The request was cancelled.');
			throw new BrainChatError(
				error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
			);
		});
		if (!response.ok || !response.body) {
			const data = await response.json().catch(() => ({}));
			throw new BrainChatError(errorMessage(response.status, data), response.status);
		}

		const output: BrainInputItem[] = [];
		const waiting: Array<{ call: FunctionCall; result: Promise<Record<string, unknown>> }> = [];
		const answered: BrainInputItem[] = [];
		for await (const event of serverSentEvents(response.body)) {
			const type = event.type as string;
			if (type === 'response.output_text.delta') {
				const delta = (event.delta as string) ?? '';
				text += delta;
				options.onText(delta);
			} else if (type === 'response.output_item.done') {
				const item = event.item as BrainInputItem;
				output.push(item);
				if (item.type !== 'function_call') continue;
				const call = item as unknown as FunctionCall;
				// Run every call the moment it lands — the reader sees a highlight
				// before the words that explain it.
				const result = Promise.resolve(options.runTool(call.name, call.arguments)).catch(
					(error: unknown) => ({
						error: error instanceof Error ? error.message : 'The tool failed.'
					})
				);
				if (call.async) {
					// The model already moved on; its output only has to exist
					// by the next request.
					answered.push({
						type: 'function_call_output',
						call_id: call.call_id,
						output: JSON.stringify(await result)
					});
				} else waiting.push({ call, result });
			} else if (type === 'response.failed' || type === 'error') {
				const message =
					((event.response as { error?: { message?: string } })?.error?.message ??
						(event.error as { message?: string })?.message) ||
					'The assistant could not answer.';
				throw new BrainChatError(message);
			}
		}

		input.push(...output, ...answered);
		if (!waiting.length) return text;
		for (const { call, result } of waiting) {
			input.push({
				type: 'function_call_output',
				call_id: call.call_id,
				output: JSON.stringify(await result)
			});
		}
		// Separate the next round's words from this one's.
		if (text && !/\s$/.test(text)) {
			text += ' ';
			options.onText(' ');
		}
	}
	return text;
}

/** Parse a `text/event-stream` body into its JSON events. */
export async function* serverSentEvents(
	body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf('\n\n');
			while (boundary >= 0) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = block
					.split('\n')
					.filter((line) => line.startsWith('data:'))
					.map((line) => line.slice(5).trimStart())
					.join('\n');
				if (data && data !== '[DONE]') {
					try {
						yield JSON.parse(data) as Record<string, unknown>;
					} catch {
						// A malformed event carries nothing usable.
					}
				}
				boundary = buffer.indexOf('\n\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
}
