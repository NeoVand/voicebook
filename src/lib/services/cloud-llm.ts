/**
 * Bring-your-own-key chat completion for the description engines. Every call
 * goes directly from this browser to the provider the key belongs to —
 * there is no proxy in between. Request builders are pure and unit-tested;
 * the same {role, content} messages the on-device worker consumes are mapped
 * onto each provider's shape.
 */
import type { LlmChatMessage } from './llm/llm-client';
import { PROVIDER_LABELS, type CloudLlmProvider } from '$lib/domain/provider-catalog';

export interface CloudImageAttachment {
	/** e.g. 'image/png'. */
	mediaType: string;
	/** Raw base64 without a data: prefix. */
	data: string;
}

export interface CloudGenerateOptions {
	maxNewTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Attached to the final user turn — every offered provider is
	 * vision-capable. */
	image?: CloudImageAttachment;
}

export class CloudLlmError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
		/** Server-requested backoff (Retry-After) for 429/503 responses. */
		public readonly retryAfterMs?: number
	) {
		super(message);
		this.name = 'CloudLlmError';
	}
}

/** The on-device token budgets are tuned tight for a 1.2B model; cloud models
 * spend a few extra tokens on natural phrasing, and the sanitizer still caps
 * characters afterwards. */
export function cloudTokenBudget(maxNewTokens?: number): number {
	return Math.max(160, Math.min(512, (maxNewTokens ?? 128) * 4));
}

function systemText(messages: LlmChatMessage[]): string {
	return messages
		.filter((message) => message.role === 'system')
		.map((message) => message.content)
		.join('\n');
}

function turns(messages: LlmChatMessage[]): LlmChatMessage[] {
	return messages.filter((message) => message.role !== 'system');
}

export function anthropicRequestBody(
	model: string,
	messages: LlmChatMessage[],
	options: CloudGenerateOptions = {}
): Record<string, unknown> {
	const turnList = turns(messages);
	const lastUser = turnList.findLastIndex((message) => message.role === 'user');
	return {
		model,
		max_tokens: cloudTokenBudget(options.maxNewTokens),
		temperature: Math.max(0, Math.min(1, options.temperature ?? 0.2)),
		system: systemText(messages),
		messages: turnList.map((message, index) => ({
			role: message.role,
			content:
				options.image && index === lastUser
					? [
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: options.image.mediaType,
									data: options.image.data
								}
							},
							{ type: 'text', text: message.content }
						]
					: message.content
		}))
	};
}

/** GPT-5-family models pin sampling parameters, so temperature is omitted;
 * reasoning is turned off — a one-sentence rewrite needs latency, not
 * deliberation. */
export function openaiRequestBody(
	model: string,
	messages: LlmChatMessage[],
	options: CloudGenerateOptions = {},
	reasoningEffort: string | null = 'none'
): Record<string, unknown> {
	const lastUser = messages.findLastIndex((message) => message.role === 'user');
	return {
		model,
		max_completion_tokens: cloudTokenBudget(options.maxNewTokens),
		...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
		messages: messages.map((message, index) => ({
			role: message.role,
			content:
				options.image && index === lastUser
					? [
							{
								type: 'image_url',
								image_url: { url: `data:${options.image.mediaType};base64,${options.image.data}` }
							},
							{ type: 'text', text: message.content }
						]
					: message.content
		}))
	};
}

/** Thinking budget zero: Gemini 3.x otherwise spends the whole token budget
 * on hidden reasoning for these tiny prompts. */
export function geminiRequestBody(
	messages: LlmChatMessage[],
	options: CloudGenerateOptions = {}
): Record<string, unknown> {
	const system = systemText(messages);
	const turnList = turns(messages);
	const lastUser = turnList.findLastIndex((message) => message.role === 'user');
	return {
		...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
		contents: turnList.map((message, index) => ({
			role: message.role === 'assistant' ? 'model' : 'user',
			parts:
				options.image && index === lastUser
					? [
							{ inlineData: { mimeType: options.image.mediaType, data: options.image.data } },
							{ text: message.content }
						]
					: [{ text: message.content }]
		})),
		generationConfig: {
			maxOutputTokens: cloudTokenBudget(options.maxNewTokens),
			temperature: Math.max(0, Math.min(1, options.temperature ?? 0.2)),
			thinkingConfig: { thinkingBudget: 0 }
		}
	};
}

interface ProviderResponse {
	ok: boolean;
	status: number;
	data: unknown;
	retryAfterMs?: number;
}

