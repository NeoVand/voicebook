/**
 * What a GPT-Live voice is told. The voice runs the conversation — tone,
 * turn-taking, when to hand a request to the brain — on a short prompt of its
 * own (16,384 tokens at most, fixed for the session); the document itself and
 * every tool live with the brain (assistant-context.ts, role 'brain'). Also
 * the conversation carried into a new session, and the notes that keep the
 * voice aware of what the reader typed. Pure.
 */
import { buildDocumentMap } from './document-map';
import type { NormalizedDocument } from './types';

/** Room for the document's sketch in the voice prompt — the section titles
 * tell the voice what the reader can ask about. */
const SKETCH_CHARS = 2_000;
/** Live accepts up to 128 seed messages and 8,192 tokens; characters are a
 * conservative stand-in for tokens across languages. */
export const SEED_MESSAGE_LIMIT = 128;
export const SEED_CHAR_BUDGET = 20_000;
/** Appends are capped at 500 tokens. */
const NOTE_CHARS = 1_200;

const KIND_NAMES: Record<NormalizedDocument['sourceKind'], string> = {
	pdf: 'a PDF',
	docx: 'a Word document',
	markdown: 'a Markdown document',
	text: 'a text document',
	web: 'a web article'
};

function languageName(code: string): string {
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English';
	} catch {
		return 'English';
	}
}

function listeningTime(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 2) return 'a minute or two';
	if (minutes < 60) return `about ${minutes} minutes`;
	const hours = Math.round(minutes / 30) / 2;
	return `about ${hours} hours`;
}

function clip(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** The document in a few lines: what it is, how long, what it covers. */
export function documentSketch(doc: NormalizedDocument): string {
	const map = buildDocumentMap(doc);
	const lines = [
		`"${doc.title}" is ${KIND_NAMES[doc.sourceKind] ?? 'a document'}, ${listeningTime(map.seconds)} of listening.`
	];
	const titles = map.sections
		.filter((section) => section.level === 1)
		.map((section) => section.title.trim())
		.filter(Boolean);
	if (titles.length > 1) {
		let covered = '';
		let shown = 0;
		for (const title of titles) {
			const next = covered ? `${covered}; ${title}` : title;
			if (next.length > SKETCH_CHARS) break;
			covered = next;
			shown += 1;
		}
		const rest = titles.length - shown;
		lines.push(`Its sections: ${covered}${rest ? `; and ${rest} more` : ''}.`);
	}
	return lines.join(' ');
}

/** The voice's session instructions, in the template GPT-Live is tuned on:
 * persona, then the backchannel, interruption, and delegation policies. */
export function buildLiveVoiceInstructions(doc: NormalizedDocument): string {
	const language = languageName(doc.language || 'en');
	return `You are Voicebook's reading companion: a calm, friendly voice that helps a reader understand the document they have open.
Speak warmly and naturally, at an unhurried pace. Keep replies short and conversational — a few sentences — unless the reader asks for more. Speak the language the reader speaks to you; until they speak, use ${language}.
Say everything in plain spoken words: never read out symbols, formatting, link addresses, or passage numbers, and say formulas the way a person reads them aloud.
You never have the document's text yourself. When the reader wants part of it read aloud, the app's own reading voice reads it: hand the request to the backend, say at most a few words, and then stay silent — never read, recite, or summarize the passage as if reading it.

About the document: ${documentSketch(doc)}

Backchannel policy: Use sparse backchannels. Acknowledge naturally without competing with the reader.

Interruption policy: Stop speaking when the reader interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Document expert: has the whole document; reads, searches, quotes, and explains any part of it, and highlights passages on the reader's screen as you talk about them.
- Reader's screen: knows what the reader has selected or is pointing at, adds highlights and margin notes, saves notes for next time, and starts the app's reading voice on a section.
- Walkthroughs: plans a guided tour of the document and moves the highlight from stop to stop as you narrate each one.
- Web research: looks up things beyond the document, such as recent developments or background.

Delegate to the backend when:
- The reader asks anything about the document's content: what it says, what it means, or where something is.
- The reader refers to "this", "here", or what they are looking at.
- The reader asks you to show, highlight, note, save, or read something aloud.
- The reader asks for an overview, a walkthrough, or what to read next — or to go on with a walkthrough.
- The reader asks about something beyond the document.
- A correction changes a request already underway.

Do not delegate to the backend when:
- The reader greets you, thanks you, or makes small talk.
- The reader asks you to repeat or rephrase what you just said.
- You need a brief clarification to understand the request.

Delegate before giving an answer that depends on backend work. Do not guess the result while waiting. Never answer questions about the document from your own knowledge — the backend has the text.`;
}

/** Sent once the session starts, when the voice should open the
 * conversation. */
export function liveGreeting(doc: NormalizedDocument): string {
	const language = languageName(doc.language || 'en');
	return `Greet the reader now in ${language}, in one short sentence: mention "${clip(doc.title, 120)}" and offer to answer questions about it or read parts of it aloud. Then pause and listen.`;
}

export interface SeedMessage {
	role: 'user' | 'assistant';
	text: string;
	pending?: boolean;
}

export type LiveInputMessage =
	| { type: 'message'; role: 'user'; content: [{ type: 'input_text'; text: string }] }
	| { type: 'message'; role: 'assistant'; content: [{ type: 'output_text'; text: string }] };

/**
 * The conversation so far, for a new session's `input`: the newest turns
 * that fit Live's limits, consecutive turns by the same speaker merged, in
 * order. The voice then knows what was said — or typed — before it connected.
 */
export function liveSeedInput(messages: SeedMessage[]): LiveInputMessage[] {
	const turns = mergedTurns(messages);
	const kept: SeedMessage[] = [];
	let budget = SEED_CHAR_BUDGET;
	for (let index = turns.length - 1; index >= 0 && kept.length < SEED_MESSAGE_LIMIT; index -= 1) {
		const turn = turns[index];
		if (turn.text.length > budget) {
			// One long turn still carries its most recent part.
			if (budget > 200) kept.unshift({ role: turn.role, text: `…${turn.text.slice(-budget + 1)}` });
			break;
		}
		kept.unshift(turn);
		budget -= turn.text.length;
	}
	return kept.map((turn) =>
		turn.role === 'user'
			? { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.text }] }
			: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] }
	);
}

