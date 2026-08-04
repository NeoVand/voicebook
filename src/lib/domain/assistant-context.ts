/**
 * Voice-assistant document context: serializes a normalized document into
 * marker-annotated text a realtime model can cite, and validates the tool
 * calls the model makes against it. Pure — the WebRTC session lives in
 * services/openai-realtime.ts and the orchestration in
 * state/realtime-assistant.svelte.ts.
 */
import { ANNOTATION_NOTE_LIMIT } from './annotations';
import { tableMarkdown } from './narration';
import { MEMORY_TEXT_LIMIT, composeReaderState, composeStudyBlock } from './study-tree';
import type { DocumentBlock, NormalizedDocument } from './types';

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
	| { name: 'add_highlight'; range: PassageRange }
	| { name: 'add_note'; range: PassageRange; text: string }
	| { name: 'save_memory'; text: string; segment?: number }
	| { name: 'web_research'; query: string }
	| { name: 'clear_highlight' }
	| { name: 'plan_tour'; stops: TourStop[] }
	| { name: 'continue_tour' }
	| { name: 'get_reader_focus' }
	| { name: 'point_at'; segment: number };

/** What the reader is pointing at right now, as segment indexes. */
export interface ReaderFocus {
	selection?: PassageRange;
	hovered?: number;
	playhead?: number;
}

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

/** Tools whose entire result is "done": the reader can see the mark land, so
 * there is nothing for a follow-up response to add. Every other tool either
 * answers with its result (read_passage, get_reader_focus, web_research) or
 * hands the assistant something to narrate (plan_tour), and always gets its
 * turn — suppressing one of those would leave a question unanswered, which is
 * far worse than hearing a confirmation twice. */
const CONFIRMATION_TOOLS = new Set([
	'add_highlight',
	'add_note',
	'save_memory',
	'point_at',
	'clear_highlight'
]);

/** One tool call from a finished response, as the follow-up decision sees it. */
export interface SettledToolCall {
	name: string;
	/** Still running — it will ask for its own response when it lands. */
	pending?: boolean;
	/** Came back with an error. */
	failed?: boolean;
}

/**
 * Whether a finished response that called tools should be answered with
 * another one.
 *
 * Nearly all of them are: the follow-up is how the reader hears what came
 * back. The exception is the case that gave the assistant away as a machine —
 * it says "Okay, I've added that note" in the same response that calls
 * add_note, and then the follow-up says it a second time. When the whole
 * response was marks the reader can already see, and something was already
 * said about them, it ends there.
 *
 * A failed tool always gets its turn: the reader is owed the correction,
 * especially when the response has already claimed success.
 */
export function shouldFollowUpAfterTools(calls: SettledToolCall[], spoke: boolean): boolean {
	if (!calls.length) return false;
	// After play_section the narration voice has the stage — a follow-up would
	// talk over it.
	if (calls.some((call) => call.name === 'play_section')) return false;
	if (calls.some((call) => call.pending)) return false;
	if (calls.some((call) => call.failed)) return true;
	return !spoke || !calls.every((call) => CONFIRMATION_TOOLS.has(call.name));
}

function marker(index: number): string {
	return `⟦${index}⟧`;
}

function segmentText(doc: NormalizedDocument, index: number): string {
	const segment = doc.segments[index];
	const text = segment.text.replace(/\s+/g, ' ').trim();
	return text || segment.normalizedText.replace(/\s+/g, ' ').trim();
}

/** The raw content of a construct block — segments only carry the SPOKEN
 * description of an equation, table, or diagram, so without this the model
 * can talk about the narration but never about the thing itself. */
