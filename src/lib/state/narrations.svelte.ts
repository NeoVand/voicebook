import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { segmentBlocks, segmentsEqual } from '$lib/domain/segmenter';
import {
	NARRATION_PROMPT_VERSION,
	narrationConstructs,
	reconcileNarrations,
	type NarrationConstruct
} from '$lib/domain/narration';
import { blockPositions, documentContextFor, prioritizeQueue } from '$lib/domain/narration-queue';
import type { NarrationEntry, NormalizedDocument } from '$lib/domain/types';
import {
	NarrationRewriteError,
	rewriteConstruct,
	type NarrationEngine
} from '$lib/services/narration-rewriter';
import { ttsClient } from '$lib/services/tts-client';
import { appState } from './app-state.svelte';
import { llmState } from './llm.svelte';
import { player } from './player.svelte';
import { providersState } from './providers.svelte';

export type NarrationPhase = 'idle' | 'running' | 'paused-gpu' | 'error';

const GPU_POLL_MS = 500;
const ITEM_YIELD_MS = 250;
/** Cloud rewrites are independent HTTP calls with no GPU to share — a small
 * pool cuts whole-document narration time several-fold without hammering the
 * provider. The local engine stays strictly serial. */
const CLOUD_CONCURRENCY = 3;
const MAX_RETRY_AFTER_MS = 15_000;
const REBIND_DEBOUNCE_MS = 400;
const PERSIST_DEBOUNCE_MS = 1_000;
const OOM_RETRY_IDLE_MS = 10_000;
const OOM_PATTERN = /out of memory|memory|allocation|buffer|device.*lost|mapasync/i;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep only the user's pinned edits when clearing narrations in bulk. */
function manualOnly(narrations: Record<string, NarrationEntry>): Record<string, NarrationEntry> {
	const kept: Record<string, NarrationEntry> = {};
	for (const [id, entry] of Object.entries(narrations)) {
		if (entry.origin === 'manual') kept[id] = entry;
	}
	return kept;
}

/**
 * The background narration scheduler: one document at a time, one LLM call at
 * a time, document order with playhead priority. Results mutate
 * player.book.narrations, re-segment the document, and rebind the player —
 * deferring any swap that would touch the live prefetch window while playing.
 */
export class NarrationState {
	phase = $state<NarrationPhase>('idle');
	documentId = $state<string | null>(null);
	/** Constructs queued for this document this session. */
	total = $state(0);
	completed = $state(0);
	failed = $state(0);
	error = $state('');
	/** Constructs being explicitly regenerated right now — their previous text
	 * keeps playing until the replacement lands; the reader panel shows a
	 * transient spinner from this set. */
	regenerating = new SvelteSet<string>();

	private runToken = 0;
	private queue: NarrationConstruct[] = [];
	private playheadBlockId: string | undefined;
	private dirty = false;
	private rebindTimer: ReturnType<typeof setTimeout> | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private settleWaiters: Array<() => void> = [];
	private progressWatchers: Array<(done: number, total: number) => void> = [];
	private oomStrikes = 0;

	constructor() {
		player.ensureNarrationsReady = (onProgress) => this.ensureAll(onProgress);
	}

	get working(): boolean {
		return this.phase === 'running' || this.phase === 'paused-gpu';
	}

	get done(): number {
		return this.completed + this.failed;
	}

	/**
	 * The engine that would generate descriptions right now: the selected
	 * cloud provider when it has a key, otherwise the on-device model when
	 * this device can run it and it is installed. Null when neither can.
	 */
	get engine(): NarrationEngine | null {
		const cloud = providersState.cloudDescriptionEngine;
		if (cloud) return { type: 'cloud', ...cloud };
		if (providersState.descriptionEngine !== 'local') return null;
		return llmState.eligible && llmState.installed ? { type: 'local' } : null;
	}

	get engineAvailable(): boolean {
		return this.engine !== null;
	}

	/** Warm the on-device model when it is the engine; cloud engines are
	 * always "ready" (each call carries the key). */
	private async ensureEngineReady(): Promise<boolean> {
		const engine = this.engine;
		if (!engine) return false;
		if (engine.type === 'cloud') return true;
		return llmState.ensureReadyForNarration();
	}

