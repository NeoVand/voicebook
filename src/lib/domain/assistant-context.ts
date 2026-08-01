/**
 * Voice-assistant document context: serializes a normalized document into
 * marker-annotated text a realtime model can cite, and validates the tool
 * calls the model makes against it. Pure — the WebRTC session lives in
 * services/openai-realtime.ts and the orchestration in
 * state/realtime-assistant.svelte.ts.
 */
import type { NormalizedDocument } from './types';

export interface PassageRange {
	/** Inclusive segment indexes into NormalizedDocument.segments. */
	startIndex: number;
	endIndex: number;
}

export interface TourStop {
	range: PassageRange;
	/** The model's own note on what to say at this stop. */
	point: string;
}

export type AssistantToolCall =
	| { name: 'show_passage'; range: PassageRange }
	| { name: 'read_passage'; range: PassageRange }
	| { name: 'play_section'; range: PassageRange }
	| { name: 'clear_highlight' }
	| { name: 'plan_tour'; stops: TourStop[] }
	| { name: 'continue_tour' };

export const TOUR_STOP_LIMIT = 8;

export interface AssistantInstructions {
	instructions: string;
	/** True when the document text had to be cut to fit the context budget. */
	truncated: boolean;
	segmentCount: number;
}

export interface RealtimeToolSpec {
	type: 'function';
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** ~90k tokens of document text — inside the model's 128k window with room
 * left for the conversation itself. */
export const ASSISTANT_CONTEXT_CHAR_BUDGET = 360_000;

/** Tool outputs stay small; the model re-requests when it needs more. */
export const READ_PASSAGE_CHAR_LIMIT = 8_000;

function marker(index: number): string {
	return `⟦${index}⟧`;
}

function segmentText(doc: NormalizedDocument, index: number): string {
	const segment = doc.segments[index];
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return text || segment.normalizedText.replace(/\s+/g, ' ').trim();
}

interface SerializedBody {
	body: string;
	/** Index of the first segment that did NOT fit, or -1 when all fit. */
	cutAt: number;
}

/** Segments in reading order, each prefixed with its marker; block changes
 * become paragraph breaks and headings keep their # level so the model sees
 * the document's shape. */
function serializeBody(doc: NormalizedDocument, budget: number): SerializedBody {
	const blocksById = new Map(doc.blocks.map((block) => [block.id, block]));
	const parts: string[] = [];
	let length = 0;
	let previousBlockId: string | undefined;
	for (let index = 0; index < doc.segments.length; index += 1) {
		const segment = doc.segments[index];
		let piece: string;
		if (segment.blockId === previousBlockId) {
			piece = ` ${marker(index)} ${segmentText(doc, index)}`;
		} else {
			const block = blocksById.get(segment.blockId);
			const heading =
				block?.kind === 'heading'
					? `${'#'.repeat(Math.max(1, Math.min(6, block.level ?? 1)))} `
					: '';
			piece = `${parts.length ? '\n\n' : ''}${heading}${marker(index)} ${segmentText(doc, index)}`;
		}
		if (length + piece.length > budget) return { body: parts.join(''), cutAt: index };
		parts.push(piece);
		length += piece.length;
		previousBlockId = segment.blockId;
	}
	return { body: parts.join(''), cutAt: -1 };
}

function serializeOutline(doc: NormalizedDocument): string {
	if (!doc.outline.length) return '';
	const firstSegmentByBlock = new Map<string, number>();
	doc.segments.forEach((segment, index) => {
		if (!firstSegmentByBlock.has(segment.blockId)) firstSegmentByBlock.set(segment.blockId, index);
	});
	return doc.outline
		.map((entry) => {
			const indent = '  '.repeat(Math.max(0, entry.level - 1));
			const at = firstSegmentByBlock.get(entry.blockId);
			return `${indent}- ${entry.title}${at === undefined ? '' : ` ${marker(at)}`}`;
		})
		.join('\n');
}

const PREAMBLE = `You are Voicebook's reading companion, talking with a reader by voice about the document below.

When the conversation begins, greet the reader in one or two short sentences, in the document's language: name the document and offer to answer questions about it or walk through it aloud. Then wait for them.

Markers like ⟦7⟧ number each passage of the document. They are invisible to the reader: never say the numbers or the word "segment" aloud — refer to places naturally ("this paragraph", "the section on…").

Whenever you discuss, quote, summarize, or explain a specific part of the document, call show_passage with that passage's marker numbers first, so the reader sees it highlighted while you speak. When one answer touches several places, call show_passage again for each part just before you speak about it — the highlight should follow your voice. Call clear_highlight when the conversation leaves the document.

When the reader asks for an overview or a walkthrough ("walk me through…", "give me the big picture", "what should I read?"), call plan_tour with three to seven stops in reading order — each stop is a marker range plus a few words on why it matters. The app then walks you stop by stop: narrate the highlighted stop in a sentence or two, and the next stop arrives when you finish speaking. If the reader interrupts with a question, answer it; call continue_tour when they are ready to go on.

When the reader asks to hear part of the document read aloud ("read this section to me", "play it from here"), call play_section with that range — the app's reading voice takes over, waiting for you to finish speaking first. A short lead-in ("Here's that section") is fine; after it, stay silent until the reader speaks to you again.

Ground everything you say in the document; when it does not contain the answer, say so plainly. Match the language the reader speaks to you (start in the document's language). Keep replies short and conversational — a few sentences unless the reader asks for depth.`;

export function buildAssistantInstructions(
	doc: NormalizedDocument,
	charBudget = ASSISTANT_CONTEXT_CHAR_BUDGET
): AssistantInstructions {
	const { body, cutAt } = serializeBody(doc, charBudget);
	const outline = serializeOutline(doc);
	const sections = [PREAMBLE];
	if (outline) sections.push(`=== OUTLINE ===\n${outline}`);
	sections.push(`=== DOCUMENT: ${doc.title} ===\n${body}`);
	if (cutAt >= 0) {
		sections.push(
			`[The document is truncated here. Passages ${marker(cutAt)} through ${marker(doc.segments.length - 1)} are omitted — call read_passage to fetch any of them.]`
		);
	}
	return {
		instructions: sections.join('\n\n'),
		truncated: cutAt >= 0,
		segmentCount: doc.segments.length
	};
}

function segmentParameter(description: string): Record<string, unknown> {
	return { type: 'integer', minimum: 0, description };
}

export function assistantTools(includeReadPassage: boolean): RealtimeToolSpec[] {
	const tools: RealtimeToolSpec[] = [
		{
			type: 'function',
			name: 'show_passage',
			description:
				'Highlight a passage and scroll the reader to it. Call this right before discussing, quoting, or explaining any specific part of the document.',
			parameters: {
				type: 'object',
				properties: {
					start_segment: segmentParameter('First segment number of the passage — the ⟦n⟧ marker.'),
					end_segment: segmentParameter(
						'Last segment number, inclusive. Omit for a single segment.'
					)
				},
				required: ['start_segment']
			}
		},
		{
			type: 'function',
			name: 'clear_highlight',
			description: 'Remove the highlight once the conversation moves away from the text.',
			parameters: { type: 'object', properties: {} }
		},
		{
			type: 'function',
			name: 'plan_tour',
			description:
				'Plan a guided walkthrough of the document. Give the stops in reading order; the app highlights each stop in turn and advances you as you finish narrating it. Use for overview and "walk me through" requests.',
			parameters: {
				type: 'object',
				properties: {
					stops: {
						type: 'array',
						minItems: 1,
						maxItems: TOUR_STOP_LIMIT,
						items: {
							type: 'object',
							properties: {
								start_segment: segmentParameter('First segment of this stop.'),
								end_segment: segmentParameter('Last segment of this stop, inclusive.'),
								point: {
									type: 'string',
									description: 'A few words on what to say at this stop.'
								}
							},
							required: ['start_segment', 'end_segment', 'point']
						}
					}
				},
				required: ['stops']
			}
		},
		{
			type: 'function',
			name: 'continue_tour',
			description: 'Resume a paused walkthrough at its current stop.',
			parameters: { type: 'object', properties: {} }
		},
		{
			type: 'function',
			name: 'play_section',
			description:
				"Start the app's reading voice on a passage — for requests like 'read this section to me'. After calling it, stay silent: the narrator has the stage until the reader speaks to you again.",
			parameters: {
				type: 'object',
				properties: {
					start_segment: segmentParameter('First segment to read.'),
					end_segment: segmentParameter(
						'Last segment to read, inclusive. Omit for a single segment.'
					)
				},
				required: ['start_segment']
			}
		}
	];
	if (includeReadPassage) {
		tools.push({
			type: 'function',
			name: 'read_passage',
			description: 'Fetch the exact text of a segment range that is missing from your context.',
			parameters: {
				type: 'object',
				properties: {
					start_segment: segmentParameter('First segment number to fetch.'),
					end_segment: segmentParameter('Last segment number to fetch, inclusive.')
				},
				required: ['start_segment', 'end_segment']
			}
		});
	}
	return tools;
}

function toSegmentIndex(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
	return undefined;
}

export function parseAssistantToolCall(
	doc: NormalizedDocument,
	name: string,
	argumentsJson: string
): { call?: AssistantToolCall; error?: string } {
	let parsed: unknown;
	try {
		parsed = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
	} catch {
		return { error: 'The arguments were not valid JSON.' };
	}
	if (name === 'clear_highlight' || name === 'continue_tour') return { call: { name } };
	if (name === 'plan_tour') return parsePlanTour(doc, parsed);
	if (name !== 'show_passage' && name !== 'read_passage' && name !== 'play_section') {
		return { error: `Unknown tool "${name}".` };
	}
	const record = (parsed ?? {}) as Record<string, unknown>;
	const last = doc.segments.length - 1;
	const start = toSegmentIndex(record.start_segment);
	const end = record.end_segment === undefined ? start : toSegmentIndex(record.end_segment);
	if (start === undefined || end === undefined) {
		return { error: `start_segment and end_segment must be whole numbers from 0 to ${last}.` };
	}
	if (start > last || end > last) {
		return { error: `Segment numbers run 0 through ${last}.` };
	}
	return {
		call: { name, range: { startIndex: Math.min(start, end), endIndex: Math.max(start, end) } }
	};
}

function parsePlanTour(
	doc: NormalizedDocument,
	parsed: unknown
): { call?: AssistantToolCall; error?: string } {
	const stops = (parsed as { stops?: unknown })?.stops;
	if (!Array.isArray(stops) || stops.length === 0) {
		return { error: 'plan_tour needs a non-empty stops array.' };
	}
	if (stops.length > TOUR_STOP_LIMIT) {
		return { error: `Plan at most ${TOUR_STOP_LIMIT} stops.` };
	}
	const last = doc.segments.length - 1;
	const parsedStops: TourStop[] = [];
	for (const stop of stops) {
		const record = (stop ?? {}) as Record<string, unknown>;
		const start = toSegmentIndex(record.start_segment);
		const end = record.end_segment === undefined ? start : toSegmentIndex(record.end_segment);
		if (start === undefined || end === undefined || start > last || end > last) {
			return { error: `Every stop needs segment numbers from 0 to ${last}.` };
		}
		parsedStops.push({
			range: { startIndex: Math.min(start, end), endIndex: Math.max(start, end) },
			point: typeof record.point === 'string' ? record.point.slice(0, 200) : ''
		});
	}
	return { call: { name: 'plan_tour', stops: parsedStops } };
}

/** The passage's text with markers kept, so the model can cite precisely. */
export function readPassageText(
	doc: NormalizedDocument,
	range: PassageRange,
	charLimit = READ_PASSAGE_CHAR_LIMIT
): { text: string; truncated: boolean } {
	const parts: string[] = [];
	let length = 0;
	let previousBlockId: string | undefined;
	for (let index = range.startIndex; index <= range.endIndex; index += 1) {
		const segment = doc.segments[index];
		const separator = !parts.length ? '' : segment.blockId === previousBlockId ? ' ' : '\n\n';
		const piece = `${separator}${marker(index)} ${segmentText(doc, index)}`;
		if (length + piece.length > charLimit) return { text: parts.join(''), truncated: true };
		parts.push(piece);
		length += piece.length;
		previousBlockId = segment.blockId;
	}
	return { text: parts.join(''), truncated: false };
}

/** Title of the nearest outline entry at or before the passage — feedback the
 * model can use to confirm where it landed. */
export function describePassageLocation(doc: NormalizedDocument, range: PassageRange): string {
	const blockId = doc.segments[range.startIndex]?.blockId;
	if (!blockId) return '';
	const blockOrder = new Map(doc.blocks.map((block, index) => [block.id, index]));
	const target = blockOrder.get(blockId);
	if (target === undefined) return '';
	let title = '';
	for (const entry of doc.outline) {
		const position = blockOrder.get(entry.blockId);
		if (position !== undefined && position <= target) title = entry.title;
	}
	return title;
}
