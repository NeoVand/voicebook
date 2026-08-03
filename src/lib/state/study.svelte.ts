/**
 * The background study scheduler: a lighter sibling of NarrationState. One
 * document at a time, sections summarized through the cloud study engine with
 * a small concurrent pool, results cached on the document by source hash, and
 * a whole-document abstract distilled once every section settles. No GPU
 * contention and no segment rebinding — summaries never touch the spoken
 * layer.
 */
import {
	abstractNeeded,
	abstractSourceHash,
	languageName,
	looksLikeLanguage,
	reconcileStudy,
	studyAbstractMessages,
	studySectionMessages,
	studySections,
	type StudySection
} from '$lib/domain/study-tree';
import type { StudyNode } from '$lib/domain/types';
import { CloudLlmError, generateCloud } from '$lib/services/cloud-llm';
import { appState } from './app-state.svelte';
import { player } from './player.svelte';
import { providersState } from './providers.svelte';

export type StudyPhase = 'idle' | 'running';

/** Independent HTTP calls — the same small pool the narration layer uses. */
const CLOUD_CONCURRENCY = 3;
const PERSIST_DEBOUNCE_MS = 1_000;
const MAX_RETRY_AFTER_MS = 15_000;
/** cloudTokenBudget scales these ×4: ~480 tokens per summary, 512 for the
 * abstract — generous for three sentences, cheap on the fast tiers. */
