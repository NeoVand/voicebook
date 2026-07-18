/**
 * Spoken-explanation generation over the description engine — the same
 * local-or-cloud resolution the narration rewriter uses. Builds the messages,
 * generates, sanitizes; throws with a readable message when no usable answer
 * can be produced.
 */
import {
	buildExplainMessages,
	EXPLAIN_GENERATION_PARAMS,
	sanitizeExplanation,
	type ExplainRequest
} from '$lib/domain/explain-prompts';
import { generateCloud } from './cloud-llm';
import { activeLlmHost } from './llm/llm-client';
import type { NarrationEngine } from './narration-rewriter';

export async function generateExplanation(
	request: ExplainRequest,
	engine: NarrationEngine,
	systemPrompt?: string,
	signal?: AbortSignal
): Promise<string> {
	const messages = buildExplainMessages(request, systemPrompt);
	let raw: string;
	if (engine.type === 'cloud') {
		raw = await generateCloud(engine.provider, engine.model, engine.apiKey, messages, {
			maxNewTokens: EXPLAIN_GENERATION_PARAMS.maxNewTokens,
			temperature: EXPLAIN_GENERATION_PARAMS.temperature,
			signal
		});
	} else {
		const host = activeLlmHost();
		if (!host?.ready) throw new Error('The on-device language model is not loaded.');
		raw = await host.generate(messages, {
			maxNewTokens: EXPLAIN_GENERATION_PARAMS.maxNewTokens,
			temperature: EXPLAIN_GENERATION_PARAMS.temperature,
			signal
		});
	}
	const cleaned = sanitizeExplanation(raw);
	if (!cleaned) throw new Error('The model produced no speakable explanation. Try again.');
	return cleaned;
}
