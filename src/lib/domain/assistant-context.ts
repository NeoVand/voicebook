/**
 * Voice-assistant document context: serializes a normalized document into
 * marker-annotated text a realtime model can cite, and validates the tool
 * calls the model makes against it. Pure — the WebRTC session lives in
 * services/openai-realtime.ts and the orchestration in
 * state/realtime-assistant.svelte.ts.
 */
import { ANNOTATION_NOTE_LIMIT } from './annotations';
import {
	buildDocumentMap,
	mapSection,
	mapText,
	sectionAt,
	tidyMath,
	type DocumentMap
} from './document-map';
import { searchDocument } from './document-search';
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
	| { name: 'point_at'; segment: number }
	| { name: 'read_section'; section: string; fromSegment?: number }
	| { name: 'search_document'; query: string };

/** What the reader is pointing at right now, as segment indexes. */
export interface ReaderFocus {
	selection?: PassageRange;
	hovered?: number;
	playhead?: number;
}

export const TOUR_STOP_LIMIT = 8;

export interface AssistantInstructions {
	instructions: string;
	/** 'whole': the full text is in context. 'map': the document map is, and
	 * the model reads what it needs through read_section / search_document. */
	mode: 'whole' | 'map';
	segmentCount: number;
	/** The map the instructions were built from (map mode), for the reading
	 * tools to resolve section handles against. */
	map?: DocumentMap;
}

export interface RealtimeToolSpec {
	type: 'function';
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Documents up to about 30k tokens (roughly 20,000 words) travel whole:
 * below this the full text is cheaper than the lookups a map needs, and it
 * answers fastest. Longer ones get the map and reading tools — every answer
 * re-reads the context, so carrying a book costs per question, runs into
 * per-minute token limits, and buries the passage that matters.
 */
export const INLINE_DOCUMENT_CHAR_BUDGET = 120_000;

/** The map's share of the instructions (~15k tokens): room for hundreds of
 * sections before levels start collapsing. */
export const MAP_CHAR_BUDGET = 60_000;

/** One read_section page (~5k tokens) — a map part fits whole; longer
 * sections continue on request. Every extra page is another model round. */
export const READ_SECTION_CHAR_LIMIT = 20_000;

const SEARCH_RESULT_LIMIT = 8;

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
	const text = tidyMath(segment.text).replace(/\s+/g, ' ').trim();
	return text || segment.normalizedText.replace(/\s+/g, ' ').trim();
}

/** The raw content of a construct block — segments only carry the SPOKEN
 * description of an equation, table, or diagram, so without this the model
 * can talk about the narration but never about the thing itself. */