const SECTION_MAX_TOKENS = 120;
const ABSTRACT_MAX_TOKENS = 128;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StudyState {
	phase = $state<StudyPhase>('idle');
	documentId = $state<string | null>(null);
	total = $state(0);
	completed = $state(0);
	failed = $state(0);
	error = $state('');

	private runToken = 0;
	private queue: StudySection[] = [];
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	/** Whether any study engine can run right now (a keyed cloud provider). */
	get available(): boolean {
		return providersState.cloudStudyEngine !== null;
	}

	get working(): boolean {
		return this.phase === 'running';
	}

	get done(): number {
		return this.completed + this.failed;
	}

	/**
	 * Reconcile a freshly opened document and start the background queue.
	 * Call after player.setDocument — results apply through player.book so the
	 * drawer re-renders. Without an engine the stored study stays readable but
	 * nothing regenerates.
	 */
	async open(): Promise<void> {
		this.stop();
		const token = ++this.runToken;
		await providersState.initialize();
		const book = player.book;
		if (!book || token !== this.runToken) return;
		this.documentId = book.id;
		this.completed = 0;
		this.failed = 0;
		this.error = '';
		if (!providersState.cloudStudyEngine) {
			this.total = 0;
			return;
		}
		const { study, queue, changed } = reconcileStudy(studySections(book), book.study);
		if (token !== this.runToken) return;
		book.study = study;
		if (changed) this.schedulePersist();
		this.queue = queue;
		this.total = queue.length;
		void this.run(token);
	}

	/** Abandon the queue (document closed or switched). In-flight calls settle
	 * on their own; their results are dropped by the token check. */
	stop(): void {
		this.runToken += 1;
		this.queue = [];
		this.phase = 'idle';
	}

	/** Drop the tree and regenerate the whole document now. */
	async rebuild(): Promise<void> {
		const book = player.book;
		if (!book) return;
		book.study = undefined;
		await this.open();
	}

	/** Remove the study layer entirely; it regenerates on the next open (or
	 * Rebuild) while an engine is available. */
	clear(): void {
		const book = player.book;
		if (!book) return;
		this.stop();
		book.study = undefined;
		this.total = 0;
		this.schedulePersist();
	}

	/* ── Internals ─────────────────────────────────────────────────────── */

	private async run(token: number): Promise<void> {
		if (this.queue.length) {
			this.phase = 'running';
			const worker = async (): Promise<void> => {
				while (token === this.runToken && this.queue.length) {
					const section = this.queue.shift();
					if (!section) return;
					try {
						const text = await this.summarize(section, token);
						if (token !== this.runToken) return;
						this.applyNode(section, text);
						this.completed += 1;
					} catch (cause) {
						if (token !== this.runToken) return;
						this.applyNode(section, undefined);
						this.failed += 1;
						if (cause instanceof CloudLlmError) this.error = cause.message;
					}
				}
			};
			await Promise.all(
				Array.from({ length: Math.min(CLOUD_CONCURRENCY, this.queue.length) }, worker)
			);
			if (token !== this.runToken) return;
		}
		await this.finishAbstract(token);
		if (token === this.runToken) this.phase = 'idle';
	}

	private async summarize(section: StudySection, token: number): Promise<string> {
		const book = player.book;
		const language = book?.language ?? 'en';
		const messages = studySectionMessages(book?.title ?? '', section, language);
		let text: string;
		try {
			text = await this.generate(messages, SECTION_MAX_TOKENS);
		} catch (cause) {
			// One retry, honoring a server-requested backoff (rate limits).
			if (token !== this.runToken || !(cause instanceof CloudLlmError)) throw cause;
			await delay(Math.min(cause.retryAfterMs ?? 1_500, MAX_RETRY_AFTER_MS));
			if (token !== this.runToken) throw cause;
			text = await this.generate(messages, SECTION_MAX_TOKENS);
		}
		if (looksLikeLanguage(text, language)) return text;
		// Naming the language in the system prompt is not quite enough: the
		// model still drifts on the occasional technical section. Say it again
		// where it carries most weight — last — and check the answer again.
		if (token !== this.runToken) return text;
		const insisted = await this.generate(
			[
				messages[0],
				{
					role: 'user' as const,
					content: `${messages[1].content}\n\nWrite the notes in ${languageName(language)}.`
				}
			],
			SECTION_MAX_TOKENS
		);
		if (looksLikeLanguage(insisted, language)) return insisted;
		// Better an honest gap the reader can rebuild than a note they cannot read.
		throw new CloudLlmError(`The study model answered outside ${languageName(language)}.`);
	}

	private async generate(
		messages: Parameters<typeof generateCloud>[3],
		maxNewTokens: number
	): Promise<string> {
		const engine = providersState.cloudStudyEngine;
		if (!engine) throw new CloudLlmError('No study engine is available.');
		const text = await generateCloud(engine.provider, engine.model, engine.apiKey, messages, {
			maxNewTokens,
			temperature: 0.3,
			timeoutMs: 90_000
		});
		const cleaned = text.replace(/\s+/g, ' ').trim();
		if (!cleaned) throw new CloudLlmError('The study model returned an empty summary.');
		return cleaned;
	}

	/** Replace the node immutably — the drawer and instruction block watch the
	 * study object, and in-place mutation would not reach them. */
	private applyNode(section: StudySection, summary: string | undefined): void {
		const book = player.book;
		if (!book || book.id !== this.documentId || !book.study) return;
		const engine = providersState.cloudStudyEngine;
		const nodes: StudyNode[] = book.study.nodes.map((node) =>
			node.id === section.id
				? {
						...node,
						status: summary ? ('ready' as const) : ('failed' as const),
						...(summary ? { summary } : {}),
						updatedAt: Date.now()
					}
				: node
		);
		book.study = {
			...book.study,
			nodes,
			...(engine ? { modelId: `${engine.provider}:${engine.model}` } : {}),
			updatedAt: Date.now()
		};
		this.schedulePersist();
	}

	private async finishAbstract(token: number): Promise<void> {
		const book = player.book;
		if (!book || book.id !== this.documentId || !book.study) return;
		if (!abstractNeeded(book.study)) return;
		this.phase = 'running';
		try {
			const text = await this.generate(
				studyAbstractMessages(book.title, book.study.nodes, book.language),
				ABSTRACT_MAX_TOKENS
			);
			if (token !== this.runToken || !book.study) return;
			book.study = {
				...book.study,
				abstract: text,
				abstractStatus: 'ready',
				abstractHash: abstractSourceHash(book.study.nodes),
				updatedAt: Date.now()
			};
		} catch (cause) {
			if (token !== this.runToken || !book.study) return;
			book.study = { ...book.study, abstractStatus: 'failed', updatedAt: Date.now() };
			if (cause instanceof CloudLlmError) this.error = cause.message;
		}
		this.schedulePersist();
	}

	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			const book = player.book;
			if (!book || book.id !== this.documentId) return;
			void appState.saveDocument(book).catch(() => undefined);
		}, PERSIST_DEBOUNCE_MS);
	}
}

export const studyState = new StudyState();
