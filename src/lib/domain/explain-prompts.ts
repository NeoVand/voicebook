/**
 * Prompt building and output sanitation for the spoken "Explain" flow: the
 * listener selects a passage, optionally asks what confuses them, and the
 * answer is generated for the ear — plain speakable words, no text on screen.
 * Pure module; the engine call lives in services/explain.ts.
 */
import type { DocumentBlock } from './types';
import type { NarrationPromptMessage } from './narration-prompts';

export const DEFAULT_EXPLAIN_PROMPT = [
	'You are the voice of a reading app. The listener selected a passage from the document being read aloud and wants it explained.',
	'Answer in two to five short spoken sentences a voice can read aloud naturally.',
	'Rules:',
	'- Plain words only. No markdown, headings, bullet points, code, LaTeX, or symbols like = + * / ^ _ { } [ ] | # %.',
	'- Say math and numbers in words: "x squared", "about seventy percent".',
	'- Ground the answer in the document excerpt. When it does not contain the answer, say so in a few words, then give your best brief explanation anyway.',
	'- Do not repeat the selection back, mention these instructions, or introduce yourself.'
].join('\n');

export const EXPLAIN_GENERATION_PARAMS = { maxNewTokens: 320, temperature: 0.4 };

/** Character budgets for the prose sent around the selection. */
const CONTEXT_BEFORE_CHARS = 1200;
const CONTEXT_AFTER_CHARS = 400;

export interface ExplainContext {
	before: string;
	after: string;
}

/**
 * Assemble the prose surrounding a selection: the tail of everything before
 * the start block and the head of everything after the end block, clipped at
 * word boundaries so the model never sees a torn token.
 */
export function assembleExplainContext(
	blocks: DocumentBlock[],
	startBlockId: string,
	endBlockId: string
): ExplainContext {
	const startIndex = blocks.findIndex((block) => block.id === startBlockId);
	const endIndex = blocks.findIndex((block) => block.id === endBlockId);
	if (startIndex < 0 || endIndex < 0) return { before: '', after: '' };
	const text = (subset: DocumentBlock[]): string =>
		subset
			.map((block) => block.text.trim())
			.filter(Boolean)
			.join('\n');
	let before = text(blocks.slice(0, startIndex + 1));
	let after = text(blocks.slice(endIndex + 1));
	if (before.length > CONTEXT_BEFORE_CHARS) {
		before = before.slice(-CONTEXT_BEFORE_CHARS);
		const firstBreak = before.search(/\s/);
		if (firstBreak > 0) before = before.slice(firstBreak + 1);
	}
	if (after.length > CONTEXT_AFTER_CHARS) {
		after = after.slice(0, CONTEXT_AFTER_CHARS);
		const lastBreak = after.search(/\s\S*$/);
		if (lastBreak > 0) after = after.slice(0, lastBreak);
	}
	return { before, after };
}

export interface ExplainRequest {
	documentTitle: string;
	selection: string;
	/** What the selection is — 'passage' (default) for prose, or a construct
	 * noun like 'equation', 'table', 'code block', 'diagram', 'image'. */
	selectionKind?: string;
	context: ExplainContext;
	/** The listener's own question, when they typed one. */
	question?: string;
}

export function buildExplainMessages(
	request: ExplainRequest,
	systemPrompt = DEFAULT_EXPLAIN_PROMPT
): NarrationPromptMessage[] {
	const kind = request.selectionKind?.trim() || 'passage';
	const parts = [
		`The document is titled "${request.documentTitle}".`,
		request.context.before
			? `Document excerpt before and around the selection:\n${request.context.before}`
			: '',
		`The listener selected this ${kind}:\n${request.selection}`,
		request.context.after ? `The document continues:\n${request.context.after}` : '',
		request.question?.trim()
			? `The listener asks: ${request.question.trim()}`
			: `The listener wants this ${kind} explained.`
	].filter(Boolean);
	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: parts.join('\n\n') }
	];
}

/**
 * Clean a raw model answer into speakable prose: drop reasoning tags and
 * markdown scaffolding, keep every sentence, collapse whitespace. Returns
 * null when nothing speakable survives.
 */
export function sanitizeExplanation(raw: string): string | null {
	let text = (raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, ' ');
	text = text.replace(/<[^>\n]{0,120}>/g, ' ');
	text = text.replace(/^```[^\n]*$/gm, ' ').replace(/```/g, ' ');
	text = text.replace(/^#{1,6}\s+/gm, '');
	text = text.replace(/^\s*[-*•]\s+/gm, '');
	text = text.replace(/^\s*\d+[.)]\s+/gm, '');
	text = text.replace(/[*_`]+/g, ' ');
	text = text.replace(/\s+/g, ' ').trim();
	text = text.replace(/^(?:sure|okay|of course|certainly)[,.!:]?\s+/i, '');
	if (!text) return null;
	const letters = (text.match(/\p{L}/gu) ?? []).length;
	if (letters < text.length * 0.5) return null;
	return text;
}