	/**
	 * Reconcile a freshly opened document and start the background queue.
	 * Call after player.setDocument(document) — results are applied through
	 * player.book so the reader re-renders.
	 */
	async open(document: NormalizedDocument): Promise<void> {
		this.stop();
		this.documentId = document.id;
		this.completed = 0;
		this.failed = 0;
		this.error = '';
		const token = ++this.runToken;

		await Promise.all([llmState.initialize(), providersState.initialize()]);
		const active = llmState.narrationEnabled && this.engineAvailable;

		const book = player.book;
		if (!book || book.id !== document.id || token !== this.runToken) return;

		if (!active) {
			// The feature cannot run: settle any pending entries as failed so
			// fallbacks are final (no eternal pending stripes, no wedged MP3
			// export). They re-queue automatically when narration comes back.
			const entries = Object.values(book.narrations ?? {});
			const pending = entries.filter((entry) => entry.status === 'pending');
			if (pending.length) {
				for (const entry of pending) {
					book.narrations![entry.constructId] = {
						...entry,
						status: 'failed',
						updatedAt: Date.now()
					};
				}
				this.tryRebind();
				this.schedulePersist();
			}
			this.total = 0;
			return;
		}

		const reconciled = reconcileNarrations(
			book.blocks,
			book.narrations ?? {},
			llmState.promptHashes
		);
		if (token !== this.runToken) return;
		book.narrations = reconciled.narrations;
		if (reconciled.changed) {
			this.tryRebind();
			this.schedulePersist();
		}
		this.queue = prioritizeQueue(
			reconciled.queue,
			blockPositions(book.blocks),
			this.playheadBlockId
		);
		this.total = this.queue.length;
		if (!this.queue.length) return;

		const ready = await this.ensureEngineReady();
		if (token !== this.runToken) return;
		if (!ready) {
			this.queue = [];
			this.total = 0;
			return;
		}
		void this.run(token);
	}

	/** Abandon the queue (document closed or switched). The in-flight LLM call
	 * finishes on its own; its result is dropped by the token check. */
	stop(): void {
		this.runToken += 1;
		this.queue = [];
		this.regenerating.clear();
		this.dirty = false;
		if (this.rebindTimer) clearTimeout(this.rebindTimer);
		this.rebindTimer = null;
		if (this.phase !== 'error') this.phase = 'idle';
		this.settle();
	}

