import { SvelteMap } from 'svelte/reactivity';
import { segmentBlocks, segmentsEqual } from '$lib/domain/segmenter';
import {
	NARRATION_PROMPT_VERSION,
	reconcileNarrations,
	type NarrationConstruct
} from '$lib/domain/narration';
import { blockPositions, documentContextFor, prioritizeQueue } from '$lib/domain/narration-queue';
import type { NarrationEntry, NormalizedDocument } from '$lib/domain/types';
import { NarrationRewriteError, rewriteConstruct } from '$lib/services/narration-rewriter';
import { ttsClient } from '$lib/services/tts-client';
import { appState } from './app-state.svelte';
import { llmState } from './llm.svelte';
import { player } from './player.svelte';

export type NarrationPhase = 'idle' | 'running' | 'paused-gpu' | 'error';

const GPU_POLL_MS = 500;
const ITEM_YIELD_MS = 250;
const REBIND_DEBOUNCE_MS = 400;
const PERSIST_DEBOUNCE_MS = 1_000;
const OOM_RETRY_IDLE_MS = 10_000;
const OOM_PATTERN = /out of memory|memory|allocation|buffer|device.*lost|mapasync/i;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

		await llmState.initialize();
		const active = llmState.eligible && llmState.narrationEnabled && llmState.installed;

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

		const ready = await llmState.ensureReadyForNarration();
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
			// If the model cannot run, settle pending entries as failed so the
			// audio pass and MP3 export proceed over final fallbacks.
			const ready = await llmState.ensureReadyForNarration();
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

	/** Drop every stored narration in the library and rewrite the open
	 * document immediately; other documents regenerate on their next open. */
	async regenerateAll(): Promise<void> {
		for (const document of appState.documents) {
			if (!document.narrations || !Object.keys(document.narrations).length) continue;
			if (player.book?.id === document.id) continue;
			await appState.saveDocument({ ...document, narrations: {} });
		}
		const book = player.book;
		if (book) {
			book.narrations = {};
			this.flushRebind();
			await this.open(book);
		}
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
		while (token === this.runToken && this.queue.length) {
			await this.gpuQuiet(token);
			if (token !== this.runToken) return;
			const construct = this.queue.shift()!;
			try {
				const text = await this.rewrite(construct, token);
				if (token !== this.runToken) return;
				this.applyResult(construct, text);
				this.completed += 1;
			} catch (error) {
				if (token !== this.runToken) return;
				if (this.isOom(error)) {
					const stopped = await this.handleOom(construct, token);
					if (stopped || token !== this.runToken) return;
					continue;
				}
				this.applyFailure(construct);
				this.failed += 1;
			}
			this.notifyProgress();
			await delay(ITEM_YIELD_MS);
		}
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
		const request = {
			construct,
			documentContext: documentContextFor(book?.blocks ?? [], construct),
			promptOverrides: llmState.promptOverrides
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
				// One transient-error retry after the GPU quiets down.
				await this.gpuQuiet(token);
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
		return {
			constructId: construct.id,
			kind: construct.kind,
			status: text ? 'ready' : 'failed',
			...(text ? { text } : {}),
			sourceHash: construct.sourceHash,
			modelId: llmState.activeModelId ?? undefined,
			promptVersion: NARRATION_PROMPT_VERSION,
			promptHash: llmState.promptHashes[construct.kind],
			updatedAt: Date.now()
		};
	}

	private applyResult(construct: NarrationConstruct, text: string): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
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