function blockSource(block: DocumentBlock | undefined): string {
	if (!block) return '';
	if (block.table) return `[table]\n${tableMarkdown(block.table)}`;
	if (block.kind === 'math') return `[equation] ${block.text.trim()}`;
	if (block.kind === 'mermaid' || (block.kind === 'code' && block.codeLanguage === 'mermaid')) {
		return `[diagram]\n${block.text.trim()}`;
	}
	if (block.kind === 'code') {
		return `[code${block.codeLanguage ? ` ${block.codeLanguage}` : ''}]\n${block.text.trim()}`;
	}
	return '';
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
			const source = blockSource(block);
			piece = `${parts.length ? '\n\n' : ''}${source ? `${source}\n` : ''}${heading}${marker(index)} ${segmentText(doc, index)}`;
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

Lines starting with [equation], [table], [code], or [diagram] carry the real content of those constructs; the ⟦n⟧ lines after them are the spoken descriptions the reader hears instead. Ground everything you say about an equation, table, or diagram in the real content, not the description.

Whenever you discuss, quote, summarize, or explain a specific part of the document, call show_passage with that passage's marker numbers first, so the reader sees it highlighted while you speak. When one answer touches several places, call show_passage again for each part just before you speak about it — the highlight should follow your voice. When a highlighted passage has several pieces — bullets, list items, table rows, steps — call point_at with the exact segment you are describing as you reach it: the reader follows the darker mark through the passage. Call clear_highlight when the conversation leaves the document.

When the reader says "this", "here", or "what I'm looking at" ("explain this section", "what does this mean?"), call get_reader_focus first — it reports their text selection, the passage under their cursor, and the narration playhead. Trust the selection over the hover, and the hover over the playhead. Then show_passage it and answer.

When the reader asks for an overview or a walkthrough ("walk me through…", "give me the big picture", "what should I read?"), call plan_tour with three to seven stops in reading order — each stop is a marker range plus a few words on why it matters. The app then walks you stop by stop: narrate the highlighted stop in a sentence or two, and the next stop arrives when you finish speaking. If the reader interrupts with a question, answer it; call continue_tour when they are ready to go on.

When the reader asks to hear part of the document read aloud ("read this section to me", "play it from here"), call play_section with that range — the app's reading voice takes over, waiting for you to finish speaking first. A short lead-in ("Here's that section") is fine; after it, stay silent until the reader speaks to you again.

When the reader asks you to mark something for keeps — "highlight this", "save that definition", "add a note here saying…" — call add_highlight or add_note with the exact marker range. These leave permanent gold marks and margin notes that stay with the document after the conversation; keep note text to a sentence or two, in the reader's own framing. For merely drawing attention while you talk, keep using show_passage — its highlight fades; add_highlight and add_note are for ink the reader asked to keep.

Do the thing before you talk about it. Never announce a call you are about to make — no "let me add that", no "I'll highlight it and then confirm". Make the call silently, and say your one short line afterwards, about what happened rather than what is coming. Say it once: an action you have already confirmed is finished business, and repeating it is the surest way to sound like a machine.

You also keep notes across conversations: when an exchange reaches something worth carrying forward — a question resolved, a connection the reader made, or "remember this for next time" — call save_memory with one or two sentences (and the passage's marker when it is about a specific place). A READER STATE section, when present, holds these notes plus what the reader has already heard or discussed and where the last conversation left off. Lean on it when they ask what you covered last time (recap from the notes), to continue where they left off (show_passage the left-off spot and pick up from there), or what is left (walk the not-yet-visited sections).

When the reader asks about something beyond the document — recent developments, whether a claim still holds, background the text assumes — call web_research with one focused question. Tell them you are looking it up first: the search takes a few seconds. Ground your answer in what comes back and name the source in passing ("according to …"); the finding is saved into the study notes automatically, so mention they can find it there. Never present web findings as part of the document.

Ground everything you say in the document; when it does not contain the answer, say so plainly. Match the language the reader speaks to you (start in the document's language). Keep replies short and conversational — a few sentences unless the reader asks for depth.`;

const STUDY_PREAMBLE = `A STUDY NOTES section below carries a background-generated abstract and per-section notes, each tagged with its first ⟦n⟧ marker. Lean on it for overview, review, and "what should I read next" questions, and jump to the noted sections with show_passage or plan_tour. It is a map, not the text — ground quotes and details in the document itself.`;

export function buildAssistantInstructions(
	doc: NormalizedDocument,
	charBudget = ASSISTANT_CONTEXT_CHAR_BUDGET
): AssistantInstructions {
	const { body, cutAt } = serializeBody(doc, charBudget);
	const outline = serializeOutline(doc);
	const study = composeStudyBlock(doc);
	const readerState = composeReaderState(doc);
	const sections = [PREAMBLE];
	if (study) sections.push(STUDY_PREAMBLE);
	if (outline) sections.push(`=== OUTLINE ===\n${outline}`);
	if (study) sections.push(`=== STUDY NOTES ===\n${study}`);
	if (readerState) sections.push(`=== READER STATE ===\n${readerState}`);
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
			name: 'point_at',
			description:
				'Within the highlighted passage, put a stronger mark on the one segment you are describing right now — move it piece by piece through bullets, rows, or steps.',
			parameters: {
				type: 'object',
				properties: {
					segment: segmentParameter('The ⟦n⟧ segment to emphasize.')
				},
				required: ['segment']
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
			name: 'get_reader_focus',
			description:
				'See what the reader is pointing at right now: their text selection, the passage under their mouse, and the narration playhead, as segment numbers. Call when they say "this", "here", or similar.',
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
			name: 'add_highlight',
			description:
				'Permanently highlight a passage in gold — ink that stays with the document after the conversation. Only when the reader asks to highlight, mark, or save a passage.',
			parameters: {
				type: 'object',
				properties: {
					start_segment: segmentParameter('First segment of the passage to highlight.'),
					end_segment: segmentParameter('Last segment, inclusive. Omit for a single segment.')
				},
				required: ['start_segment']
			}
		},
		{
			type: 'function',
			name: 'add_note',
			description:
				'Attach a permanent margin note to a passage, kept with the document. Only when the reader asks to note, comment, or remember something; keep the note to a sentence or two.',
			parameters: {
				type: 'object',
				properties: {
					start_segment: segmentParameter('First segment the note refers to.'),
					end_segment: segmentParameter('Last segment, inclusive. Omit for a single segment.'),
					note: { type: 'string', description: 'The note text, in the reader’s framing.' }
				},
				required: ['start_segment', 'note']
			}
		},
		{
			type: 'function',
			name: 'save_memory',
			description:
				'Keep a takeaway from this conversation with the document for future sessions — a resolved question, a connection the reader made, or something they asked to remember. One or two sentences.',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string', description: 'The takeaway, in the reader’s framing.' },
					segment: segmentParameter(
						'Optional ⟦n⟧ marker of the passage the note is about, when there is one.'
					)
				},
				required: ['note']
			}
		},
		{
			type: 'function',
			name: 'web_research',
			description:
				'Search the current web for one focused question beyond this document — recent developments, outside facts, background the text assumes. Takes a few seconds; say you are looking it up first. The finding is saved to the study notes automatically.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The question to research, focused and self-contained.'
					}
				},
				required: ['query']
			}
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
	if (name === 'clear_highlight' || name === 'continue_tour' || name === 'get_reader_focus') {
		return { call: { name } };
	}
	if (name === 'plan_tour') return parsePlanTour(doc, parsed);
	if (name === 'web_research') {
		const query =
			typeof (parsed as { query?: unknown })?.query === 'string'
				? ((parsed as { query: string }).query ?? '').trim()
				: '';
		if (!query) return { error: 'web_research needs a non-empty query string.' };
		return { call: { name: 'web_research', query: query.slice(0, 400) } };
	}
	if (name === 'save_memory') {
		const record = (parsed ?? {}) as Record<string, unknown>;
		const text = typeof record.note === 'string' ? record.note.trim() : '';
		if (!text) return { error: 'save_memory needs a non-empty note string.' };
		// An out-of-range anchor is dropped rather than failing the save — the
		// note itself is the point.
		const segment = toSegmentIndex(record.segment);
		const anchored = segment !== undefined && segment < doc.segments.length ? segment : undefined;
		return {
			call: {
				name: 'save_memory',
				text: text.slice(0, MEMORY_TEXT_LIMIT),
				...(anchored === undefined ? {} : { segment: anchored })
			}
		};
	}
	if (name === 'point_at') {
		const segment = toSegmentIndex((parsed as { segment?: unknown })?.segment);
		const last = doc.segments.length - 1;
		if (segment === undefined || segment > last) {
			return { error: `point_at needs a segment number from 0 to ${last}.` };
		}
		return { call: { name: 'point_at', segment } };
	}
	if (
		name !== 'show_passage' &&
		name !== 'read_passage' &&
		name !== 'play_section' &&
		name !== 'add_highlight' &&
		name !== 'add_note'
	) {
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
	const range = { startIndex: Math.min(start, end), endIndex: Math.max(start, end) };
	if (name === 'add_note') {
		const text = typeof record.note === 'string' ? record.note.trim() : '';
		if (!text) return { error: 'add_note needs a non-empty note string.' };
		return { call: { name, range, text: text.slice(0, ANNOTATION_NOTE_LIMIT) } };
	}
	return { call: { name, range } };
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
	const blocksById = new Map(doc.blocks.map((block) => [block.id, block]));
	const parts: string[] = [];
	let length = 0;
	let previousBlockId: string | undefined;
	for (let index = range.startIndex; index <= range.endIndex; index += 1) {
		const segment = doc.segments[index];
		const separator = !parts.length ? '' : segment.blockId === previousBlockId ? ' ' : '\n\n';
		const source =
			segment.blockId === previousBlockId ? '' : blockSource(blocksById.get(segment.blockId));
		const piece = `${separator}${source ? `${source}\n` : ''}${marker(index)} ${segmentText(doc, index)}`;
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
