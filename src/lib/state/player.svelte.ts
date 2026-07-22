import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getModel } from '$lib/domain/model-catalog';
import type {
	AudioVariantMeta,
	ListeningMode,
	NormalizedDocument,
	SpeechSegment,
	TimingMap
} from '$lib/domain/types';
import { audioVariantKey, decodeAudio, encodeAudio } from '$lib/services/audio-codec';
import { segmentBlocks, segmentsEqual } from '$lib/domain/segmenter';
import { backMatterAnnouncement } from '$lib/domain/back-matter';
import {
	DEFAULT_LISTENING_MODE,
	isListeningMode,
	skipsBackMatter,
	spokenRulesFor
} from '$lib/domain/listening-modes';
import { applySpokenStyle, VERBATIM_SPOKEN_RULES } from '$lib/domain/spoken-style';
import {
	deleteAudioForSegments,
	getAudio,
	listAudioVariants,
	putAudio
} from '$lib/services/repository';
import { encodeDocumentMp3, mp3Filename } from '$lib/services/mp3-export';
import { ttsClient, type SynthesisResult } from '$lib/services/tts-client';
import { synthesizeElevenLabs } from '$lib/services/elevenlabs';
import { ELEVENLABS_MODELS } from '$lib/domain/provider-catalog';
import { generationPlan } from '$lib/services/generation-plan';
import {
	absoluteTimelinePosition,
	listenedDuration,
	locateTimelinePosition,
	mergeListenedRange,
	timelineDuration,
	timelineProgress
} from '$lib/services/timeline';
import { appState } from './app-state.svelte';
import { providersState } from './providers.svelte';

/** The parameters that identify one speech engine configuration — used for
 * cache keys, variant matching, and stored-audio metadata. */
interface SpeechVariant {
	modelId: string;
	repository: string;
	revision: string;
	voiceId: string;
	backend: 'webgpu' | 'wasm' | 'cloud';
	dtype: string;
}

interface PreparedAudio {
	key: string;
	buffer: AudioBuffer;
	timing: TimingMap;
}

interface GeneratedSegment {
	audio: Float32Array;
	sampleRate: number;
	meta: Omit<AudioVariantMeta, 'mimeType'>;
	signal: AbortSignal;
	version: number;
}

interface ActiveSynthesis {
	controller: AbortController;
	purpose: 'playback' | 'document';
}

