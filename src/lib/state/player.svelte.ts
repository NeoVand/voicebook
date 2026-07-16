import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { getModel } from '$lib/domain/model-catalog';
import type {
	AudioVariantMeta,
	Bookmark,
	NormalizedDocument,
	SpeechSegment,
	TimingMap
} from '$lib/domain/types';
import { audioVariantKey, decodeAudio, encodeAudio } from '$lib/services/audio-codec';
import { segmentsEqual } from '$lib/domain/segmenter';
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

export interface TimelineSegmentVisual {
	id: string;
	left: number;
	width: number;
	cached: boolean;
	generating: number;
	/** An LLM narration rewrite is still expected for this segment. */
	narrationPending: boolean;
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
	engineBackend = $state<'webgpu' | 'wasm' | 'cloud' | undefined>();
	engineDtype = $state('');
	lastSynthesisMs = $state<number | undefined>();
	lastRealtimeFactor = $state<number | undefined>();
	lastPassageChars = $state(0);

	private context?: AudioContext;
	private gain?: GainNode;
	private soundTouch?: SoundTouchNode;
	private soundTouchRegistration?: Promise<void>;
	private soundTouchUnavailable = false;
	private source?: AudioBufferSourceNode;
	private sourceStartedAt = 0;
	private sourceOffset = 0;
	private manualStop = false;
	private frame = 0;
	private lastUiFrameAt = 0;
	private lastMediaUpdateAt = 0;
	private requestedWordIndex?: number;
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
		const savedIndex = document.playback
			? document.segments.findIndex((segment) => segment.id === document.playback?.segmentId)
			: -1;
		this.currentSegmentIndex = Math.max(0, savedIndex);
		this.currentWordIndex = document.playback?.wordIndex ?? 0;
		this.position = document.playback?.offset ?? 0;
		this.currentDuration = document.segments[this.currentSegmentIndex]?.estimatedDuration ?? 0;
		this.errorMessage = '';
		this.configureMediaSession();
		this.notifySegmentChange();
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
		} catch {
			// Persistence is an optimization; generated PCM must remain playable even
			// if encoding or browser storage is temporarily unavailable.
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
			this.sourceStartedAt = context.currentTime;
			this.sourceOffset = this.position;
			source.start(0, this.position);
			this.isPlaying = true;
			this.lastUiFrameAt = 0;
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
		if (!this.book || this.currentSegmentIndex >= this.book.segments.length - 1) {
			this.currentSegmentIndex = Math.max(
				0,
				this.book?.segments.length ? this.book.segments.length - 1 : 0
			);
			// The document finished: park the playhead at the very end instead
			// of rewinding to the last passage's start.
			this.position = this.currentDuration;
			await this.persistPosition(true);
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
			return;
		}
		this.position = 0;
		this.currentSegmentIndex += 1;
		this.currentWordIndex = 0;
		this.notifySegmentChange();
		await this.play();
	}

	private stopPlayback(persistPosition: boolean): void {
		if (this.isPlaying && persistPosition) this.updateClock();
		this.manualStop = true;
		try {
			this.source?.stop();
		} catch {
			// An already-ended source cannot be stopped twice.
		}
		this.source?.disconnect();
		this.source = undefined;
		this.isPlaying = false;
		cancelAnimationFrame(this.frame);
		if (persistPosition) void this.persistPosition(true);
		if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
	}

	pause(): void {
		this.stopPlayback(true);
	}

	async toggle(): Promise<void> {
		if (this.isPlaying) this.pause();
		else await this.play();
	}

	private updateClock(now = performance.now()): void {
		if (!this.context || !this.isPlaying) return;
		const previousPosition = this.position;
		const nextPosition = Math.min(
			this.currentDuration,
			this.sourceOffset + (this.context.currentTime - this.sourceStartedAt) * this.rate
		);
		this.markListened(this.currentSegmentIndex, previousPosition, nextPosition);
		this.position = nextPosition;
		const timing = this.currentTiming();
		if (timing) {
			const index = timing.words.findLastIndex((word) => word.start <= this.position);
			const nextWordIndex = Math.max(0, index);
			if (nextWordIndex !== this.currentWordIndex) this.currentWordIndex = nextWordIndex;
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

	async playFromSegment(index: number, wordIndex = 0): Promise<void> {
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

	async toggleBookmark(): Promise<void> {
		if (!this.book || !this.currentSegment) return;
		const existing = this.book.bookmarks.find(
			(bookmark) => bookmark.segmentId === this.currentSegment?.id
		);
		if (existing)
			this.book.bookmarks = this.book.bookmarks.filter((bookmark) => bookmark.id !== existing.id);
		else {
			const words = this.currentSegment.words;
			// Narrated/substituted segments carry no word spans; fall back to
			// the segment text for the excerpt.
			const excerpt = words.length
				? words
						.slice(Math.max(0, this.currentWordIndex - 3), this.currentWordIndex + 8)
						.map((word) => word.text)
						.join(' ')
				: this.currentSegment.text.slice(0, 60);
			const bookmark: Bookmark = {
				id: crypto.randomUUID(),
				documentId: this.book.id,
				segmentId: this.currentSegment.id,
				wordIndex: this.currentWordIndex,
				excerpt,
				label: excerpt || 'Bookmark',
				note: '',
				createdAt: Date.now()
			};
			this.book.bookmarks = [...this.book.bookmarks, bookmark];
		}
		await appState.saveDocument(this.book);
	}

	async openBookmark(bookmark: Bookmark): Promise<void> {
		if (!this.book) return;
		const index = this.book.segments.findIndex((segment) => segment.id === bookmark.segmentId);
		if (index >= 0) await this.goToSegment(index);
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
			while (version === this.cancellationVersion) {
				const index = nextIndex();
				if (index === undefined) break;
				active.add(index);
				try {
					await this.queuedCache(index);
				} finally {
					active.delete(index);
				}
				if (version !== this.cancellationVersion) break;
				this.generationProgress = this.cachedProgress * 100;
			}
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
		await appState.saveDocument(this.book);
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
