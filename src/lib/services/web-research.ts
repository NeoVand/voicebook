/**
 * BYOK web research through the OpenAI Responses API's built-in web_search
 * tool: one focused question in, a few speakable sentences and their source
 * citations out. Request and response mapping are pure and unit-tested; the
 * key travels only to api.openai.com, like every other premium path.
 */

export interface WebResearchCitation {
	title: string;
	url: string;
}

export interface WebResearchFinding {
	text: string;
	citations: WebResearchCitation[];
}

export class WebResearchError extends Error {
	constructor(
		message: string,
		public readonly status?: number
	) {
		super(message);
		this.name = 'WebResearchError';
	}
}

/**
 * The answer stays a few sentences by instruction, not by budget — this
 * ceiling also has to cover the model's reasoning and its search-tool turns,
 * which measured 450–900 tokens for the SAME question across runs. A tight
 * budget does not shorten the answer; it truncates the response before the
 * message item exists at all, leaving nothing to read.
 */
const RESEARCH_MAX_OUTPUT_TOKENS = 2_000;

export function webResearchRequestBody(model: string, query: string): Record<string, unknown> {
	return {
		model,
		instructions:
			'You research one question for a reading companion. Answer in three to five plain ' +
			'sentences a voice can speak, grounded in current sources. No markdown, no lists, ' +
			'no preamble — only the sentences.',
		input: query,
		tools: [{ type: 'web_search' }],
		max_output_tokens: RESEARCH_MAX_OUTPUT_TOKENS
	};
}

/** Tracking params make stored sources ugly and leak referrers; strip them. */
function cleanUrl(raw: string): string {
	try {
		const url = new URL(raw);
		for (const key of [...url.searchParams.keys()]) {
			if (key.startsWith('utm_')) url.searchParams.delete(key);
		}
		return url.toString().replace(/\?$/, '');
	} catch {
		return raw;
	}
}

interface ResponsesPayload {
	status?: string;
	incomplete_details?: { reason?: string } | null;
	error?: { message?: string } | null;
	output?: Array<{
		type?: string;
		content?: Array<{
			type?: string;
			text?: string;
			annotations?: Array<{ type?: string; title?: string; url?: string }>;
		}>;
	}>;
}

export function parseWebResearchResponse(data: unknown): WebResearchFinding {
	const payload = data as ResponsesPayload;
	const parts = (payload.output ?? [])
		.filter((item) => item.type === 'message')
		.flatMap((item) => item.content ?? [])
		.filter((part) => part.type === 'output_text');
	const text = parts
		.map((part) => part.text ?? '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) {
		// A response truncated mid-search carries no message item at all — say
		// so plainly instead of reporting an empty answer.
		if (payload.status === 'incomplete') {
			throw new WebResearchError(
				payload.incomplete_details?.reason === 'max_output_tokens'
					? 'The web search ran long and was cut off before it answered. Try a narrower question.'
					: 'The web search did not finish.'
			);
		}
		throw new WebResearchError(
			payload.error?.message ?? 'The web search returned no readable answer.'
		);
	}
	const citations: WebResearchCitation[] = [];
	const seen = new Set<string>();
	for (const part of parts) {
		for (const annotation of part.annotations ?? []) {
			if (annotation.type !== 'url_citation' || !annotation.url) continue;
			const url = cleanUrl(annotation.url);
			if (seen.has(url)) continue;
			seen.add(url);
			citations.push({ title: annotation.title?.trim() || url, url });
		}
	}
	return { text, citations };
}

export async function performWebResearch(
	model: string,
	apiKey: string,
	query: string,
	signal?: AbortSignal
): Promise<WebResearchFinding> {
	if (!apiKey) throw new WebResearchError('No OpenAI key is configured.');
	const timeout = AbortSignal.timeout(60_000);
	let response: Response;
	try {
		response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(webResearchRequestBody(model, query)),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout
		});
	} catch (error) {
		if (timeout.aborted) throw new WebResearchError('The web search timed out.');
		throw new WebResearchError(
			error instanceof Error ? `Network error: ${error.message}` : 'Network error.'
		);
	}
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const detail = (data as { error?: { message?: string } })?.error?.message ?? '';
		if (response.status === 401 || response.status === 403) {
			throw new WebResearchError('The OpenAI key was rejected.', response.status);
		}
		throw new WebResearchError(
			`Web search failed (${response.status})${detail ? `: ${detail}` : '.'}`,
			response.status
		);
	}
	return parseWebResearchResponse(data);
}
