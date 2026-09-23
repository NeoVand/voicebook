import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { segmentBlocks, segmentsEqual } from '$lib/domain/segmenter';
import { DEFAULT_LISTENING_MODE, spokenRulesFor } from '$lib/domain/listening-modes';
import {
	NARRATION_PROMPT_VERSION,
	narrationConstructs,
	reconcileNarrations,
	type NarrationConstruct
} from '$lib/domain/narration';
import { breadcrumbFor } from '$lib/domain/document-lens';
import {
	blockPositions,
	blockTimeline,
	constructsInWindow,
	documentContextFor,
	prioritizeQueue
} from '$lib/domain/narration-queue';
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
/** A long document is megabytes of JSON; saving it once per landed
 * description stalled the page. Batches ride this interval, and anything
 * still unsaved is flushed when the document closes or the page hides. */
const PERSIST_DEBOUNCE_MS = 4_000;
/** Listening time described ahead of the playhead and of the passage on
 * screen — far enough that descriptions are ready before the voice gets
 * there, near enough that a long page never queues all of its equations. */
const DESCRIBE_AHEAD_SECONDS = 8 * 60;
const DESCRIBE_BEHIND_SECONDS = 60;
/** Scrolling moves the window only once the reader settles somewhere. */
const VIEWPORT_SETTLE_MS = 300;
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
 * a time (a small pool for cloud engines). Only constructs within listening
 * reach of the reader are described — ahead of the playhead and of the
 * passage on screen — nearest first; the rest wait until the reader gets
 * close or the whole document is prepared on purpose (ensureAll). Results
 * mutate player.book.narrations, re-segment the document, and rebind the
 * player — deferring any swap that would touch the live prefetch window while
 * playing.
 */
export class NarrationState {
	phase = $state<NarrationPhase>('idle');
	documentId = $state<string | null>(null);
	/** Constructs taken into the work queue for this document this session. */
	total = $state(0);
	completed = $state(0);
	failed = $state(0);
	error = $state('');
	/** Constructs being explicitly regenerated right now — their previous text
	 * keeps playing until the replacement lands; the reader panel shows a
	 * transient spinner from this set. */
	regenerating = new SvelteSet<string>();
	/** Constructs queued or being described right now. Pending constructs
	 * outside the window are waiting for the reader, not being worked on, so
	 * the reader pulses only these. */
	active = new SvelteSet<string>();

	private runToken = 0;
	/** The ordered work list: explicit requests, then the window, nearest
	 * first. Rebuilt whenever the reader moves. */
	private queue: NarrationConstruct[] = [];
	/** Every construct that still needs a description, in document order. */
	private backlog = new SvelteMap<string, NarrationConstruct>();
	/** Taken by a worker and not yet finished. */
	private inFlight = new SvelteSet<string>();
	/** Asked for by name (regenerate) — these skip the window. */
	private explicit = new SvelteSet<string>();
	/** Already counted into `total`, so a construct that leaves the window and
	 * comes back is not counted twice. */
	private counted = new SvelteSet<string>();
	/** 'all' once someone needs the whole document (MP3 export, preparing
	 * everything); the window stops applying until the next open. */
	private scope: 'nearby' | 'all' = 'nearby';
	/** The run token whose workers are draining the queue, if any. */
	private activeRun: number | undefined;
	private playheadBlockId: string | undefined;
	private viewportBlockId: string | undefined;
	private viewportTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	private rebindTimer: ReturnType<typeof setTimeout> | null = null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private settleWaiters: Array<() => void> = [];
	private progressWatchers: Array<(done: number, total: number) => void> = [];
	private oomStrikes = 0;