/** Retry-After arrives as delta-seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function post(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	options: CloudGenerateOptions
): Promise<ProviderResponse> {
	const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal
		});
	} catch (error) {
		if (options.signal?.aborted) throw new CloudLlmError('The request was cancelled.');
		if (timeout.aborted) throw new CloudLlmError('The provider did not answer in time.');
		throw new CloudLlmError(
			error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
		);
	}
	const data = await response.json().catch(() => ({}));
	return {
		ok: response.ok,
		status: response.status,
		data,
		retryAfterMs: parseRetryAfter(response.headers.get('retry-after'))
	};
}

function errorMessage(provider: CloudLlmProvider, status: number, data: unknown): string {
	const vendor = PROVIDER_LABELS[provider].vendor;
	const detail =
		(data as { error?: { message?: string } })?.error?.message ??
		(data as { message?: string })?.message ??
		'';
	if (status === 401 || status === 403) {
		return `The ${vendor} API key was rejected. Check it under Settings → LLM.`;
	}
	if (status === 429) {
		return `${vendor} is rate limiting this key right now. It will retry on the next pass.`;
	}
	return `${vendor} request failed (${status})${detail ? `: ${detail}` : '.'}`;
}

function anthropicText(data: unknown): string {
	const content = (data as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
	return content
		.filter((block) => block.type === 'text' && block.text)
		.map((block) => block.text)
		.join('');
}

function openaiText(data: unknown): string {
	const choices = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices ?? [];
	return choices[0]?.message?.content ?? '';
}

function geminiText(data: unknown): string {
	const parts =
		(data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
			?.candidates?.[0]?.content?.parts ?? [];
	return parts
		.map((part) => part.text ?? '')
		.join('')
		.trim();
}

const EFFORT_VARIANTS = ['none', 'minimal', null] as const;
/** Per-model reasoning-effort the API accepted, so the 400-probe cascade runs
 * once per session instead of on every construct. */
const acceptedEffort = new Map<string, (typeof EFFORT_VARIANTS)[number]>();

/**
 * One single-shot completion against the chosen provider. Throws
 * CloudLlmError with a user-presentable message on any failure.
 */
export async function generateCloud(
	provider: CloudLlmProvider,
	model: string,
	apiKey: string,
	messages: LlmChatMessage[],
	options: CloudGenerateOptions = {}
): Promise<string> {
	if (!apiKey) throw new CloudLlmError('No API key is configured for this provider.');

	if (provider === 'anthropic') {
		const response = await post(
			'https://api.anthropic.com/v1/messages',
			{
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				// Voicebook is a local-first app: the user's own key calls the API
				// directly from their browser, which Anthropic requires be opted
				// into explicitly.
				'anthropic-dangerous-direct-browser-access': 'true'
			},
			anthropicRequestBody(model, messages, options),
			options
		);
		if (!response.ok) {
			throw new CloudLlmError(
				errorMessage(provider, response.status, response.data),
				response.status,
				response.retryAfterMs
			);
		}
		return anthropicText(response.data);
	}

	if (provider === 'openai') {
		// Newer GPT models take reasoning_effort 'none'; some earlier minis only
		// accept 'minimal'. Fall through the variants before giving up, and
		// remember what the model accepted so later calls need one request.
		const remembered = acceptedEffort.get(model);
		const variants =
			remembered === undefined
				? EFFORT_VARIANTS
				: [remembered, ...EFFORT_VARIANTS.filter((effort) => effort !== remembered)];
		for (const effort of variants) {
			const response = await post(
				'https://api.openai.com/v1/chat/completions',
				{ authorization: `Bearer ${apiKey}` },
				openaiRequestBody(model, messages, options, effort),
				options
			);
			if (response.ok) {
				acceptedEffort.set(model, effort);
				return openaiText(response.data);
			}
			const detail =
				(response.data as { error?: { param?: string; message?: string } })?.error ?? {};
			const effortRejected =
				response.status === 400 &&
				(detail.param === 'reasoning_effort' || /reasoning_effort/.test(detail.message ?? ''));
			if (!effortRejected) {
				throw new CloudLlmError(
					errorMessage(provider, response.status, response.data),
					response.status,
					response.retryAfterMs
				);
			}
			acceptedEffort.delete(model);
		}
		throw new CloudLlmError('OpenAI rejected every reasoning-effort variant for this model.');
	}

	const response = await post(
		`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
		{ 'x-goog-api-key': apiKey },
		geminiRequestBody(messages, options),
		options
	);
	if (!response.ok) {
		throw new CloudLlmError(
			errorMessage(provider, response.status, response.data),
			response.status,
			response.retryAfterMs
		);
	}
	return geminiText(response.data);
}

/** Cheap authenticated GET per provider — used by the settings "Test" button. */
export async function verifyCloudLlmKey(
	provider: CloudLlmProvider,
	apiKey: string,
	signal?: AbortSignal
): Promise<{ ok: boolean; message: string }> {
	const vendor = PROVIDER_LABELS[provider].vendor;
	const targets: Record<CloudLlmProvider, { url: string; headers: Record<string, string> }> = {
		anthropic: {
			url: 'https://api.anthropic.com/v1/models?limit=1',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true'
			}
		},
		openai: {
			url: 'https://api.openai.com/v1/models',
			headers: { authorization: `Bearer ${apiKey}` }
		},
		gemini: {
			url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
			headers: { 'x-goog-api-key': apiKey }
		}
	};
	try {
		const target = targets[provider];
		const timeout = AbortSignal.timeout(20_000);
		const response = await fetch(target.url, {
			headers: target.headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
		if (response.ok) return { ok: true, message: `${vendor} accepted the key.` };
		if (response.status === 401 || response.status === 403) {
			return { ok: false, message: `${vendor} rejected this key.` };
		}
		return { ok: false, message: `${vendor} answered with status ${response.status}.` };
	} catch {
		return { ok: false, message: `${vendor} could not be reached.` };
	}
}
