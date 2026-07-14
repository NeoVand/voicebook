import { SoundTouchNode } from '@soundtouchjs/audio-worklet';
import processorUrl from '@soundtouchjs/audio-worklet/processor?url';
import { SvelteMap } from 'svelte/reactivity';
import { getModel } from '$lib/domain/model-catalog';
import type {
	AudioVariantMeta,
	Bookmark,
	NormalizedDocument,
	SpeechSegment,
	TimingMap
} from '$lib/domain/types';
import { audioVariantKey, decodeAudio, encodeAudio } from '$lib/services/audio-codec';
import { getAudio, putAudio } from '$lib/services/repository';
import { ttsClient } from '$lib/services/tts-client';
import { generationPlan } from '$lib/services/generation-plan';
import {
	absoluteTimelinePosition,
	locateTimelinePosition,
	timelineDuration,
	timelineProgress
} from '$lib/services/timeline';
import { appState } from './app-state.svelte';

interface PreparedAudio {
	key: string;
	buffer: AudioBuffer;
	timing: TimingMap;
}

export class VoicebookPlayer {
	book = $state<NormalizedDocument | null>(null);
	isPlaying = $state(false);
	isBuffering = $state(false);
	bufferingStage = $state('Preparing this passage…');
	isGeneratingAll = $state(false);
	generationProgress = $state(0);
	currentSegmentIndex = $state(0);
	currentWordIndex = $state(0);
	position = $state(0);
	currentDuration = $state(0);
	rate = $state(1);
	volume = $state(0.9);
	autoFollow = $state(true);
	errorMessage = $state('');
	engineBackend = $state<'webgpu' | 'wasm' | undefined>();
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
	private abortControllers = new SvelteMap<number, AbortController>();
	private lastSavedAt = 0;
	private cancellationVersion = 0;
	private engineLoad?: { modelId: string; promise: Promise<void> };
	onSegmentChange?: (segmentId: string) => void;

	get currentSegment(): SpeechSegment | undefined {
		return this.book?.segments[this.currentSegmentIndex];
	}

	get progress(): number {
		return timelineProgress(this.timelineDurations(), this.currentSegmentIndex, this.position);
	}

	get totalDuration(): number {
		return timelineDuration(this.timelineDurations());
	}

	get runtimeLabel(): string {
		if (!this.engineBackend) return 'Engine warming';
		return `${this.engineBackend === 'webgpu' ? 'WebGPU' : 'WASM'} · ${this.engineDtype}`;
	}

	get runtimeDetail(): string {
		if (this.lastSynthesisMs === undefined || this.lastRealtimeFactor === undefined)
			return this.runtimeLabel;
		return `${this.runtimeLabel}; last passage: ${this.lastPassageChars} characters in ${(this.lastSynthesisMs / 1_000).toFixed(2)} seconds (${this.lastRealtimeFactor.toFixed(2)}× real-time factor)`;
	}