	constructor() {
		player.ensureNarrationsReady = (onProgress) => this.ensureAll(onProgress);
		if (typeof window !== 'undefined') {
			// Batched saves must not be lost to a closed tab or a backgrounded
			// page that the browser later discards.
			window.addEventListener('pagehide', () => this.flushPersist());
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') this.flushPersist();
			});
		}
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
		this.total = 0;
		this.completed = 0;
		this.failed = 0;
		this.error = '';
		// A memory-error pause lasts until the document is opened again.
		if (this.phase === 'error') this.phase = 'idle';
		const token = ++this.runToken;

		await Promise.all([llmState.initialize(), providersState.initialize()]);
		const enabled = llmState.narrationEnabled && this.engineAvailable;

		const book = player.book;
		if (!book || book.id !== document.id || token !== this.runToken) return;

		if (!enabled) {
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
		this.backlog = new SvelteMap(reconciled.queue.map((construct) => [construct.id, construct]));
		// The player has already restored the reading position.
		this.playheadBlockId = player.currentSegment?.blockId;
		this.refreshQueue();
		this.kick();
	}

	/** Abandon the queue (document closed or switched). The in-flight LLM call
	 * finishes on its own; its result is dropped by the token check. */
	stop(): void {
		// Save what already landed before the document reference moves on.
		this.flushPersist();
		this.runToken += 1;
		this.queue = [];
		this.backlog.clear();
		this.inFlight.clear();
		this.explicit.clear();
		this.counted.clear();
		this.active.clear();
		this.scope = 'nearby';
		this.viewportBlockId = undefined;
		if (this.viewportTimer) clearTimeout(this.viewportTimer);
		this.viewportTimer = null;
		this.regenerating.clear();
		this.dirty = false;
		if (this.rebindTimer) clearTimeout(this.rebindTimer);
		this.rebindTimer = null;
		if (this.phase !== 'error') this.phase = 'idle';
		this.settle();
	}

	/** Playhead moved: the window follows it, and deferred swaps flush. */
	notifyPlayhead(segmentId: string): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const segment = book.segments.find((candidate) => candidate.id === segmentId);
		if (segment && segment.blockId !== this.playheadBlockId) {
			this.playheadBlockId = segment.blockId;
			this.refreshQueue();
			this.kick();
		}
		if (this.dirty) this.tryRebind();
	}

	/** The reader scrolled: once they settle, describe what is on screen and
	 * just ahead of it. */
	notifyViewport(blockId: string | undefined): void {
		if (!blockId || blockId === this.viewportBlockId) return;
		this.viewportBlockId = blockId;
		if (this.viewportTimer) clearTimeout(this.viewportTimer);
		this.viewportTimer = setTimeout(() => {
			this.viewportTimer = null;
			const book = player.book;
			if (!book || book.id !== this.documentId) return;
			this.refreshQueue();
			this.kick();
		}, VIEWPORT_SETTLE_MS);
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
					this.backlog.clear();
					this.active.clear();
					this.flushRebind();
					this.schedulePersist();
				}
				return;
			}
			// Everything, not just the window: the caller needs final text for
			// the whole document.
			this.scope = 'all';
			this.refreshQueue();
			this.kick();
			if (!this.backlog.size && !this.dirty && !this.working) return;
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
		this.backlog.delete(constructId);
		this.explicit.delete(constructId);
		this.active.delete(constructId);
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
		// Asked for by name, so it goes first wherever the reader is — and
		// counts toward progress again even if it was described earlier.
		this.backlog.set(constructId, construct);
		this.explicit.add(constructId);
		this.counted.delete(constructId);
		this.refreshQueue();
		const token = this.runToken;
		const ready = await this.ensureEngineReady();
		if (token !== this.runToken) return;
		if (!ready) {
			this.backlog.delete(constructId);
			this.explicit.delete(constructId);
			this.refreshQueue();
			this.regenerating.delete(constructId);
			this.error = 'No description engine is available right now.';
			return;
		}
		this.kick();
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

	/**
	 * Rebuild the work list from the backlog: explicit requests first, then —
	 * nearest first — either the whole document or just the window around the
	 * playhead and the passage on screen.
	 */
	private refreshQueue(): void {
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		const waiting = [...this.backlog.values()].filter(
			(construct) => !this.inFlight.has(construct.id)
		);
		const requested = waiting.filter((construct) => this.explicit.has(construct.id));
		const rest = waiting.filter((construct) => !this.explicit.has(construct.id));
		const nearby =
			this.scope === 'all'
				? prioritizeQueue(
						rest,
						blockPositions(book.blocks),
						this.playheadBlockId ?? this.viewportBlockId
					)
				: constructsInWindow(rest, blockTimeline(book.blocks, book.segments), {
						focusBlockIds: [this.playheadBlockId, this.viewportBlockId].filter(
							(blockId): blockId is string => Boolean(blockId)
						),
						aheadSeconds: DESCRIBE_AHEAD_SECONDS,
						behindSeconds: DESCRIBE_BEHIND_SECONDS
					});
		this.queue = [...requested, ...nearby];
		for (const construct of this.queue) {
			if (this.counted.has(construct.id)) continue;
			this.counted.add(construct.id);
			this.total += 1;
		}
		const working = new SvelteSet([
			...this.queue.map((construct) => construct.id),
			...this.inFlight
		]);
		for (const id of [...this.active]) if (!working.has(id)) this.active.delete(id);
		for (const id of working) this.active.add(id);
	}

	/** Start the workers if there is work and nobody is draining it yet. */
	private kick(): void {
		if (this.phase === 'error' || !this.queue.length) return;
		if (this.activeRun === this.runToken) return;
		void this.run(this.runToken);
	}

	/** A construct is done — described, failed, or replaced by a manual edit. */
	private finish(constructId: string): void {
		this.backlog.delete(constructId);
		this.inFlight.delete(constructId);
		this.explicit.delete(constructId);
		this.active.delete(constructId);
	}

	private async run(token: number): Promise<void> {
		if (this.activeRun === token) return;
		this.activeRun = token;
		/** A second out-of-memory strike paused narration until the next open. */
		let halted = false;
		try {
			// Warm the engine only once there is something to describe — an
			// empty window never loads the on-device model.
			const ready = await this.ensureEngineReady();
			if (token !== this.runToken) return;
			if (!ready) {
				this.queue = [];
				this.active.clear();
				return;
			}
			this.phase = 'running';
			const worker = async (): Promise<void> => {
				while (token === this.runToken) {
					// Cloud engines never contend with the speech engine for the GPU.
					if (this.engine?.type === 'local') await this.gpuQuiet(token);
					if (token !== this.runToken) return;
					const construct = this.queue.shift();
					if (!construct) return;
					this.inFlight.add(construct.id);
					try {
						const text = await this.rewrite(construct, token);
						if (token !== this.runToken) return;
						this.applyResult(construct, text);
						this.completed += 1;
					} catch (error) {
						if (token !== this.runToken) return;
						if (this.isOom(error) && this.engine?.type === 'local') {
							this.inFlight.delete(construct.id);
							const stopped = await this.handleOom(construct, token);
							if (stopped) halted = true;
							if (stopped || token !== this.runToken) return;
							continue;
						}
						this.applyFailure(construct);
						this.failed += 1;
					}
					this.finish(construct.id);
					this.notifyProgress();
					if (this.engine?.type === 'local') await delay(ITEM_YIELD_MS);
				}
			};
			// The window can grow while the pool drains (the reader moved on);
			// keep going until it is empty for good.
			while (token === this.runToken && this.queue.length) {
				const workers = this.engine?.type === 'cloud' ? CLOUD_CONCURRENCY : 1;
				await Promise.all(Array.from({ length: Math.min(workers, this.queue.length) }, worker));
			}
		} finally {
			if (this.activeRun === token) this.activeRun = undefined;
		}
		if (token !== this.runToken) return;
		// Finishing the loop must not paper over that pause.
		if (!halted) this.phase = 'idle';
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
		// Cloud models handle — and reward — a wider view: three times the
		// surrounding prose plus where the construct sits in the document.
		// The on-device model keeps its tight, tuned windows.
		const cloud = engine?.type === 'cloud';
		const surrounding = documentContextFor(
			book?.blocks ?? [],
			construct,
			cloud ? { before: 700, after: 500 } : {}
		);
		const documentContext =
			cloud && book
				? [`This sits under: ${breadcrumbFor(book, construct.blockId)}.`, surrounding]
						.filter(Boolean)
						.join(' ')
				: surrounding;
		const request = {
			construct,
			documentContext,
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
		const next = segmentBlocks(
			book.blocks,
			book.includeCode,
			book.narrations ?? {},
			spokenRulesFor(book.listeningMode ?? DEFAULT_LISTENING_MODE)
		);
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

	/** Save a pending batch now (document closing, page hiding). */
	private flushPersist(): void {
		if (!this.persistTimer) return;
		clearTimeout(this.persistTimer);
		this.persistTimer = null;
		const book = player.book;
		if (!book || book.id !== this.documentId) return;
		void appState.saveDocument(book).catch(() => undefined);
	}
}

export const narrationState = new NarrationState();