function blockSource(block: DocumentBlock | undefined): string {
	if (!block) return '';
	if (block.table) return `[table]\n${tableMarkdown(block.table)}`;
	if (block.kind === 'math') return `[equation] ${tidyMath(block.text).trim()}`;
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

/**
 * The backend brain behind a GPT-Live voice. It never speaks directly: the
 * voice says its replies, in its own words, so replies are written to be
 * heard — and it reaches the reader's screen through the same tools.
 */
const BRAIN_PREAMBLE = `You are the document expert behind Voicebook's live voice companion. A voice model is talking with a reader about the document below; when the reader asks about the document, the voice hands the request to you and then speaks your reply to the reader in its own words. What you write is heard, not read.

Write every reply to be spoken: plain conversational sentences — no markdown, lists, headings, tables, code, symbols, or LaTeX. Say formulas and numbers the way a person reads them aloud ("E equals m c squared", "about three point two million"). Never write the ⟦n⟧ marker numbers or the word "segment" — refer to places naturally ("the paragraph on…", "the section about…"). Two to four sentences, unless the reader asked for depth or a step-by-step explanation. Reply in the language the reader speaks.

The reader's words reach you through speech recognition, so they can contain mistakes, unfinished phrases, and corrections: go by the latest and likeliest meaning, and when a request is genuinely unclear, reply with one short question instead of guessing.

Markers like ⟦7⟧ number each passage of the document. Lines starting with [equation], [table], [code], or [diagram] carry the real content of those constructs; the ⟦n⟧ lines after them are the spoken descriptions the reader hears instead. Ground what you say about an equation, table, or diagram in the real content, and then say it in words.

When your reply is about a specific part of the document, call show_passage with that passage's markers before you reply, so the reader sees it highlighted while the voice speaks. Highlight the one passage your reply centers on; when it spans several places, highlight the first and name the others.

When the reader says "this", "here", or "what I'm looking at" ("explain this", "what does this mean?"), call get_reader_focus first — it reports their text selection, the passage under their cursor, and the narration playhead; trust the selection over the hover, and the hover over the playhead — then answer about it.

When the reader asks for an overview or a walkthrough ("walk me through…", "give me the big picture", "what should I read?"), call plan_tour with three to seven stops in reading order — each stop a marker range plus a few words on why it matters. The app highlights stop 1 and asks you to narrate it, then highlights each next stop as the voice finishes the one before: narrate each in a sentence or two, about that stop only. If the reader interrupts with a question, answer it; call continue_tour when they want to go on.

When the reader asks to hear part of the document read aloud ("read this section to me", "play it from here"), call play_section with that range and reply with at most a short lead-in ("Here it is."). The app's reading voice takes over once the voice finishes.

When the reader asks to keep something — "highlight this", "save that definition", "add a note here saying…" — call add_highlight or add_note with the exact marker range; keep note text to a sentence or two, in the reader's own framing. When an exchange reaches something worth carrying into the next conversation — a question resolved, a connection the reader made, or "remember this" — call save_memory with one or two sentences. A READER STATE section, when present, holds those notes, what the reader has heard or discussed, and where the last conversation left off: use it for "what did we cover?", "where was I?", and "what's left?".

When the reader asks about something beyond the document — recent developments, whether a claim still holds, background the text assumes — call web_research with one focused question, ground your reply in what comes back, and name the source in passing ("according to…"). The finding is saved into the study notes automatically. Never present web findings as part of the document.

Make tool calls silently, before you reply: never announce them, and say what happened rather than what you are about to do. Ground everything in the document; when it does not contain the answer, say so plainly.`;

const MAP_PREAMBLE = `This document is long, so instead of its full text you have its MAP below: every section with its ⟦first–last⟧ passage markers, its length, a one-line gist (a study note, or the section's opening line), and entry points — equations, tables, figures, code, and the reader's own highlights, notes, and saved notes — each at its ⟦n⟧ marker. Sections nest: a chapter's range and length take in the subsections indented under it.

The map tells you where things are; it is not the text. Before you quote, explain, walk through, or answer anything specific, read the section with read_section (a long section comes back a page at a time — keep reading with from_segment when the answer may be further on), or find the place with search_document when the map does not say where it is — a few distinctive words per search, and several short searches rather than one long one. Never answer details from a gist alone, and never say the document does not cover something until two searches with different words have come back empty-handed. Overview questions — what the document is about, what a chapter covers, what to read next — can come straight from the map and the abstract. The ⟦n⟧ markers in the map and in what you read work with every tool that takes them.`;

const STUDY_PREAMBLE = `A STUDY NOTES section below carries a background-generated abstract and per-section notes, each tagged with its first ⟦n⟧ marker. Lean on it for overview, review, and "what should I read next" questions, and jump to the noted sections with show_passage or plan_tour. It is a map, not the text — ground quotes and details in the document itself.`;

/** Who reads the instructions: a speech-to-speech 'voice' model that talks
 * to the reader itself (GPT Realtime), or the 'brain' behind a GPT-Live
 * voice, whose replies the voice speaks. */
export type AssistantRole = 'voice' | 'brain';

export interface AssistantInstructionOptions {
	role?: AssistantRole;
	/** Longest document body carried whole; longer ones get the map. */
	inlineBudget?: number;
}

export function buildAssistantInstructions(
	doc: NormalizedDocument,
	{ role = 'voice', inlineBudget = INLINE_DOCUMENT_CHAR_BUDGET }: AssistantInstructionOptions = {}
): AssistantInstructions {
	const preamble = role === 'brain' ? BRAIN_PREAMBLE : PREAMBLE;
	const { body, cutAt } = serializeBody(doc, inlineBudget);
	// Never half a document: what does not fit whole is read through the map.
	if (cutAt >= 0) return buildMapInstructions(doc, preamble);
	const outline = serializeOutline(doc);
	const study = composeStudyBlock(doc);
	const readerState = composeReaderState(doc);
	const sections = [preamble];
	if (study) sections.push(STUDY_PREAMBLE);
	if (outline) sections.push(`=== OUTLINE ===\n${outline}`);
	if (study) sections.push(`=== STUDY NOTES ===\n${study}`);
	if (readerState) sections.push(`=== READER STATE ===\n${readerState}`);
	sections.push(`=== DOCUMENT: ${doc.title} ===\n${body}`);
	return {
		instructions: sections.join('\n\n'),
		mode: 'whole',
		segmentCount: doc.segments.length
	};
}

/** Long documents: the map in place of the text, plus the abstract and what
 * past sessions established. Section notes already live in the map. */
function buildMapInstructions(doc: NormalizedDocument, preamble: string): AssistantInstructions {
	const map = buildDocumentMap(doc);
	const abstract = doc.study?.abstractStatus === 'ready' ? doc.study.abstract?.trim() : '';
	const readerState = composeReaderState(doc);
	const sections = [preamble, MAP_PREAMBLE];
	if (abstract) sections.push(`=== ABSTRACT ===\n${abstract}`);
	if (readerState) sections.push(`=== READER STATE ===\n${readerState}`);
	sections.push(`=== MAP: ${doc.title} ===\n${mapText(map, MAP_CHAR_BUDGET)}`);
	return {
		instructions: sections.join('\n\n'),
		mode: 'map',
		segmentCount: doc.segments.length,
		map
	};
}

function segmentParameter(description: string): Record<string, unknown> {
	return { type: 'integer', minimum: 0, description };
}

/** The assistant's tools; map mode adds the reading tools. */
export function assistantTools(mapMode: boolean): RealtimeToolSpec[] {
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
	if (mapMode) {
		tools.push(
			{
				type: 'function',
				name: 'read_section',
				description:
					'Read the text of one section from the document map, by its S-number. Long sections come back a page at a time; pass from_segment to continue where the last page stopped.',
				parameters: {
					type: 'object',
					properties: {
						section: {
							type: 'string',
							description: 'The section handle from the map, e.g. "S12".'
						},
						from_segment: segmentParameter(
							'Optional ⟦n⟧ marker to continue reading from, inside the section.'
						)
					},
					required: ['section']
				}
			},
			{
				type: 'function',
				name: 'search_document',
				description:
					'Find passages by their words — a name, a term, a phrase, a quote — when the map does not say where something is. Use two to four distinctive words the text itself would use; for a different angle, search again rather than adding words. Returns the best matches with their ⟦n⟧ markers and sections.',
				parameters: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'Two to four distinctive words, e.g. "doubloon mast".'
						}
					},
					required: ['query']
				}
			},
			{
				type: 'function',
				name: 'read_passage',
				description:
					'Read the exact text of a ⟦n⟧ marker range — a search hit, a map entry point, or the passages around one.',
				parameters: {
					type: 'object',
					properties: {
						start_segment: segmentParameter('First segment number to fetch.'),
						end_segment: segmentParameter('Last segment number to fetch, inclusive.')
					},
					required: ['start_segment', 'end_segment']
				}
			}
		);
	}
	return tools;
}