	setDocument(document: NormalizedDocument): void {
		this.pause();
		this.preparedBySegment.clear();
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

	private reprioritize(): void {
		for (const controller of this.abortControllers.values()) controller.abort();
		this.abortControllers.clear();
		this.queue.clear();
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
		const modelId = appState.selectedModelId;
		if (!appState.installedModels.includes(modelId))
			throw new Error(`Install ${getModel(modelId).name} before playing.`);
		if (ttsClient.modelId === modelId) {
			this.engineBackend = ttsClient.backend;
			this.engineDtype = ttsClient.dtype;
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
	}

	async warmEngine(): Promise<void> {
		if (!this.book || !appState.installedModels.includes(appState.selectedModelId)) return;
		try {
			await this.ensureEngine();
		} catch {
			// Playback presents the actionable error if the background warm-up fails.
		}
	}

	private async cacheKey(segment: SpeechSegment): Promise<string> {
		const model = appState.selectedModel;
		return audioVariantKey([
			this.book?.fingerprint ?? '',
			segment.id,
			segment.normalizedText,
			model.repository,
			model.revision,
			appState.selectedVoiceId,
			ttsClient.backend,
			ttsClient.dtype,
			`generation-steps:${appState.generationSteps}`,
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
		if (memory) return memory;
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
			return prepared;
		}

		const controller = new AbortController();
		this.abortControllers.set(index, controller);
		try {
			this.bufferingStage = `Generating “${segment.normalizedText.slice(0, 48)}${segment.normalizedText.length > 48 ? '…' : ''}”`;
			const generated = await ttsClient.synthesize(
				segment.normalizedText,
				appState.selectedVoiceId,
				controller.signal,
				(update) => {
					this.bufferingStage = update.status;
				},
				appState.generationSteps
			);
			if (controller.signal.aborted)
				throw new DOMException('Speech generation was canceled.', 'AbortError');
			this.lastSynthesisMs = generated.metrics.elapsedMs;
			this.lastRealtimeFactor = generated.metrics.audioDuration
				? generated.metrics.elapsedMs / 1_000 / generated.metrics.audioDuration
				: undefined;
			this.lastPassageChars = segment.normalizedText.length;
			const duration = generated.audio.length / generated.sampleRate;
			const model = appState.selectedModel;
			this.bufferingStage = 'Starting playback…';
			const buffer = context.createBuffer(1, generated.audio.length, generated.sampleRate);
			buffer.getChannelData(0).set(generated.audio);
			const prepared = {
				key,
				buffer,
				timing: generated.timing
			};
			this.audioCache.set(key, prepared);
			this.preparedBySegment.set(index, prepared);
			const meta: Omit<AudioVariantMeta, 'mimeType'> = {
				key,
				documentId: this.book.id,
				segmentId: segment.id,
				modelId: model.id,
				modelRevision: model.revision,
				voiceId: appState.selectedVoiceId,
				generationSteps: appState.generationSteps,
				backend: ttsClient.backend,
				dtype: ttsClient.dtype,
				duration,
				timing: generated.timing,
				createdAt: Date.now()
			};
			void this.persistGeneratedAudio(
				meta,
				generated.audio,
				generated.sampleRate,
				controller.signal
			);
			return prepared;
		} finally {
			if (this.abortControllers.get(index) === controller) this.abortControllers.delete(index);
		}
	}

	private async persistGeneratedAudio(
		meta: Omit<AudioVariantMeta, 'mimeType'>,
		audio: Float32Array,
		sampleRate: number,
		signal: AbortSignal
	): Promise<void> {
		try {
			const encoded = await encodeAudio(audio, sampleRate);
			if (signal.aborted) return;
			await putAudio({ ...meta, mimeType: encoded.mimeType }, encoded.blob);
		} catch {
			// Persistence is an optimization; generated PCM must remain playable even
			// if encoding or browser storage is temporarily unavailable.
		}
	}

	private queuedAudio(index: number): Promise<PreparedAudio> {
		const existing = this.queue.get(index);
		if (existing) return existing;
		const request = this.prepareAudio(index).finally(() => {
			if (this.queue.get(index) === request) this.queue.delete(index);
		});
		this.queue.set(index, request);
		return request;
	}

	private prefetch(): void {
		if (!this.book) return;
		const lookAhead = ttsClient.backend === 'webgpu' ? 2 : 1;
		for (const index of generationPlan(
			this.book.segments.length,
			this.currentSegmentIndex,
			lookAhead
		).slice(1)) {
			void this.queuedAudio(index).catch(() => undefined);
		}
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
			this.prefetch();
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
		this.generationProgress = 0;
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
	}

	private async advanceAfterEnd(): Promise<void> {
		this.isPlaying = false;
		this.position = 0;
		if (!this.book || this.currentSegmentIndex >= this.book.segments.length - 1) {
			this.currentSegmentIndex = Math.max(
				0,
				this.book?.segments.length ? this.book.segments.length - 1 : 0
			);
			await this.persistPosition(true);
			if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
			return;
		}
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
		this.position = Math.min(
			this.currentDuration,
			this.sourceOffset + (this.context.currentTime - this.sourceStartedAt) * this.rate
		);
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
		this.reprioritize();
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
		this.reprioritize();
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
		this.pause();
		this.reprioritize();
		this.preparedBySegment.clear();
		await appState.selectVoice(id);
	}

	async chooseGenerationSteps(value: number): Promise<void> {
		if (value === appState.generationSteps) return;
		this.stopPlayback(false);
		const hadPendingSynthesis = this.isBuffering || this.isGeneratingAll || this.queue.size > 0;
		this.cancellationVersion += 1;
		this.reprioritize();
		if (hadPendingSynthesis) ttsClient.cancelAll();
		this.preparedBySegment.clear();
		this.isBuffering = false;
		this.isGeneratingAll = false;
		this.generationProgress = 0;
		this.bufferingStage = 'Preparing this passage…';
		this.errorMessage = '';
		await appState.setGenerationSteps(value);
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
			const excerpt = words
				.slice(Math.max(0, this.currentWordIndex - 3), this.currentWordIndex + 8)
				.map((word) => word.text)
				.join(' ');
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
		if (!this.book || this.isGeneratingAll) return;
		this.isGeneratingAll = true;
		this.generationProgress = 0;
		this.errorMessage = '';
		const version = this.cancellationVersion;
		try {
			await this.ensureEngine();
			for (const [position, index] of generationPlan(
				this.book.segments.length,
				this.currentSegmentIndex,
				3,
				true
			).entries()) {
				await this.queuedAudio(index);
				if (version !== this.cancellationVersion) return;
				this.generationProgress = ((position + 1) / this.book.segments.length) * 100;
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
			if (version === this.cancellationVersion) this.isGeneratingAll = false;
		}
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