/** How much conversation a typed turn sends the brain — every turn re-reads
 * it, so the oldest exchanges drop off first. */
export const BRAIN_CHAT_CHAR_BUDGET = 30_000;

function mergedTurns(messages: SeedMessage[]): SeedMessage[] {
	const turns: SeedMessage[] = [];
	for (const message of messages) {
		const text = message.text.trim();
		if (!text || message.pending) continue;
		const last = turns.at(-1);
		if (last?.role === message.role) last.text = `${last.text}\n${text}`;
		else turns.push({ role: message.role, text });
	}
	return turns;
}

/**
 * The conversation as Responses input for a typed turn: the newest turns
 * that fit the budget — typed and spoken alike — then a note that this turn
 * was typed, so the brain does not answer as if it were heard.
 */
export function brainChatInput(
	messages: SeedMessage[],
	budget = BRAIN_CHAT_CHAR_BUDGET
): Array<{ role: 'user' | 'assistant' | 'developer'; content: string }> {
	const turns = mergedTurns(messages);
	const kept: SeedMessage[] = [];
	let room = budget;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		if (turns[index].text.length > room && kept.length) break;
		kept.unshift(turns[index]);
		room -= turns[index].text.length;
	}
	// The conversation opens with the reader.
	while (kept[0]?.role === 'assistant') kept.shift();
	return [
		...kept.map((turn) => ({ role: turn.role, content: turn.text })),
		{
			role: 'developer' as const,
			content:
				'The reader typed their last message in the chat panel; your reply appears there as text (and may also be read aloud). Keep the same plain, spoken style.'
		}
	];
}

/** Mirrors a typed question to the voice, which cannot see the chat: the
 * question itself goes to the brain, and the voice then speaks its answer. */
export function typedQuestionNote(text: string): string {
	return `The reader typed this in the chat panel instead of saying it: "${clip(text, NOTE_CHARS)}". It has gone to the backend; when the answer comes back, say it.`;
}

/** Tells a live voice about an exchange that happened silently in the chat,
 * so a later "what about that?" makes sense. */
export function typedExchangeNote(question: string, answer: string): string {
	return `In the chat panel, the reader typed "${clip(question, NOTE_CHARS / 2)}" and got this written answer: "${clip(answer, NOTE_CHARS / 2)}". Do not repeat it unless they ask.`;
}