/** Pointing at one step of a passage has to follow the voice word by word,
 * which a brain that answers in one go cannot time. */
const VOICE_PACED_TOOLS = new Set(['point_at']);
/** Walkthroughs advance when the voice finishes a stop — there is no voice to
 * pace them in typed chat. */
const TOUR_TOOLS = new Set(['plan_tour', 'continue_tour']);

/** Tools whose whole effect is on the reader's screen or in their notes —
 * the model has nothing to wait for, so in typed chat they run async and the
 * reply streams in the same turn. */
const SCREEN_TOOLS = new Set([
	'show_passage',
	'clear_highlight',
	'add_highlight',
	'add_note',
	'save_memory',
	'play_section'
]);

/**
 * The brain's tools. Typed chat (`typed`) has no voice to pace walkthroughs,
 * and marks the screen-only tools async — supported by the Responses API
 * directly but rejected inside a GPT-Live session's delegation.
 */
export function brainTools(
	mapMode: boolean,
	{ typed = false }: { typed?: boolean } = {}
): Array<RealtimeToolSpec & { async?: boolean }> {
	const asyncScreenTools = typed;
	return assistantTools(mapMode)
		.filter((tool) => !VOICE_PACED_TOOLS.has(tool.name))
		.filter((tool) => !(typed && TOUR_TOOLS.has(tool.name)))
		.map((tool) =>
			asyncScreenTools && SCREEN_TOOLS.has(tool.name) ? { ...tool, async: true } : tool
		);
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
	if (name === 'read_section') {
		const record = (parsed ?? {}) as Record<string, unknown>;
		const section =
			typeof record.section === 'string'
				? record.section.trim()
				: typeof record.section === 'number'
					? String(record.section)
					: '';
		if (!section) return { error: 'read_section needs a section handle from the map, like "S12".' };
		const from = toSegmentIndex(record.from_segment);
		return {
			call: {
				name: 'read_section',
				section: section.slice(0, 120),
				...(from === undefined ? {} : { fromSegment: from })
			}
		};
	}
	if (name === 'search_document') {
		const query =
			typeof (parsed as { query?: unknown })?.query === 'string'
				? (parsed as { query: string }).query.trim()
				: '';
		if (!query) return { error: 'search_document needs a non-empty query string.' };
		return { call: { name: 'search_document', query: query.slice(0, 200) } };
	}
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

/** The passage's text with markers kept, so the model can cite precisely.
 * `lastIndex` is the last passage included (-1 when none fit), so a reader
 * paging through a long range knows where to continue. */
export function readPassageText(
	doc: NormalizedDocument,
	range: PassageRange,
	charLimit = READ_PASSAGE_CHAR_LIMIT
): { text: string; truncated: boolean; lastIndex: number } {
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
		if (length + piece.length > charLimit) {
			return { text: parts.join(''), truncated: true, lastIndex: index - 1 };
		}
		parts.push(piece);
		length += piece.length;
		previousBlockId = segment.blockId;
	}
	return { text: parts.join(''), truncated: false, lastIndex: range.endIndex };
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

/**
 * read_section's result: the section's text with markers, a page at a time.
 * The map is the one the instructions were built from, so the S-numbers the
 * model saw are the ones that resolve.
 */
export function readSectionOutput(
	doc: NormalizedDocument,
	map: DocumentMap,
	handle: string,
	fromSegment?: number,
	charLimit = READ_SECTION_CHAR_LIMIT
): Record<string, unknown> {
	const section = mapSection(map, handle);
	if (!section) {
		return {
			error: `There is no section "${handle}". Use an S-number from the map, S1 to S${map.sections.length}.`
		};
	}
	const start =
		fromSegment !== undefined && fromSegment >= section.start && fromSegment <= section.end
			? fromSegment
			: section.start;
	const page = readPassageText(doc, { startIndex: start, endIndex: section.end }, charLimit);
	// A single passage longer than a page still has to come through.
	const text =
		page.lastIndex < start
			? readPassageText(doc, { startIndex: start, endIndex: start }, Number.POSITIVE_INFINITY).text
			: page.text;
	const lastIndex = Math.max(page.lastIndex, start);
	const output: Record<string, unknown> = {
		section: `${section.id} ${section.title}`,
		passages: `⟦${start}⟧–⟦${lastIndex}⟧ of ⟦${section.start}⟧–⟦${section.end}⟧`,
		text
	};
	if (lastIndex < section.end) {
		output.continue_from = lastIndex + 1;
		output.note = `The section continues — call read_section with from_segment ${lastIndex + 1} to read on.`;
	}
	return output;
}

/** search_document's result: the best matches, each placed on the map. */
export function searchDocumentOutput(
	doc: NormalizedDocument,
	map: DocumentMap,
	query: string
): Record<string, unknown> {
	const hits = searchDocument(doc, query, SEARCH_RESULT_LIMIT);
	if (!hits.length) {
		return {
			results: [],
			note: 'Nothing in the document uses those words. Try other terms, or look through the map.'
		};
	}
	return {
		results: hits.map((hit) => {
			const section = sectionAt(map, hit.snippetSegment);
			return {
				...(section ? { section: `${section.id} ${section.title}` } : {}),
				passages: hit.start === hit.end ? `⟦${hit.start}⟧` : `⟦${hit.start}⟧–⟦${hit.end}⟧`,
				text: `${marker(hit.snippetSegment)} ${tidyMath(hit.snippet)}`
			};
		})
	};
}