	/** Playhead moved: prioritize upcoming constructs and flush deferred swaps. */
	notifyPlayhead(segmentId: string): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const segment = book.segments.find((candidate) => candidate.id === segmentId);
		if (segment) {
			this.playheadBlockId = segment.blockId;
			if (this.queue.length > 1) {
				this.queue = prioritizeQueue(this.queue, blockPositions(book.blocks), segment.blockId);
			}
		}
		if (this.dirty) this.tryRebind();
	}

	/**
	 * Resolve when every queued construct is ready or failed and the segment
	 * rebinds have been applied — generateAll's narration phase.
	 */
	async ensureAll(onProgress?: (done: number, total: number) => void): Promise<void> {
		if (onProgress) {
			this.progressWatchers.push(onProgress);
			onProgress(this.done, this.total);
		}
		try {
			// If no engine can run, settle pending entries as failed so the
			// audio pass and MP3 export proceed over final fallbacks.
			const ready = await this.ensureEngineReady();
			if (!ready) {
				const book = player.book;
				if (book && book.id === this.documentId) {
					const pending = Object.values(book.narrations ?? {}).filter(
						(entry) => entry.status === 'pending'
					);
					for (const entry of pending) {
						book.narrations![entry.constructId] = {
							...entry,
							status: 'failed',
							updatedAt: Date.now()
						};
					}
					this.queue = [];
					this.flushRebind();
					this.schedulePersist();
				}
				return;
			}
			if (!this.queue.length && !this.dirty && !this.working) return;
			await new Promise<void>((resolve) => {
				this.settleWaiters.push(resolve);
			});
		} finally {
			if (onProgress) {
				this.progressWatchers = this.progressWatchers.filter((cb) => cb !== onProgress);
			}
		}
	}

	/** Drop every generated narration in the library (manual edits stay
	 * pinned) and rewrite the open document immediately; other documents
	 * regenerate on their next open. */
	async regenerateAll(): Promise<void> {
		for (const document of appState.documents) {
			if (!document.narrations || !Object.keys(document.narrations).length) continue;
			if (player.book?.id === document.id) continue;
			await appState.saveDocument({
				...document,
				narrations: manualOnly(document.narrations)
			});
		}
		await this.regenerateDocument();
	}

	/** Drop the open document's generated narrations (manual edits stay) and
	 * rewrite it now. */
	async regenerateDocument(): Promise<void> {
		const book = player.book;
		if (!book) return;
		book.narrations = manualOnly(book.narrations ?? {});
		// open() reconciles — constructs re-queue and segments swap once.
		await this.open(book);
	}

	/**
	 * Pin a user-edited description for one construct. Applies (and
	 * invalidates that construct's cached audio) immediately; survives prompt
	 * edits and bulk regeneration until the construct's source changes.
	 */
	async setManualText(constructId: string, text: string): Promise<void> {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const construct = this.constructById(constructId);
		const trimmed = text.replace(/\s+/g, ' ').trim();
		if (!construct || !trimmed) return;
		// An in-flight or queued LLM rewrite must not overwrite the edit.
		this.queue = this.queue.filter((candidate) => candidate.id !== constructId);
		this.regenerating.delete(constructId);
		book.narrations = {
			...(book.narrations ?? {}),
			[constructId]: {
				constructId,
				kind: construct.kind,
				status: 'ready',
				text: trimmed,
				sourceHash: construct.sourceHash,
				promptVersion: NARRATION_PROMPT_VERSION,
				origin: 'manual',
				updatedAt: Date.now()
			}
		};
		this.flushRebind();
		this.schedulePersist();
	}

	/**
	 * Rewrite one construct with the current engine, replacing whatever text
	 * it has (including a manual edit — the button is the explicit consent).
	 * The previous text keeps playing until the replacement lands.
	 */
	async regenerateConstruct(constructId: string): Promise<void> {
		const book = player.book;
		if (!book || book.id !== this.documentId || this.regenerating.has(constructId)) return;
		const construct = this.constructById(constructId);
		if (!construct) return;
		this.regenerating.add(constructId);
		this.queue = [construct, ...this.queue.filter((candidate) => candidate.id !== constructId)];
		if (this.working) {
			this.total += 1;
			return;
		}
		const token = ++this.runToken;
		this.total = this.queue.length;
		this.completed = 0;
		this.failed = 0;
		const ready = await this.ensureEngineReady();
		if (token !== this.runToken) return;
		if (!ready) {
			this.queue = [];
			this.regenerating.delete(constructId);
			this.error = 'No description engine is available right now.';
			return;
		}
		void this.run(token);
	}

	private constructById(id: string): NarrationConstruct | undefined {
		const book = player.book;
		if (!book) return undefined;
		return narrationConstructs(book.blocks).find((candidate) => candidate.id === id);
	}

	/* ── Internals ─────────────────────────────────────────────────────── */

	private notifyProgress(): void {
		for (const watcher of this.progressWatchers) watcher(this.done, this.total);
	}

	private settle(): void {
		const waiters = this.settleWaiters;
		this.settleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private async run(token: number): Promise<void> {
		this.phase = 'running';
		const worker = async (): Promise<void> => {
			while (token === this.runToken && this.queue.length) {
				// Cloud engines never contend with the speech engine for the GPU.
				if (this.engine?.type === 'local') await this.gpuQuiet(token);
				if (token !== this.runToken) return;
				const construct = this.queue.shift();
				if (!construct) return;
				try {
					const text = await this.rewrite(construct, token);
					if (token !== this.runToken) return;
					this.applyResult(construct, text);
					this.completed += 1;
				} catch (error) {
					if (token !== this.runToken) return;
					if (this.isOom(error) && this.engine?.type === 'local') {
						const stopped = await this.handleOom(construct, token);
						if (stopped || token !== this.runToken) return;
						continue;
					}
					this.applyFailure(construct);
					this.failed += 1;
				}
				this.notifyProgress();
				if (this.engine?.type === 'local') await delay(ITEM_YIELD_MS);
			}
		};
		const workers = this.engine?.type === 'cloud' ? CLOUD_CONCURRENCY : 1;
		await Promise.all(Array.from({ length: Math.min(workers, this.queue.length) || 1 }, worker));
		if (token !== this.runToken) return;
		this.phase = 'idle';
		this.flushRebind();
		this.settleWhenClean(token);
	}

	/** ensureAll resolves only after deferred swaps land; while playing they
	 * flush on segment advance, so poll until the dirty flag clears. */
	private settleWhenClean(token: number): void {
		if (token !== this.runToken) return;
		if (!this.dirty) {
			this.settle();
			return;
		}
		this.tryRebind();
		if (!this.dirty) {
			this.settle();
			return;
		}
		setTimeout(() => this.settleWhenClean(token), 1_000);
	}

	/** Cooperative GPU yielding: speech synthesis always wins the next slot.
	 * Steady playback of cached audio does not block narration. */
	private async gpuQuiet(token: number): Promise<void> {
		while (token === this.runToken && (ttsClient.busy || player.isBuffering)) {
			this.phase = 'paused-gpu';
			await delay(GPU_POLL_MS);
		}
		if (token === this.runToken && this.phase === 'paused-gpu') this.phase = 'running';
	}

	private async rewrite(construct: NarrationConstruct, token: number): Promise<string> {
		const book = player.book;
		const engine = this.engine ?? undefined;
		const request = {
			construct,
			documentContext: documentContextFor(book?.blocks ?? [], construct),
			promptOverrides: llmState.activePromptOverrides,
			params: llmState.generationParams[construct.kind],
			engine
		};
		try {
			return await rewriteConstruct(request);
		} catch (error) {
			if (
				token === this.runToken &&
				error instanceof NarrationRewriteError &&
				error.reason === 'generation-failed' &&
				!this.isOom(error)
			) {
				// One transient-error retry: local waits for the GPU to quiet
				// down, cloud backs off for the server-requested interval when
				// one was given (rate limits), briefly otherwise.
				if (engine?.type === 'cloud')
					await delay(Math.min(error.retryAfterMs ?? 1_500, MAX_RETRY_AFTER_MS));
				else await this.gpuQuiet(token);
				if (token !== this.runToken) throw error;
				return await rewriteConstruct(request);
			}
			throw error;
		}
	}

	private isOom(error: unknown): boolean {
		return error instanceof Error && OOM_PATTERN.test(error.message);
	}

	/** Two-strike out-of-memory policy: free the LLM device and retry once
	 * after the player has been idle; a second strike pauses narration for
	 * the session. Returns true when the loop should stop. */
	private async handleOom(construct: NarrationConstruct, token: number): Promise<boolean> {
		this.oomStrikes += 1;
		llmState.unload();
		if (this.oomStrikes >= 2) {
			this.error =
				'Narration paused — this GPU ran out of memory while speech audio was being generated. ' +
				'It will resume the next time you open the document.';
			this.phase = 'error';
			this.queue = [];
			this.settle();
			return true;
		}
		this.queue.unshift(construct);
		await delay(OOM_RETRY_IDLE_MS);
		if (token !== this.runToken) return true;
		const ready = await llmState.ensureReadyForNarration();
		if (!ready || token !== this.runToken) {
			this.phase = 'error';
			this.error = 'The narration model could not be reloaded after a memory error.';
			this.queue = [];
			this.settle();
			return true;
		}
		return false;
	}

	private entryFor(construct: NarrationConstruct, text?: string): NarrationEntry {
		const engine = this.engine;
		return {
			constructId: construct.id,
			kind: construct.kind,
			status: text ? 'ready' : 'failed',
			...(text ? { text } : {}),
			sourceHash: construct.sourceHash,
			modelId:
				engine?.type === 'cloud'
					? `${engine.provider}:${engine.model}`
					: (llmState.activeModelId ?? undefined),
			promptVersion: NARRATION_PROMPT_VERSION,
			promptHash: llmState.promptHashes[construct.kind],
			updatedAt: Date.now()
		};
	}

	private applyResult(construct: NarrationConstruct, text: string): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const existing = book.narrations?.[construct.id];
		const explicit = this.regenerating.delete(construct.id);
		// A manual edit that landed while this rewrite was in flight wins —
		// unless the user explicitly asked for this regeneration.
		if (
			existing?.origin === 'manual' &&
			existing.sourceHash === construct.sourceHash &&
			!explicit
		) {
			return;
		}
		book.narrations = {
			...(book.narrations ?? {}),
			[construct.id]: this.entryFor(construct, text)
		};
		this.scheduleRebind();
		this.schedulePersist();
	}

	private applyFailure(construct: NarrationConstruct): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const existing = book.narrations?.[construct.id];
		this.regenerating.delete(construct.id);
		// An explicit regenerate that fails keeps the previous good text
		// instead of downgrading a ready construct to its fallback.
		if (existing?.status === 'ready' && existing.text) return;
		book.narrations = { ...(book.narrations ?? {}), [construct.id]: this.entryFor(construct) };
		this.scheduleRebind();
		this.schedulePersist();
	}

	private scheduleRebind(): void {
		if (this.rebindTimer) return;
		this.rebindTimer = setTimeout(() => {
			this.rebindTimer = null;
			this.tryRebind();
		}, REBIND_DEBOUNCE_MS);
	}

	private flushRebind(): void {
		if (this.rebindTimer) {
			clearTimeout(this.rebindTimer);
			this.rebindTimer = null;
		}
		this.tryRebind();
	}

	/**
	 * Recompute segments and rebind the player — unless the swap would touch
	 * the live prefetch window (current segment + 3) while playing, which
	 * would discard ready audio and audibly re-buffer. Deferred swaps flush
	 * on the next playhead advance or when playback stops.
	 */
	private tryRebind(): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) {
			this.dirty = false;
			return;
		}
		const next = segmentBlocks(book.blocks, book.includeCode, book.narrations ?? {});
		if (segmentsEqual(book.segments, next)) {
			this.dirty = false;
			return;
		}
		if (player.isPlaying) {
			const nextTextById = new SvelteMap(
				next.map((segment) => [segment.id, segment.normalizedText])
			);
			const windowStart = player.currentSegmentIndex;
			for (
				let index = windowStart;
				index <= windowStart + 3 && index < book.segments.length;
				index += 1
			) {
				const segment = book.segments[index];
				const replacement = nextTextById.get(segment.id);
				if (replacement === undefined || replacement !== segment.normalizedText) {
					this.dirty = true;
					return;
				}
			}
		}
		player.rebindSegments(next);
		this.dirty = false;
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

export const narrationState = new NarrationState();
