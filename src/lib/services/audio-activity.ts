/**
 * Hears when a stream carries sound. GPT-Live sends no events for its own
 * speech — no start, no end, no drain — so the app listens to the voice's
 * track itself; the same ear catches the reader talking over the voice.
 * Sound starts activity after a short run above the threshold, and a pause
 * long enough to end a sentence (not a breath) ends it.
 */

const TICK_MS = 50;

export interface AudioActivityOptions {
	/** RMS level that counts as sound. */
	threshold: number;
	/** Sustained sound that starts activity. */
	startMs: number;
	/** Silence that ends it. */
	endMs: number;
	onChange(active: boolean): void;
}

export class AudioActivityMonitor {
	active = false;
	private context?: AudioContext;
	private analyser?: AnalyserNode;
	private samples?: Float32Array<ArrayBuffer>;
	private timer: ReturnType<typeof setInterval> | undefined;
	private loud = 0;
	private quiet = 0;

	constructor(
		stream: MediaStream,
		private readonly options: AudioActivityOptions
	) {
		try {
			const context = new AudioContext();
			if (context.state === 'suspended') void context.resume().catch(() => undefined);
			const analyser = context.createAnalyser();
			analyser.fftSize = 1024;
			context.createMediaStreamSource(stream).connect(analyser);
			this.context = context;
			this.analyser = analyser;
			this.samples = new Float32Array(analyser.fftSize);
			this.timer = setInterval(() => this.poll(), TICK_MS);
		} catch {
			// Without an audio graph there is nothing to hear; callers fall back
			// to transcript timing.
		}
	}

	private poll(): void {
		const analyser = this.analyser;
		const samples = this.samples;
		if (!analyser || !samples) return;
		analyser.getFloatTimeDomainData(samples);
		let sum = 0;
		for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
		const sounding = Math.sqrt(sum / samples.length) > this.options.threshold;
		if (sounding) {
			this.quiet = 0;
			this.loud += 1;
			if (!this.active && this.loud * TICK_MS >= this.options.startMs) this.set(true);
		} else {
			this.loud = 0;
			this.quiet += 1;
			if (this.active && this.quiet * TICK_MS >= this.options.endMs) this.set(false);
		}
	}

	private set(active: boolean): void {
		this.active = active;
		this.options.onChange(active);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		void this.context?.close().catch(() => undefined);
		this.context = undefined;
		this.analyser = undefined;
		this.samples = undefined;
	}
}