function isQuotaError(error: unknown): boolean {
	return (
		(error instanceof DOMException &&
			(error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')) ||
		(error instanceof Error && /quota|storage.*full|no space/i.test(error.message))
	);
}

export interface TimelineSegmentVisual {
	id: string;
	left: number;
	width: number;
	cached: boolean;
	generating: number;
	/** An LLM narration rewrite is still expected for this segment. */
	narrationPending: boolean;
	/** Citation apparatus that natural playback skips — shown muted on the rail. */
	backMatter: boolean;
	listened: Array<{ left: number; width: number }>;
}

export class VoicebookPlayer {
	book = $state<NormalizedDocument | null>(null);
	isPlaying = $state(false);
	isBuffering = $state(false);
	bufferingStage = $state('Preparing this passage…');
	isGeneratingAll = $state(false);
	generationProgress = $state(0);
	/** Progress label while generateAll waits for narration rewrites. */
	narrationStage = $state('');
	currentSegmentIndex = $state(0);
	currentWordIndex = $state(0);
	position = $state(0);
	currentDuration = $state(0);
	rate = $state(1);
	volume = $state(0.9);
	autoFollow = $state(true);
	errorMessage = $state('');
	/** One-time notice that generated audio can no longer be saved (quota).
	 * Cleared by the user or when a document closes. */
	storageWarning = $state('');
	engineBackend = $state<'webgpu' | 'wasm' | 'cloud' | undefined>();
	engineDtype = $state('');
	lastSynthesisMs = $state<number | undefined>();
	lastRealtimeFactor = $state<number | undefined>();
	lastPassageChars = $state(0);
	/** The sleep-timer option in minutes (null = off). Cycled by the UI. */
	sleepTimerMinutes = $state<number | null>(null);
	/** Epoch ms when the sleep timer pauses playback; null when off. */
	sleepTimerEndsAt = $state<number | null>(null);
	/** An ad-hoc spoken answer (the Explain flow) is being voiced. */
	asideActive = $state(false);

	private context?: AudioContext;
	private wakeLock: WakeLockSentinel | null = null;
	private visibilityHandler?: () => void;
	private gain?: GainNode;
	private soundTouch?: SoundTouchNode;
	private soundTouchRegistration?: Promise<void>;
	private soundTouchUnavailable = false;
	private source?: AudioBufferSourceNode;
	private sourceStartedAt = 0;
	private sourceOffset = 0;
	/** Structural silence to leave before the next segment's audio, set only
	 * when advancing by natural playback (never on a manual jump or resume). */
	private pendingLeadSilence = 0;
	/** Bumped by any playback transition so an in-flight back-matter skip
	 * announcement knows the user (or a media-key) took over and must not
	 * resume on top of it. */
	private skipToken = 0;
	/** When true, natural playback announces and skips back-matter sections
	 * (references, notes). Manual navigation always plays them regardless.
	 * Reactive: the transport rail's muted band reads it through a getter, and a
	 * segmentsEqual short-circuit can change it without reassigning segments. */
	skipBackMatter = $state(true);
	private manualStop = false;
	private frame = 0;
	private lastUiFrameAt = 0;
	private lastMediaUpdateAt = 0;
	private requestedWordIndex?: number;
	/** Playback stops after this segment/word when set (selection reading). */
	private playThrough?: { segmentIndex: number; wordIndex: number };
	private asideSource?: AudioBufferSourceNode;
	private asideAbort?: AbortController;
	private audioCache = new SvelteMap<string, PreparedAudio>();
	private preparedBySegment = new SvelteMap<number, PreparedAudio>();
	private queue = new SvelteMap<number, Promise<PreparedAudio>>();
	private cacheQueue = new SvelteMap<number, Promise<void>>();
	private persistenceBySegment = new SvelteMap<number, Promise<boolean>>();
	private cachedSegments = new SvelteSet<number>();
	private generationBySegment = new SvelteMap<number, number>();
	private hasCachedAudioVariants = $state(false);
	private abortControllers = new SvelteMap<number, ActiveSynthesis>();
	private lastSavedAt = 0;
	private cancellationVersion = 0;
	private prefetchVersion = 0;
	private engineLoad?: { modelId: string; promise: Promise<void> };
	private cacheCoverageSignature = '';
	onSegmentChange?: (segmentId: string) => void;
	/** Assigned by the narration state module (mirrors onSegmentChange to
	 * avoid an import cycle): resolves when every construct is ready or
	 * failed AND the resulting segment rebinds have been applied. */
	ensureNarrationsReady?: (onProgress: (done: number, total: number) => void) => Promise<void>;

	get currentSegment(): SpeechSegment | undefined {
		return this.book?.segments[this.currentSegmentIndex];
	}

	get progress(): number {
		return timelineProgress(this.timelineDurations(), this.currentSegmentIndex, this.position);
	}

	get totalDuration(): number {
		return timelineDuration(this.timelineDurations());
	}

	get cachedProgress(): number {
		const durations = this.timelineDurations();
		const total = timelineDuration(durations);
		if (!total) return 0;
		return (
			durations.reduce(
				(sum, duration, index) => sum + (this.cachedSegments.has(index) ? duration : 0),
				0
			) / total
		);
	}

	get listenedProgress(): number {
		const durations = this.timelineDurations();
		const total = timelineDuration(durations);
		if (!total || !this.book) return 0;
		return (
			this.book.segments.reduce(
				(sum, segment, index) =>
					sum + listenedDuration(this.book?.listened?.[segment.id] ?? [], durations[index] ?? 0),
				0
			) / total
		);
	}

	get timelineSegments(): TimelineSegmentVisual[] {
		if (!this.book) return [];
		const durations = this.timelineDurations();
		const total = timelineDuration(durations);
		if (!total) return [];
		let elapsed = 0;
		return this.book.segments.map((segment, index) => {
			const duration = durations[index] ?? 0;
			const left = elapsed / total;
			elapsed += duration;
			return {
				id: segment.id,
				left,
				width: duration / total,
				cached: this.cachedSegments.has(index),
				generating: this.generationBySegment.get(index) ?? 0,
				narrationPending: segment.narration?.pending ?? false,
				backMatter: this.skipBackMatter && segment.role === 'back-matter',
				listened: mergeListenedRange(this.book?.listened?.[segment.id] ?? [], 0, 0).map(
					(range) => ({
						left: duration ? Math.min(1, range.start / duration) : 0,
						width: duration
							? Math.max(0, Math.min(duration, range.end) - Math.min(duration, range.start)) /
								duration
							: 0
					})
				)
			};
		});
	}

	get timelineSummary(): string {
		const cached = Math.round(this.cachedProgress * 100);
		const listened = Math.round(this.listenedProgress * 100);
		const generating = this.generationBySegment.size;
		return `${cached}% audio cached for this voice. ${listened}% listened.${generating ? ` Preparing ${generating} ${generating === 1 ? 'passage' : 'passages'}.` : ''}`;
	}

	get hasPendingNarrations(): boolean {
		return Boolean(this.book?.segments.some((segment) => segment.narration?.pending));
	}

	get isDocumentPrepared(): boolean {
		return (
			Boolean(this.book?.segments.length) &&
			this.cachedProgress >= 0.9999 &&
			// Pending narrations will change spoken text and re-generate audio;
			// 'failed' entries lock in the fallback and do not hold this gate.
			!this.hasPendingNarrations
		);
	}

	get hasDocumentAudioState(): boolean {
		return (
			this.hasCachedAudioVariants ||
			this.audioCache.size > 0 ||
			this.listenedProgress > 0 ||
			this.generationBySegment.size > 0
		);
	}

	/** True when ElevenLabs is the active speech engine. */
	private get usesElevenLabs(): boolean {
		return providersState.speechEngine === 'elevenlabs';
	}

	/** The active engine configuration for cache keys and variant matching. */
	private speechVariant(): SpeechVariant {
		if (this.usesElevenLabs) {
			return {
				modelId: 'elevenlabs',
				repository: 'elevenlabs',
				revision: providersState.elevenLabsModelId,
				voiceId: providersState.elevenLabsVoiceId,
				backend: 'cloud',
				dtype: 'pcm24'
			};
		}
		const model = appState.selectedModel;
		return {
			modelId: model.id,
			repository: model.repository,
			revision: model.revision,
			voiceId: appState.selectedVoiceId,
			backend: this.engineBackend ?? ttsClient.backend,
			dtype: this.engineDtype || ttsClient.dtype
		};
	}

	get runtimeLabel(): string {
		if (this.usesElevenLabs) {
			const model = ELEVENLABS_MODELS.find(
				(candidate) => candidate.id === providersState.elevenLabsModelId
			);
			return `ElevenLabs · ${model?.label ?? providersState.elevenLabsModelId}`;
		}
		if (!this.engineBackend) return 'Engine warming';
		return `${this.engineBackend === 'webgpu' ? 'WebGPU' : 'WASM'} · ${this.engineDtype}`;
	}

	get runtimeDetail(): string {
		if (this.lastSynthesisMs === undefined || this.lastRealtimeFactor === undefined)
			return this.runtimeLabel;
		return `${this.runtimeLabel}; last passage: ${this.lastPassageChars} characters in ${(this.lastSynthesisMs / 1_000).toFixed(2)} seconds (${this.lastRealtimeFactor.toFixed(2)}× real-time factor)`;
	}

	setDocument(document: NormalizedDocument): void {
		this.stopPlayback(false);
		this.cancellationVersion += 1;
		this.reprioritize();
		ttsClient.cancelAll();
		this.audioCache.clear();
		this.preparedBySegment.clear();
		this.cacheQueue.clear();
		this.persistenceBySegment.clear();
		this.cachedSegments.clear();
		this.generationBySegment.clear();
		this.hasCachedAudioVariants = false;
		this.cacheCoverageSignature = '';
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.requestedWordIndex = undefined;
		this.book = document;
		this.skipBackMatter = skipsBackMatter(document.listeningMode ?? DEFAULT_LISTENING_MODE);
		const savedIndex = document.playback
			? document.segments.findIndex((segment) => segment.id === document.playback?.segmentId)
			: -1;
		this.currentSegmentIndex = Math.max(0, savedIndex);
		this.currentWordIndex = document.playback?.wordIndex ?? 0;
		this.position = document.playback?.offset ?? 0;
		this.currentDuration = document.segments[this.currentSegmentIndex]?.estimatedDuration ?? 0;
		this.errorMessage = '';
		this.storageWarning = '';
		this.configureMediaSession();
		this.notifySegmentChange();
	}

	dismissStorageWarning(): void {
		this.storageWarning = '';
	}

	private notifySegmentChange(): void {
		if (this.currentSegment) this.onSegmentChange?.(this.currentSegment.id);
	}

	/**
	 * Swap in a freshly computed segment list after narration rewrites arrive.
	 * Indices shift, so every index-keyed structure is remapped by segment id;
	 * cached flags survive only where the spoken text is unchanged (the audio
	 * cache key embeds the text, so changed segments are genuinely uncached).
	 * The currently playing buffer is never interrupted — callers apply the
	 * swap policy (never rebind the live prefetch window while playing).
	 */
	rebindSegments(next: SpeechSegment[]): void {
		if (!this.book) return;
		const previous = this.book.segments;
		if (segmentsEqual(previous, next)) return;
		const currentId = this.currentSegment?.id;
		const nextIndexById = new SvelteMap(next.map((segment, index) => [segment.id, index]));

		// Stop prefetch/synthesis work aimed at old indices; keep document-wide
		// generation (generateAll) requests alive — their persistence path
		// re-resolves indices by id.
		this.reprioritize(this.isGeneratingAll);

		// Segments whose spoken text changed (or that disappeared) have only
		// stale audio variants; purge them and rebuild coverage afterwards.
		const changedIds: string[] = [];
		const nextById = new SvelteMap(next.map((segment) => [segment.id, segment]));
		for (const segment of previous) {
			const replacement = nextById.get(segment.id);
			if (!replacement || replacement.normalizedText !== segment.normalizedText) {
				changedIds.push(segment.id);
			}
		}

		const previousCached = [...this.cachedSegments];
		this.cachedSegments.clear();
		for (const index of previousCached) {
			const old = previous[index];
			if (!old) continue;
			const newIndex = nextIndexById.get(old.id);
			if (newIndex === undefined) continue;
			if (next[newIndex].normalizedText === old.normalizedText) this.cachedSegments.add(newIndex);
		}

		// Keep only the current segment's decoded audio (remapped); everything
		// else re-hydrates from IndexedDB on the next prefetch.
		const keptPrepared =
			currentId !== undefined ? this.preparedBySegment.get(this.currentSegmentIndex) : undefined;
		this.preparedBySegment.clear();
		this.audioCache.clear();
		this.generationBySegment.clear();

		this.book.segments = next;
		const remappedIndex = currentId !== undefined ? nextIndexById.get(currentId) : undefined;
		const currentTextUnchanged =
			currentId !== undefined &&
			remappedIndex !== undefined &&
			previous[this.currentSegmentIndex]?.normalizedText === next[remappedIndex].normalizedText;
		this.currentSegmentIndex =
			remappedIndex ?? Math.max(0, Math.min(this.currentSegmentIndex, next.length - 1));
		if (keptPrepared && currentTextUnchanged && remappedIndex !== undefined) {
			this.preparedBySegment.set(remappedIndex, keptPrepared);
			this.audioCache.set(keptPrepared.key, keptPrepared);
		} else if (!this.isPlaying) {
			// The passage under the playhead was rewritten while idle: restart
			// it from the top with the new narration on the next play.
			this.position = 0;
			this.currentWordIndex = 0;
			this.currentDuration =
				this.book.segments[this.currentSegmentIndex]?.estimatedDuration ?? this.currentDuration;
		}

		void deleteAudioForSegments(this.book.id, changedIds)
			.catch(() => undefined)
			.then(() => this.refreshCacheCoverage(true))
			.then(() => {
				this.generationProgress = this.cachedProgress * 100;
			})
			.catch(() => undefined);

		if (this.isPlaying) this.prefetch();
	}

	/** The open document's effective listening mode. Validated on read: the
	 * persisted field is untrusted, and the command bar renders it directly. */
	get listeningMode(): ListeningMode {
		const mode = this.book?.listeningMode;
		return isListeningMode(mode) ? mode : DEFAULT_LISTENING_MODE;
	}

	/**
	 * Switch how the open document is spoken. A mode change rewrites the spoken
	 * text of essentially every passage, so — like a voice or rate change — it
	 * stops playback, re-segments with the mode's rules, and restarts the
	 * current passage in the new voice-text if it was playing. Restarting (vs a
	 * live rebindSegments) avoids a frozen highlight and a mid-passage
	 * re-buffer, and keeps the current segment's word timing correct.
	 */
	async setListeningMode(mode: ListeningMode): Promise<void> {
		const book = this.book;
		if (!book || book.listeningMode === mode) return;
		// isPlaying only flips true after synthesis and the audio-output unlock —
		// a multi-second window on cold start. Treat that buffering window as
		// active too, so a second mode change (the picker's onChange isn't
		// awaited) pauses and restarts rather than rebinding underneath the first.
		const wasActive = this.isPlaying || this.isBuffering;
		if (wasActive) this.pause();
		book.listeningMode = mode;
		this.skipBackMatter = skipsBackMatter(mode);
		const next = segmentBlocks(
			book.blocks,
			book.includeCode,
			book.narrations ?? {},
			spokenRulesFor(mode)
		);
		this.rebindSegments(next);
		await appState.saveDocument(book).catch(() => undefined);
		// The save is an IndexedDB round-trip; the user may have opened another
		// document in the meantime. Never resume playback on top of it.
		if (wasActive && this.book === book) await this.play();
	}

	private reprioritize(preserveDocumentPreparation = false): void {
		this.prefetchVersion += 1;
		for (const [index, active] of this.abortControllers) {
			if (preserveDocumentPreparation && active.purpose === 'document') continue;
			active.controller.abort();
			this.abortControllers.delete(index);
		}
		this.queue.clear();
	}

	private variantSignature(): string {
		const variant = this.speechVariant();
		return [
			this.book?.id ?? '',
			variant.modelId,
			variant.revision,
			variant.voiceId,
			// Generation steps only shape the on-device engine's output.
			this.usesElevenLabs ? '' : appState.generationSteps,
			variant.backend,
			variant.dtype
		].join('\u001f');
	}

	private matchesCurrentVariant(meta: AudioVariantMeta): boolean {
		const variant = this.speechVariant();
		return (
			meta.modelId === variant.modelId &&
			meta.modelRevision === variant.revision &&
			meta.voiceId === variant.voiceId &&
			(this.usesElevenLabs || meta.generationSteps === appState.generationSteps) &&
			meta.backend === (this.usesElevenLabs ? 'cloud' : this.engineBackend) &&
			meta.dtype === variant.dtype
		);
	}

	private async refreshCacheCoverage(force = false): Promise<void> {
		if (!this.book || !this.engineBackend || !this.engineDtype) return;
		const signature = this.variantSignature();
		if (!force && signature === this.cacheCoverageSignature) return;
		const documentId = this.book.id;
		const variants = await listAudioVariants(documentId);
		if (!this.book || this.book.id !== documentId || signature !== this.variantSignature()) return;
		this.hasCachedAudioVariants = variants.length > 0;
		this.cachedSegments.clear();
		const indexes = new SvelteMap(this.book.segments.map((segment, index) => [segment.id, index]));
		for (const variant of variants) {
			if (!this.matchesCurrentVariant(variant)) continue;
			const index = indexes.get(variant.segmentId);
			if (index !== undefined) this.cachedSegments.add(index);
		}
		this.cacheCoverageSignature = signature;
		this.generationProgress = this.cachedProgress * 100;
	}

	private async audioGraph(): Promise<AudioContext> {
		if (!this.context) {
			this.context = new AudioContext({ latencyHint: 'playback' });
			this.gain = this.context.createGain();
			this.gain.gain.value = this.volume;
			this.gain.connect(this.context.destination);
		}
		// Start the unlock while transient click activation is still available, but do
		// not make model loading wait on browsers that keep AudioContext suspended.
		if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
		if (this.rate !== 1) await this.ensureSoundTouch(this.context);
		return this.context;
	}

	private async requireAudioOutput(context: AudioContext): Promise<void> {
		if (context.state === 'running') return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				context.resume(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() =>
							reject(
								new Error('The browser did not unlock audio output. Press Play again to retry.')
							),
						5_000
					);
				})
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async ensureSoundTouch(context: AudioContext): Promise<void> {
		if (this.soundTouch || this.soundTouchUnavailable) return;
		this.soundTouchRegistration ??= (async () => {
			await SoundTouchNode.register(context, processorUrl);
			this.soundTouch = new SoundTouchNode({ context, outputChannelCount: 1 });
			this.soundTouch.pitch.value = 1;
			this.soundTouch.playbackRate.value = this.rate;
			this.soundTouch.connect(this.gain!);
		})();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.soundTouchRegistration,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('Tempo processing did not initialize in time.')),
						3_000
					);
				})
			]);
		} catch {
			this.soundTouchUnavailable = true;
			this.soundTouch = undefined;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async ensureEngine(): Promise<void> {
		if (this.usesElevenLabs) {
			await providersState.initialize();
			if (!providersState.elevenLabsReady) {
				throw new Error(
					'Add your ElevenLabs API key under Settings → Voice, or switch back to the on-device voice.'
				);
			}
			this.engineBackend = 'cloud';
			this.engineDtype = 'pcm24';
			await this.refreshCacheCoverage();
			return;
		}
		const modelId = appState.selectedModelId;
		if (!appState.installedModels.includes(modelId))
			throw new Error(`Install ${getModel(modelId).name} before playing.`);
		if (ttsClient.modelId === modelId) {
			this.engineBackend = ttsClient.backend;
			this.engineDtype = ttsClient.dtype;
			await this.refreshCacheCoverage();
			return;
		}
		if (!this.engineLoad || this.engineLoad.modelId !== modelId) {
			this.bufferingStage = `Opening ${getModel(modelId).name}…`;
			const promise = appState.installModel(modelId, 'auto', (update) => {
				const file = update.file?.split('/').at(-1);
				this.bufferingStage = file
					? `${update.status === 'progress' ? 'Downloading' : 'Loading'} ${file} · ${Math.round(update.progress)}%`
					: update.status;
			});
			this.engineLoad = { modelId, promise };
		}
		const load = this.engineLoad;
		try {
			await load.promise;
		} finally {
			if (this.engineLoad === load) this.engineLoad = undefined;
		}
		this.engineBackend = ttsClient.backend;
		this.engineDtype = ttsClient.dtype;
		await this.refreshCacheCoverage();
	}

	async warmEngine(): Promise<void> {
		if (!this.book) return;
		if (!this.usesElevenLabs && !appState.installedModels.includes(appState.selectedModelId))
			return;
		try {
			await this.ensureEngine();
		} catch {
			// Playback presents the actionable error if the background warm-up fails.
		}
	}

	private async cacheKey(segment: SpeechSegment): Promise<string> {
		const variant = this.speechVariant();
		return audioVariantKey([
			this.book?.fingerprint ?? '',
			segment.id,
			segment.normalizedText,
			variant.repository,
			variant.revision,
			variant.voiceId,
			variant.backend,
			variant.dtype,
			`generation-steps:${this.usesElevenLabs ? 0 : appState.generationSteps}`,
			'generate-speed:1'
		]);
	}

	private async prepareAudio(index: number): Promise<PreparedAudio> {
		if (!this.book) throw new Error('No document is open.');
		const segment = this.book.segments[index];
		if (!segment) throw new Error('This reading position no longer exists.');
		await this.ensureEngine();
		this.bufferingStage = 'Opening audio output…';
		const context = await this.audioGraph();
		this.bufferingStage = 'Checking saved audio…';
		const key = await this.cacheKey(segment);
		const memory = this.audioCache.get(key);
		if (memory) {
			this.preparedBySegment.set(index, memory);
			this.prunePreparedAudio(this.currentSegmentIndex);
			return memory;
		}
		const stored = await getAudio(key);
		if (stored) {
			this.bufferingStage = 'Opening saved audio…';
			const prepared = {
				key,
				buffer: await decodeAudio(context, stored.blob),
				timing: stored.meta.timing
			};
			this.audioCache.set(key, prepared);
			this.preparedBySegment.set(index, prepared);
			this.cachedSegments.add(index);
			this.prunePreparedAudio(this.currentSegmentIndex);
			return prepared;
		}
		this.cachedSegments.delete(index);
		const generated = await this.synthesizeSegment(index, key);
		this.bufferingStage = 'Starting playback…';
		const buffer = context.createBuffer(1, generated.audio.length, generated.sampleRate);
		buffer.getChannelData(0).set(generated.audio);
		const prepared = { key, buffer, timing: generated.meta.timing };
		this.audioCache.set(key, prepared);
		this.preparedBySegment.set(index, prepared);
		this.prunePreparedAudio(this.currentSegmentIndex);
		void this.trackPersistence(index, generated);
		return prepared;
	}

	private async synthesizeSegment(
		index: number,
		key: string,
		keepGenerationVisible = false,
		purpose: ActiveSynthesis['purpose'] = 'playback'
	): Promise<GeneratedSegment> {
		if (!this.book) throw new Error('No document is open.');
		const segment = this.book.segments[index];
		if (!segment) throw new Error('This reading position no longer exists.');
		const documentId = this.book.id;
		const variant = this.speechVariant();
		const controller = new AbortController();
		const version = this.cancellationVersion;
		let completed = false;
		this.abortControllers.set(index, { controller, purpose });
		this.generationBySegment.set(index, 0.02);
		try {
			this.bufferingStage = this.usesElevenLabs
				? 'Requesting audio from ElevenLabs…'
				: `Generating “${segment.normalizedText.slice(0, 48)}${segment.normalizedText.length > 48 ? '…' : ''}”`;
			let generated: SynthesisResult;
			if (this.usesElevenLabs) {
				this.generationBySegment.set(index, 0.25);
				generated = await synthesizeElevenLabs({
					apiKey: providersState.keyFor('elevenlabs') ?? '',
					voiceId: variant.voiceId,
					modelId: variant.revision,
					text: segment.normalizedText,
					signal: controller.signal
				});
			} else {
				generated = await ttsClient.synthesize(
					segment.normalizedText,
					variant.voiceId,
					controller.signal,
					(update) => {
						this.bufferingStage = update.status;
						this.generationBySegment.set(index, Math.max(0.02, update.progress / 100));
					},
					appState.generationSteps
				);
			}
			if (controller.signal.aborted)
				throw new DOMException('Speech generation was canceled.', 'AbortError');
			this.lastSynthesisMs = generated.metrics.elapsedMs;
			this.lastRealtimeFactor = generated.metrics.audioDuration
				? generated.metrics.elapsedMs / 1_000 / generated.metrics.audioDuration
				: undefined;
			this.lastPassageChars = segment.normalizedText.length;
			completed = true;
			return {
				audio: generated.audio,
				sampleRate: generated.sampleRate,
				meta: {
					key,
					documentId,
					segmentId: segment.id,
					modelId: variant.modelId,
					modelRevision: variant.revision,
					voiceId: variant.voiceId,
					generationSteps: this.usesElevenLabs ? 0 : appState.generationSteps,
					backend: variant.backend,
					dtype: variant.dtype,
					duration: generated.audio.length / generated.sampleRate,
					timing: generated.timing,
					createdAt: Date.now()
				},
				signal: controller.signal,
				version
			};
		} finally {
			if (this.abortControllers.get(index)?.controller === controller)
				this.abortControllers.delete(index);
			if (!keepGenerationVisible || !completed) this.generationBySegment.delete(index);
		}
	}

	private async persistGeneratedAudio(
		meta: Omit<AudioVariantMeta, 'mimeType'>,
		audio: Float32Array,
		sampleRate: number,
		signal: AbortSignal,
		version: number
	): Promise<boolean> {
		try {
			// Let the playback queue dispatch the next inference request before a
			// synchronous WAV fallback starts walking the generated PCM on Safari.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const encoded = await encodeAudio(audio, sampleRate);
			if (signal.aborted || version !== this.cancellationVersion) return false;
			await putAudio({ ...meta, mimeType: encoded.mimeType }, encoded.blob);
			return true;
		} catch (error) {
			// Persistence is an optimization; generated PCM must remain playable even
			// if encoding or browser storage is temporarily unavailable. Storage
			// exhaustion still must not stay invisible — everything generated from
			// here on would quietly regenerate on every future listen.
			if (isQuotaError(error) && !this.storageWarning) {
				this.storageWarning =
					'This device is out of storage space, so newly generated audio is not being saved. ' +
					'Playback continues, but these passages will regenerate next time. ' +
					'Free up space or clear generated audio under Settings → System.';
				void appState.refreshStorage().catch(() => undefined);
			}
			return false;
		}
	}

	private trackPersistence(index: number, generated: GeneratedSegment): Promise<boolean> {
		const generatedText = this.book?.segments[index]?.normalizedText;
		const task = this.persistGeneratedAudio(
			generated.meta,
			generated.audio,
			generated.sampleRate,
			generated.signal,
			generated.version
		)
			.then((saved) => {
				if (
					saved &&
					this.book?.id === generated.meta.documentId &&
					this.matchesCurrentVariant({ ...generated.meta, mimeType: '' })
				) {
					// Resolve the index at completion time by segment id — a
					// narration rebind may have shifted indices (or swapped the
					// spoken text, making this variant stale) mid-flight.
					const finalIndex = this.book.segments.findIndex(
						(segment) => segment.id === generated.meta.segmentId
					);
					if (finalIndex >= 0 && this.book.segments[finalIndex].normalizedText === generatedText) {
						this.cachedSegments.add(finalIndex);
					}
				}
				if (saved) this.hasCachedAudioVariants = true;
				this.generationProgress = this.cachedProgress * 100;
				return saved;
			})
			.finally(() => {
				if (this.persistenceBySegment.get(index) === task) this.persistenceBySegment.delete(index);
			});
		this.persistenceBySegment.set(index, task);
		return task;
	}

	private prunePreparedAudio(center: number): void {
		const radius = 3;
		for (const [index, prepared] of this.preparedBySegment) {
			if (Math.abs(index - center) <= radius) continue;
			this.preparedBySegment.delete(index);
			this.audioCache.delete(prepared.key);
		}
	}

	private async cacheSegment(index: number): Promise<void> {
		if (!this.book || this.cachedSegments.has(index)) return;
		const playbackRequest = this.queue.get(index);
		if (playbackRequest) {
			await playbackRequest;
			await this.persistenceBySegment.get(index);
			if (this.cachedSegments.has(index)) return;
			throw new Error('Voicebook generated a passage but could not save it on this device.');
		}
		// Claim the passage before model loading and storage lookup. This keeps the
		// timeline informative even when preparation first has to warm the engine.
		this.generationBySegment.set(index, 0.02);
		try {
			await this.ensureEngine();
			if (this.cachedSegments.has(index)) return;
			const segment = this.book.segments[index];
			if (!segment) return;
			const key = await this.cacheKey(segment);
			if (await getAudio(key)) {
				this.cachedSegments.add(index);
				this.generationProgress = this.cachedProgress * 100;
				return;
			}
			const generated = await this.synthesizeSegment(index, key, true, 'document');
			this.generationBySegment.set(index, 1);
			if (!(await this.trackPersistence(index, generated)))
				throw new Error('Voicebook generated a passage but could not save it on this device.');
		} finally {
			this.generationBySegment.delete(index);
		}
	}

	private queuedCache(index: number): Promise<void> {
		const existing = this.cacheQueue.get(index);
		if (existing) return existing;
		const request = this.cacheSegment(index).finally(() => {
			if (this.cacheQueue.get(index) === request) this.cacheQueue.delete(index);
		});
		this.cacheQueue.set(index, request);
		return request;
	}

	private queuedAudio(index: number): Promise<PreparedAudio> {
		const existing = this.queue.get(index);
		if (existing) return existing;
		const cacheRequest = this.cacheQueue.get(index);
		const request = (
			cacheRequest ? cacheRequest.then(() => this.prepareAudio(index)) : this.prepareAudio(index)
		).finally(() => {
			if (this.queue.get(index) === request) this.queue.delete(index);
		});
		this.queue.set(index, request);
		return request;
	}

	private prefetch(): void {
		if (!this.book) return;
		const documentId = this.book.id;
		const version = this.prefetchVersion;
		const upcoming = generationPlan(this.book.segments.length, this.currentSegmentIndex, 3).slice(
			1
		);
		if (this.usesElevenLabs) {
			// Cloud synthesis has no GPU to share — request the whole buffer
			// window as independent HTTP calls instead of one at a time.
			for (const index of upcoming) {
				if (index <= this.currentSegmentIndex) continue;
				void this.queuedAudio(index).catch(() => undefined);
			}
			return;
		}
		void (async () => {
			// Keep inference serialized, but fill a real rolling buffer in narration
			// order. Each result becomes playable before its storage encoding finishes.
			for (const index of upcoming) {
				if (
					version !== this.prefetchVersion ||
					this.book?.id !== documentId ||
					index <= this.currentSegmentIndex
				)
					return;
				await this.queuedAudio(index);
			}
		})().catch(() => undefined);
	}

	async play(): Promise<void> {
		if (!this.book || !this.currentSegment) return;
		if (this.isPlaying) return;
		// stopAside bumps skipToken, so an in-flight back-matter announcement sees
		// this Play (including a media key) as the user taking over.
		this.stopAside();
		// Consume the structural pause up front so it can't leak onto a later
		// manual start if synthesis throws before playback begins. Only a fresh
		// passage start (position 0) gets the beat — never a mid-passage resume.
		const leadSilence = this.position === 0 ? this.pendingLeadSilence : 0;
		this.pendingLeadSilence = 0;
		this.errorMessage = '';
		this.isBuffering = true;
		this.bufferingStage = 'Preparing this passage…';
		const version = this.cancellationVersion;
		try {
			// Unlock the browser audio device synchronously from the user's Play gesture.
			// Model loading can outlive transient user activation, so doing this later can
			// leave perfectly generated audio inaudible.
			this.bufferingStage = 'Opening audio output…';
			const context = await this.audioGraph();
			const prepared = await this.queuedAudio(this.currentSegmentIndex);
			// Queue the next passage before waiting for iOS audio output to resume.
			// That unlock can be noticeably slower than the desktop path.
			this.prefetch();
			this.bufferingStage = 'Starting audio output…';
			await this.requireAudioOutput(context);
			this.currentDuration = prepared.buffer.duration;
			if (this.requestedWordIndex !== undefined) {
				const requestedWordIndex = Math.max(
					0,
					Math.min(this.requestedWordIndex, Math.max(0, this.currentSegment.words.length - 1))
				);
				const timedWord = prepared.timing.words[requestedWordIndex];
				const estimatedOffset =
					(prepared.buffer.duration * requestedWordIndex) /
					Math.max(1, this.currentSegment.words.length);
				this.position = Math.min(
					timedWord?.start ?? estimatedOffset,
					Math.max(0, prepared.buffer.duration - 0.02)
				);
				this.currentWordIndex = requestedWordIndex;
				this.requestedWordIndex = undefined;
			} else {
				this.position = Math.min(this.position, Math.max(0, prepared.buffer.duration - 0.02));
			}
			this.manualStop = false;
			const source = context.createBufferSource();
			source.buffer = prepared.buffer;
			// Keep the normal path as small and dependable as possible. The tempo worklet
			// is only useful away from 1× and can otherwise prevent audible output on
			// browsers that successfully construct it but fail while processing.
			source.playbackRate.value = this.rate;
			if (this.soundTouch && this.rate !== 1) {
				this.soundTouch.playbackRate.value = this.rate;
				source.connect(this.soundTouch);
			} else {
				source.connect(this.gain!);
			}
			source.onended = () => {
				if (this.source === source && !this.manualStop) void this.advanceAfterEnd();
			};
			this.source = source;
			// A structural pause is silence scheduled BEFORE the audio: start the
			// buffer in the future and anchor the clock there, so the gap plays as
			// real quiet. (leadSilence was captured at the top of play().)
			const startAt = context.currentTime + leadSilence;
			this.sourceStartedAt = startAt;
			this.sourceOffset = this.position;
			source.start(startAt, this.position);
			this.isPlaying = true;
			this.lastUiFrameAt = 0;
			void this.acquireWakeLock();
			this.tick(performance.now());
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
		} catch (error) {
			if (
				version === this.cancellationVersion &&
				!(error instanceof DOMException && error.name === 'AbortError')
			)
				this.errorMessage = error instanceof Error ? error.message : 'Playback could not start.';
		} finally {
			if (version === this.cancellationVersion) this.isBuffering = false;
		}
	}

	cancelGeneration(): void {
		this.cancellationVersion += 1;
		this.reprioritize();
		ttsClient.cancelAll();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = this.cachedProgress * 100;
		this.generationBySegment.clear();
		this.cacheQueue.clear();
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
	}

	private async advanceAfterEnd(): Promise<void> {
		this.isPlaying = false;
		if (this.playThrough && this.currentSegmentIndex >= this.playThrough.segmentIndex) {
			// A selection reading reached its boundary: park at the end of the
			// passage instead of rolling into the rest of the document.
			this.playThrough = undefined;
			this.position = this.currentDuration;
			this.releaseWakeLock();
			await this.persistPosition(true);
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
			return;
		}
		if (!this.book || this.currentSegmentIndex >= this.book.segments.length - 1) {
			this.currentSegmentIndex = Math.max(
				0,
				this.book?.segments.length ? this.book.segments.length - 1 : 0
			);
			// The document finished: park the playhead at the very end instead
			// of rewinding to the last passage's start.
			this.position = this.currentDuration;
			this.releaseWakeLock();
			await this.persistPosition(true);
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
			return;
		}
		this.position = 0;
		this.currentSegmentIndex += 1;
		this.currentWordIndex = 0;
		// Crossing into a references/notes section during natural playback:
		// announce it once and skip past, the way a narrator would.
		if (this.skipBackMatter && this.enteringBackMatter(this.currentSegmentIndex)) {
			await this.announceAndSkipBackMatter();
			return;
		}
		// Leave a human beat before this passage — only reached here by natural
		// playback, so manual jumps and clicks stay instant.
		this.pendingLeadSilence = this.currentSegment?.pauseBefore ?? 0;
		this.notifySegmentChange();
		await this.play();
	}

	/** True when `index` is the first segment of a back-matter section — its
	 * predecessor is ordinary text. Manual jumps never route through here. */
	private enteringBackMatter(index: number): boolean {
		const segments = this.book?.segments;
		if (!segments || segments[index]?.role !== 'back-matter') return false;
		return segments[index - 1]?.role !== 'back-matter';
	}

	/** First segment at or after `index` that is not back matter, or undefined
	 * when the rest of the document is back matter. */
	private firstNonBackMatter(index: number): number | undefined {
		const segments = this.book?.segments ?? [];
		for (let cursor = index; cursor < segments.length; cursor += 1) {
			if (segments[cursor].role !== 'back-matter') return cursor;
		}
		return undefined;
	}

	private async announceAndSkipBackMatter(): Promise<void> {
		const startId = this.currentSegment?.id;
		const heading = this.backMatterHeadingLabel();
		const bookId = this.book?.id;
		// Capture the resume target by id, not index: an aside is not "playing",
		// so a narration rebind is free to replace segments while the announcement
		// speaks, and rebindSegments neither bumps skipToken nor changes the book
		// id — only a captured index would silently point at the wrong segment.
		const resumeStart = this.firstNonBackMatter(this.currentSegmentIndex);
		const resumeId = resumeStart === undefined ? undefined : this.book?.segments[resumeStart]?.id;
		// Any playback transition during the announcement (Play — including a
		// media key — pause, stop, Escape, an Explain request, or a document
		// switch) bumps skipToken; if it changed, the user took over and we must
		// not resume on top of them.
		const token = ++this.skipToken;
		await this.speakAside(backMatterAnnouncement(heading));
		if (
			token !== this.skipToken ||
			this.book?.id !== bookId ||
			this.currentSegment?.id !== startId
		) {
			return;
		}
		if (resumeId === undefined) {
			// Nothing but back matter remains: stop at its heading so the reader
			// can still see and scroll it.
			this.isPlaying = false;
			this.notifySegmentChange();
			this.releaseWakeLock();
			await this.persistPosition(true);
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
			return;
		}
		const resumeIndex = this.book?.segments.findIndex((segment) => segment.id === resumeId) ?? -1;
		if (resumeIndex < 0) return; // the resume target was dropped by a rebind
		this.currentSegmentIndex = resumeIndex;
		this.position = 0;
		this.currentWordIndex = 0;
		this.pendingLeadSilence = this.currentSegment?.pauseBefore ?? 0;
		this.notifySegmentChange();
		await this.play();
	}

	/** The label for the skip notice: the current back-matter heading, or — when
	 * the heading block produced no speech segment — the nearest heading above
	 * the playhead. Never the first bibliography entry (the old fallback, which
	 * read a citation aloud as the section name). */
	private backMatterHeadingLabel(): string {
		const blocks = this.book?.blocks ?? [];
		const index = blocks.findIndex((block) => block.id === this.currentSegment?.blockId);
		const current = index >= 0 ? blocks[index] : undefined;
		if (current?.kind === 'heading') return current.text;
		for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
			if (blocks[cursor].kind === 'heading') return blocks[cursor].text;
		}
		return 'references';
	}

	private stopPlayback(persistPosition: boolean): void {
		if (this.isPlaying && persistPosition) this.updateClock();
		this.playThrough = undefined;
		this.manualStop = true;
		// A stop/pause/switch also silences any skip announcement in flight and
		// invalidates its pending resume (stopAside bumps skipToken); a queued
		// structural pause is dropped.
		this.stopAside();
		this.pendingLeadSilence = 0;
		try {
			this.source?.stop();
		} catch {
			// An already-ended source cannot be stopped twice.
		}
		this.source?.disconnect();
		this.source = undefined;
		this.isPlaying = false;
		cancelAnimationFrame(this.frame);
		this.releaseWakeLock();
		if (persistPosition) void this.persistPosition(true);
		if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
	}

	/** Keep the screen awake while reading aloud — read-along highlighting is
	 * useless behind a lock screen, and mediaSession alone does not prevent
	 * the display from sleeping mid-listen. Best effort by design. */
	private async acquireWakeLock(): Promise<void> {
		if (!('wakeLock' in navigator)) return;
		this.visibilityHandler ??= (() => {
			// Browsers release wake locks when the tab hides; re-acquire when
			// the reader comes back while still playing.
			const handler = () => {
				if (document.visibilityState === 'visible' && this.isPlaying) void this.acquireWakeLock();
			};
			document.addEventListener('visibilitychange', handler);
			return handler;
		})();
		if (this.wakeLock) return;
		try {
			const sentinel = await navigator.wakeLock.request('screen');
			this.wakeLock = sentinel;
			sentinel.addEventListener('release', () => {
				if (this.wakeLock === sentinel) this.wakeLock = null;
			});
		} catch {
			// Denied in power-save mode or hidden tabs; playback continues.
			this.wakeLock = null;
		}
	}

	private releaseWakeLock(): void {
		void this.wakeLock?.release().catch(() => undefined);
		this.wakeLock = null;
	}

	/** Cycle the sleep timer through Off → 15 → 30 → 60 minutes → Off, in the
	 * same spirit as the app's other quick pickers. */
	cycleSleepTimer(): void {
		const options: Array<number | null> = [null, 15, 30, 60];
		const next = options[(options.indexOf(this.sleepTimerMinutes) + 1) % options.length];
		this.sleepTimerMinutes = next;
		this.sleepTimerEndsAt = next === null ? null : Date.now() + next * 60_000;
	}

	get sleepTimerRemainingMs(): number | null {
		return this.sleepTimerEndsAt === null ? null : Math.max(0, this.sleepTimerEndsAt - Date.now());
	}

	pause(): void {
		this.stopPlayback(true);
	}

	async toggle(): Promise<void> {
		if (this.isPlaying) this.pause();
		else await this.play();
	}

	/**
	 * Voice an ad-hoc answer (the Explain flow) with the current speech engine
	 * and voice, outside the document's segment/cache pipeline: nothing is
	 * persisted, no highlight moves, and the reading position stays put.
	 * Resolves when the answer has finished playing.
	 */
	async speakAside(text: string): Promise<void> {
		// Asides (spoken Explain answers, skip announcements) are read as
		// written — only URLs collapse to a spoken pointer. The document's
		// listening mode must NOT elide citations or expand abbreviations here:
		// the model already phrased the answer for a listener.
		const spoken = applySpokenStyle(text.trim(), VERBATIM_SPOKEN_RULES).spoken;
		if (!spoken) return;
		// clearAside, not stopAside: this pre-clear must not bump skipToken, or a
		// back-matter announcement would invalidate its own pending resume.
		this.clearAside();
		if (this.isPlaying) this.pause();
		const controller = new AbortController();
		this.asideAbort = controller;
		this.asideActive = true;
		try {
			const context = await this.audioGraph();
			await this.ensureEngine();
			if (controller.signal.aborted) return;
			const variant = this.speechVariant();
			let generated: SynthesisResult;
			if (this.usesElevenLabs) {
				generated = await synthesizeElevenLabs({
					apiKey: providersState.keyFor('elevenlabs') ?? '',
					voiceId: variant.voiceId,
					modelId: variant.revision,
					text: spoken,
					signal: controller.signal
				});
			} else {
				generated = await ttsClient.synthesize(
					spoken,
					variant.voiceId,
					controller.signal,
					undefined,
					appState.generationSteps
				);
			}
			if (controller.signal.aborted) return;
			await this.requireAudioOutput(context);
			if (controller.signal.aborted) return;
			const buffer = context.createBuffer(1, generated.audio.length, generated.sampleRate);
			buffer.getChannelData(0).set(generated.audio);
			await new Promise<void>((resolve) => {
				const source = context.createBufferSource();
				source.buffer = buffer;
				source.playbackRate.value = this.rate;
				if (this.soundTouch && this.rate !== 1) {
					this.soundTouch.playbackRate.value = this.rate;
					source.connect(this.soundTouch);
				} else {
					source.connect(this.gain!);
				}
				// Stopping must always release the awaiting caller, even if the
				// browser skips onended for a stopped suspended-context source.
				source.onended = () => resolve();
				controller.signal.addEventListener('abort', () => resolve(), { once: true });
				this.asideSource = source;
				source.start(0);
			});
		} catch (error) {
			// The box that started this answer is gone by now — the player's
			// error strip is the surface that can still tell the user.
			if (
				!controller.signal.aborted &&
				!(error instanceof DOMException && error.name === 'AbortError')
			) {
				this.errorMessage =
					error instanceof Error ? error.message : 'The spoken answer could not be played.';
			}
		} finally {
			this.asideSource = undefined;
			if (this.asideAbort === controller) {
				this.asideAbort = undefined;
				this.asideActive = false;
			}
		}
	}

	/** Cut short an in-flight or speaking aside. Safe to call when idle.
	 *
	 * Bumps skipToken so a back-matter skip that is awaiting its announcement
	 * treats this as the user taking over: Escape, an Explain request, or closing
	 * the explain box must not let document playback resume on top of them.
	 * speakAside's own pre-clear uses clearAside() instead, so setting up the
	 * announcement never invalidates the token it just captured. */
	stopAside(): void {
		this.skipToken += 1;
		this.clearAside();
	}

	/** Tear down the aside audio graph without touching skipToken. */
	private clearAside(): void {
		this.asideAbort?.abort();
		this.asideAbort = undefined;
		try {
			this.asideSource?.stop();
		} catch {
			// An already-ended source cannot be stopped twice.
		}
		this.asideSource?.disconnect();
		this.asideSource = undefined;
		this.asideActive = false;
	}

	private updateClock(now = performance.now()): void {
		if (!this.context || !this.isPlaying) return;
		if (this.sleepTimerEndsAt !== null && Date.now() >= this.sleepTimerEndsAt) {
			// Clear before pausing: pause() re-enters updateClock to persist.
			this.sleepTimerMinutes = null;
			this.sleepTimerEndsAt = null;
			this.pause();
			return;
		}
		const previousPosition = this.position;
		// Clamp to >= 0: during a scheduled lead silence the source has not
		// begun (currentTime < sourceStartedAt), which would otherwise compute a
		// negative position and persist a bogus offset.
		const nextPosition = Math.max(
			0,
			Math.min(
				this.currentDuration,
				this.sourceOffset + (this.context.currentTime - this.sourceStartedAt) * this.rate
			)
		);
		this.markListened(this.currentSegmentIndex, previousPosition, nextPosition);
		this.position = nextPosition;
		const timing = this.currentTiming();
		if (timing) {
			const index = timing.words.findLastIndex((word) => word.start <= this.position);
			const nextWordIndex = Math.max(0, index);
			if (nextWordIndex !== this.currentWordIndex) this.currentWordIndex = nextWordIndex;
		}
		if (
			this.playThrough &&
			this.currentSegmentIndex === this.playThrough.segmentIndex &&
			this.currentWordIndex > this.playThrough.wordIndex
		) {
			// Clear before pausing: pause() re-enters updateClock to persist.
			this.playThrough = undefined;
			this.pause();
			return;
		}
		if (now - this.lastMediaUpdateAt >= 1_000) {
			this.lastMediaUpdateAt = now;
			this.updateMediaPosition();
		}
		void this.persistPosition(false);
	}

	private markListened(index: number, start: number, end: number): void {
		if (!this.book || end <= start) return;
		const segment = this.book.segments[index];
		if (!segment) return;
		this.book.listened ??= {};
		this.book.listened[segment.id] = mergeListenedRange(
			this.book.listened[segment.id] ?? [],
			start,
			end
		);
	}

	private tick = (now: number): void => {
		if (!this.isPlaying) return;
		// Audio is scheduled by Web Audio and remains sample-accurate. Updating the
		// document tree at 20 fps is ample for word highlighting and avoids making a
		// large Markdown document compete with WebGPU on every animation frame.
		if (now - this.lastUiFrameAt >= 50) {
			this.lastUiFrameAt = now;
			this.updateClock(now);
		}
		this.frame = requestAnimationFrame(this.tick);
	};

	private currentTiming(): TimingMap | undefined {
		return this.preparedBySegment.get(this.currentSegmentIndex)?.timing;
	}

	private timelineDurations(): number[] {
		return (
			this.book?.segments.map((segment, index) =>
				index === this.currentSegmentIndex && this.currentDuration
					? this.currentDuration
					: segment.estimatedDuration
			) ?? []
		);
	}

	async seekBy(seconds: number): Promise<void> {
		if (!this.book) return;
		const wasPlaying = this.isPlaying;
		this.pause();
		this.reprioritize(this.isGeneratingAll);
		const durations = this.timelineDurations();
		const absolute =
			absoluteTimelinePosition(durations, this.currentSegmentIndex, this.position) + seconds;
		const target = locateTimelinePosition(durations, absolute);
		this.currentSegmentIndex = target.index;
		this.position = target.offset;
		this.currentWordIndex = 0;
		this.requestedWordIndex = undefined;
		this.notifySegmentChange();
		if (wasPlaying) await this.play();
		else await this.persistPosition(true);
	}

	async seekToProgress(value: number): Promise<void> {
		const target = Math.max(0, Math.min(1, value)) * this.totalDuration;
		const current = this.progress * this.totalDuration;
		await this.seekBy(target - current);
	}

	/** Start narration at a position; with `stopAfter` set, stop again once the
	 * word at that boundary has been spoken (reading a text selection). */
	async playFromSegment(
		index: number,
		wordIndex = 0,
		stopAfter?: { segmentIndex: number; wordIndex: number }
	): Promise<void> {
		if (!this.book) return;
		this.stopPlayback(false);
		this.cancellationVersion += 1;
		this.reprioritize();
		ttsClient.cancelAll();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';

		this.currentSegmentIndex = Math.max(0, Math.min(index, this.book.segments.length - 1));
		const segment = this.currentSegment;
		this.currentWordIndex = Math.max(
			0,
			Math.min(wordIndex, Math.max(0, (segment?.words.length ?? 1) - 1))
		);
		this.requestedWordIndex = this.currentWordIndex;
		this.position = 0;
		// After stopPlayback cleared any previous boundary; segments before the
		// start (or boundary words past the segment's end) mean "play to the
		// segment's natural end".
		this.playThrough =
			stopAfter && stopAfter.segmentIndex >= this.currentSegmentIndex ? stopAfter : undefined;
		this.notifySegmentChange();
		await this.persistPosition(true);
		await this.play();
	}

	async goToSegment(index: number, offset = 0): Promise<void> {
		if (!this.book) return;
		const wasPlaying = this.isPlaying;
		this.pause();
		this.reprioritize(this.isGeneratingAll);
		this.currentSegmentIndex = Math.max(0, Math.min(index, this.book.segments.length - 1));
		this.position = offset;
		this.currentWordIndex = 0;
		this.requestedWordIndex = undefined;
		this.notifySegmentChange();
		if (wasPlaying) await this.play();
		else await this.persistPosition(true);
	}

	async setRate(value: number): Promise<void> {
		const next = Math.max(0.5, Math.min(3, value));
		const wasPlaying = this.isPlaying;
		if (wasPlaying) this.pause();
		this.rate = next;
		if (wasPlaying) await this.play();
	}

	setVolume(value: number): void {
		this.volume = Math.max(0, Math.min(1, value));
		if (this.gain) this.gain.gain.value = this.volume;
	}

	async chooseVoice(id: string): Promise<void> {
		this.stopPlayback(false);
		const hadPendingSynthesis = this.isBuffering || this.isGeneratingAll || this.queue.size > 0;
		this.cancellationVersion += 1;
		this.reprioritize();
		if (hadPendingSynthesis) ttsClient.cancelAll();
		this.audioCache.clear();
		this.preparedBySegment.clear();
		this.cacheQueue.clear();
		this.generationBySegment.clear();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
		if (this.usesElevenLabs) await providersState.setElevenLabsVoice(id);
		else await appState.selectVoice(id);
		this.cacheCoverageSignature = '';
		this.cachedSegments.clear();
		await this.refreshCacheCoverage(true);
	}

	/** Switch between the on-device voice engine and ElevenLabs. Cached audio
	 * for either engine stays on disk — coverage simply re-resolves against
	 * the new variant. */
	async chooseSpeechEngine(engine: 'local' | 'elevenlabs'): Promise<void> {
		if (engine === providersState.speechEngine) return;
		this.stopPlayback(false);
		const hadPendingSynthesis = this.isBuffering || this.isGeneratingAll || this.queue.size > 0;
		this.cancellationVersion += 1;
		this.reprioritize();
		if (hadPendingSynthesis) ttsClient.cancelAll();
		this.audioCache.clear();
		this.preparedBySegment.clear();
		this.cacheQueue.clear();
		this.generationBySegment.clear();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
		await providersState.setSpeechEngine(engine);
		this.engineBackend = undefined;
		this.engineDtype = '';
		this.cacheCoverageSignature = '';
		this.cachedSegments.clear();
		await this.warmEngine();
	}

	async chooseGenerationSteps(value: number): Promise<void> {
		if (value === appState.generationSteps) return;
		this.stopPlayback(false);
		const hadPendingSynthesis = this.isBuffering || this.isGeneratingAll || this.queue.size > 0;
		this.cancellationVersion += 1;
		this.reprioritize();
		if (hadPendingSynthesis) ttsClient.cancelAll();
		this.audioCache.clear();
		this.preparedBySegment.clear();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.generationBySegment.clear();
		this.cacheQueue.clear();
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
		await appState.setGenerationSteps(value);
		this.cacheCoverageSignature = '';
		this.cachedSegments.clear();
		await this.refreshCacheCoverage(true);
	}

	async generateAll(): Promise<void> {
		if (!this.book || this.isGeneratingAll || this.isDocumentPrepared) return;
		this.isGeneratingAll = true;
		this.errorMessage = '';
		const version = this.cancellationVersion;
		try {
			// Settle narration rewrites first so the audio pass runs over final
			// spoken text instead of fallbacks that would be invalidated later.
			if (this.ensureNarrationsReady && this.hasPendingNarrations) {
				this.narrationStage = 'Rewriting visuals for speech…';
				try {
					await this.ensureNarrationsReady((done, total) => {
						this.narrationStage = `Rewriting visuals ${done}/${total}…`;
					});
				} finally {
					this.narrationStage = '';
				}
				if (version !== this.cancellationVersion) return;
			}
			this.generationProgress = this.cachedProgress * 100;
			const active = new SvelteSet<number>();
			const nextIndex = (): number | undefined =>
				generationPlan(this.book?.segments.length ?? 0, this.currentSegmentIndex, 3, true).find(
					(index) =>
						!this.cachedSegments.has(index) && !active.has(index) && !this.cacheQueue.has(index)
				);
			// Local inference is serialized by the worker anyway; ElevenLabs
			// segments are independent HTTP calls, so a small pool runs them
			// concurrently. The first failure stops every runner.
			const concurrency = this.usesElevenLabs ? 3 : 1;
			let firstError: unknown;
			let stopped = false;
			const runner = async (): Promise<void> => {
				while (!stopped && version === this.cancellationVersion) {
					const index = nextIndex();
					if (index === undefined) return;
					active.add(index);
					try {
						await this.queuedCache(index);
					} catch (error) {
						stopped = true;
						firstError ??= error;
						return;
					} finally {
						active.delete(index);
					}
					this.generationProgress = this.cachedProgress * 100;
				}
			};
			await Promise.all(Array.from({ length: concurrency }, runner));
			if (firstError) throw firstError;
			await appState.refreshStorage();
		} catch (error) {
			if (
				version === this.cancellationVersion &&
				!(error instanceof DOMException && error.name === 'AbortError')
			)
				this.errorMessage =
					error instanceof Error ? error.message : 'The full document could not be generated.';
		} finally {
			if (version === this.cancellationVersion) {
				this.isGeneratingAll = false;
				this.generationProgress = this.cachedProgress * 100;
			}
		}
	}

	async clearDocumentAudio(): Promise<boolean> {
		if (!this.book) return false;
		const document = this.book;
		const pending = [
			...this.queue.values(),
			...this.cacheQueue.values(),
			...this.persistenceBySegment.values()
		];
		const hadPendingSynthesis =
			this.isBuffering ||
			this.isGeneratingAll ||
			this.abortControllers.size > 0 ||
			this.queue.size > 0 ||
			this.cacheQueue.size > 0;
		this.stopPlayback(false);
		this.cancellationVersion += 1;
		this.reprioritize();
		// Clearing already-saved audio should not unload an idle model. Keeping the
		// engine warm makes preparing again immediate; active work is still canceled.
		if (hadPendingSynthesis) ttsClient.cancelAll();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationBySegment.clear();
		this.cacheQueue.clear();
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';

		try {
			await Promise.allSettled(pending);
			await appState.clearAudio(document.id);
			this.audioCache.clear();
			this.preparedBySegment.clear();
			this.persistenceBySegment.clear();
			this.cachedSegments.clear();
			this.hasCachedAudioVariants = false;
			this.cacheCoverageSignature = '';
			this.generationProgress = 0;
			document.listened = {};
			await appState.saveDocument(document);
			return true;
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : 'Cached audio could not be cleared.';
			await this.refreshCacheCoverage(true);
			return false;
		}
	}

	async exportDocumentMp3(
		onProgress?: (progress: number) => void
	): Promise<{ blob: Blob; filename: string }> {
		if (!this.book) throw new Error('No document is open.');
		if (!this.isDocumentPrepared)
			throw new Error('Prepare the whole document before downloading its MP3.');

		const document = this.book;
		const variants = await listAudioVariants(document.id);
		const currentVariants = new SvelteMap(
			variants
				.filter((variant) => this.matchesCurrentVariant(variant))
				.map((variant) => [variant.segmentId, variant])
		);
		const parts = document.segments.map((segment) => {
			const variant = currentVariants.get(segment.id);
			if (!variant)
				throw new Error(
					'Some prepared passages are missing. Prepare the document again to repair it.'
				);
			return {
				load: async () => {
					const stored = await getAudio(variant.key);
					if (!stored)
						throw new Error(
							'Some prepared passages are missing. Prepare the document again to repair it.'
						);
					return stored.blob;
				}
			};
		});
		const context = await this.audioGraph();
		const blob = await encodeDocumentMp3({
			title: document.title,
			parts,
			context,
			onProgress
		});
		return { blob, filename: mp3Filename(document.title) };
	}

	private async persistPosition(force: boolean): Promise<void> {
		if (!this.book || !this.currentSegment) return;
		if (!force && Date.now() - this.lastSavedAt < 1200) return;
		this.lastSavedAt = Date.now();
		this.book.playback = {
			segmentId: this.currentSegment.id,
			wordIndex: this.currentWordIndex,
			offset: this.position,
			updatedAt: Date.now()
		};
		try {
			await appState.savePlayback(this.book);
		} catch {
			// Position saves are best-effort: a failed write (quota pressure,
			// private-mode eviction) must never interrupt playback. Storage
			// trouble is surfaced by the audio persistence path instead.
		}
	}

	private configureMediaSession(): void {
		if (!this.book || !('mediaSession' in navigator)) return;
		navigator.mediaSession.metadata = new MediaMetadata({
			title: this.book.title,
			artist: 'Voicebook',
			album: 'Local library'
		});
		navigator.mediaSession.setActionHandler('play', () => void this.play());
		navigator.mediaSession.setActionHandler('pause', () => this.pause());
		navigator.mediaSession.setActionHandler(
			'seekbackward',
			(details) => void this.seekBy(-(details.seekOffset ?? 10))
		);
		navigator.mediaSession.setActionHandler(
			'seekforward',
			(details) => void this.seekBy(details.seekOffset ?? 10)
		);
		navigator.mediaSession.setActionHandler('seekto', (details) => {
			if (typeof details.seekTime === 'number')
				void this.seekToProgress(details.seekTime / this.totalDuration);
		});
	}

	private updateMediaPosition(): void {
		if (
			!('mediaSession' in navigator) ||
			!this.totalDuration ||
			!Number.isFinite(this.totalDuration)
		)
			return;
		try {
			navigator.mediaSession.setPositionState({
				duration: this.totalDuration,
				playbackRate: this.rate,
				position: Math.min(this.totalDuration, this.progress * this.totalDuration)
			});
		} catch {
			// Browsers may reject transient states while changing tracks.
		}
	}
}

export const player = new VoicebookPlayer();
