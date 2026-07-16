/**
 * Single-shot narration rewriting over the description engine — the on-device
 * LLM worker or a bring-your-own-key cloud provider: build the prompt for
 * one construct, generate, sanitize; retry once with a stricter prompt when
 * the output is unusable. The same sanitizer and grounding guards apply to
 * every engine. Throws when no usable narration can be produced — the
 * scheduler decides retry/fail policy above this.
 */
import { mathBlockReading, type NarrationConstruct } from '$lib/domain/narration';
import {
	buildNarrationMessages,
	NARRATION_GENERATION_PARAMS,
	sanitizeNarration,
	type NarrationPromptOverrides
} from '$lib/domain/narration-prompts';
import type { CloudLlmProvider } from '$lib/domain/provider-catalog';
import { generateCloud } from './cloud-llm';
import { activeLlmHost, type LlmChatMessage } from './llm/llm-client';

export type NarrationEngine =
	{ type: 'local' } | { type: 'cloud'; provider: CloudLlmProvider; model: string; apiKey: string };

export class NarrationRewriteError extends Error {
	constructor(
		message: string,
		public readonly reason: 'no-model' | 'unusable-output' | 'generation-failed'
	) {
		super(message);
		this.name = 'NarrationRewriteError';
	}
}

export interface NarrationRewriteRequest {
	construct: NarrationConstruct;
	/** Prose immediately before the construct, assembled by the scheduler. */
	documentContext: string;
	/** User-edited prompt templates from settings, if any. */
	promptOverrides?: NarrationPromptOverrides;
	/** Which engine generates; defaults to the on-device worker. */
	engine?: NarrationEngine;
}

export async function rewriteConstruct(
	request: NarrationRewriteRequest,
	signal?: AbortSignal
): Promise<string> {
	const engine = request.engine ?? { type: 'local' as const };
	const host = engine.type === 'local' ? activeLlmHost() : null;
	if (engine.type === 'local' && !host?.ready) {
		throw new NarrationRewriteError('The narration model is not loaded.', 'no-model');
	}
	const params = NARRATION_GENERATION_PARAMS[request.construct.kind];
	const generate = (messages: LlmChatMessage[]): Promise<string> =>
		engine.type === 'cloud'
			? generateCloud(engine.provider, engine.model, engine.apiKey, messages, {
					maxNewTokens: params.maxNewTokens,
					temperature: params.temperature,
					signal
				})
			: host!.generate(messages, {
					maxNewTokens: params.maxNewTokens,
					temperature: params.temperature,
					signal
				});
	const reading =
		request.construct.kind === 'math-block' ? mathBlockReading(request.construct.source) : null;

	for (const strict of [false, true]) {
		const messages = buildNarrationMessages(request.construct, request.documentContext, {
			overrides: request.promptOverrides,
			strict
		});
		let raw: string;
		try {
			raw = await generate(messages);
		} catch (error) {
			throw new NarrationRewriteError(
				error instanceof Error ? error.message : 'Narration generation failed.',
				'generation-failed'
			);
		}
		const cleaned = sanitizeNarration(raw, request.construct.kind);
		if (!cleaned) continue;
		if (request.construct.kind !== 'math-block') return cleaned;
		// Equations: the deterministic reading carries the math; the LLM's
		// symbol-meaning sentence is appended only when every symbol it names
		// is actually present in the reading (no exemplar/context bleed).
		if (reading && !meaningGroundedInReading(cleaned, reading)) continue;
		const base = reading ?? 'An equation is shown here.';
		return `${base} ${cleaned}`;
	}
	// For equations the deterministic reading alone is a complete, correct
	// narration — a skipped or ungrounded meaning sentence is not a failure.
	if (reading) return reading;
	throw new NarrationRewriteError(
		'The narration model produced no usable text for this construct.',
		'unusable-output'
	);
}

const GREEK_NAME_PATTERN =
	/\b(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega|bar|hat|tilde)\b/gi;

/** Every Greek letter, accent word, or capital-letter symbol the meaning
 * sentence mentions must occur in the reading — otherwise the model is
 * talking about symbols from its exemplars or the context, not this
 * equation. */
export function meaningGroundedInReading(meaning: string, reading: string): boolean {
	const readingLower = reading.toLowerCase();
	for (const match of meaning.toLowerCase().matchAll(GREEK_NAME_PATTERN)) {
		if (!new RegExp(`\\b${match[1]}\\b`).test(readingLower)) return false;
	}
	for (const match of meaning.matchAll(/\b[A-Z]\b/g)) {
		if (!new RegExp(`\\b${match[0]}\\b`).test(reading)) return false;
	}
	return true;
}
