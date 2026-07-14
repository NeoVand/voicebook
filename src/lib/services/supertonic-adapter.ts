// Match Supertone's browser demo and load the WebGPU-focused ORT bundle. It
// still contains the WASM execution provider, but avoids pulling the generic
// browser bundle into this dedicated inference worker.
import * as ort from 'onnxruntime-web-supertone/webgpu';
import type { ModelDescriptor } from '$lib/domain/types';
import { MODEL_ASSET_CACHE } from './model-asset-cache';

interface TtsConfig {
	ttl: { latent_dim: number; chunk_compress_factor: number };
	ae: { sample_rate: number; base_chunk_size: number };
}

interface VoiceStyleJson {
	style_ttl: { data: number[][][]; dims: number[] };
	style_dp: { data: number[][][]; dims: number[] };
}

interface VoiceStyle {
	ttl: ort.Tensor;
	dp: ort.Tensor;
}

interface LoadProgress {
	status: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

type ProgressCallback = (event: LoadProgress) => void;
type Backend = 'webgpu' | 'wasm';

const LANGUAGES = new Set([
	'en',
	'ko',
	'ja',
	'ar',
	'bg',
	'cs',
	'da',
	'de',
	'el',
	'es',
	'et',
	'fi',
	'fr',
	'hi',
	'hr',
	'hu',
	'id',
	'it',
	'lt',
	'lv',
	'nl',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sv',
	'tr',
	'uk',
	'vi',
	'na'
]);

const MODEL_FILES = [
	'duration_predictor.onnx',
	'text_encoder.onnx',
	'vector_estimator.onnx',
	'vocoder.onnx'
] as const;

function flattenNumbers(value: number[][][]): Float32Array {
	return new Float32Array(value.flat(2));
}

function normalizeText(text: string, language: string): string {
	if (!LANGUAGES.has(language)) throw new Error(`Supertonic does not support “${language}”.`);
	let normalized = text
		.normalize('NFKD')
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '')
		.replace(/[–‑—]/g, '-')
		.replace(/[_|/#→←]/g, ' ')
		.replaceAll('[', ' ')
		.replaceAll(']', ' ')
		.replace(/[“”]/g, '"')
		.replace(/[‘’´`]/g, "'")
		.replace(/[♥☆♡©\\]/g, '')
		.replaceAll('@', ' at ')
		.replaceAll('e.g.,', 'for example, ')
		.replaceAll('i.e.,', 'that is, ')
		.replace(/\s+([,.!?;:])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
	if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(normalized)) normalized += '.';
	return `<${language}>${normalized}</${language}>`;
}

function chunkText(text: string, maxLength = 300): string[] {
	const sentences = text
		.trim()
		.split(/(?<=[.!?])\s+/)
		.filter(Boolean);
	const chunks: string[] = [];
	let current = '';
	for (const sentence of sentences) {
		if (!current || current.length + sentence.length + 1 <= maxLength) {
			current += `${current ? ' ' : ''}${sentence}`;
		} else {
			chunks.push(current);
			current = sentence;
		}
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [text];
}

export class SupertonicAdapter {
	private config?: TtsConfig;
	private indexer?: number[];
	private sessions: ort.InferenceSession[] = [];
	private styles = new Map<string, VoiceStyle>();

	constructor(
		private readonly descriptor: ModelDescriptor,
		private readonly fetcher: typeof fetch
	) {}

	private assetUrl(path: string): string {
		return `https://huggingface.co/${this.descriptor.repository}/resolve/${this.descriptor.revision}/${path}`;
	}

	private async response(path: string): Promise<Response> {
		const url = this.assetUrl(path);
		if (typeof caches !== 'undefined') {
			const cache = await caches.open(MODEL_ASSET_CACHE);
			const cached = await cache.match(url);
			if (cached) return cached;
			const response = await this.fetcher(url);
			if (!response.ok) throw new Error(`Could not download ${path} (${response.status}).`);
			void cache.put(url, response.clone()).catch(() => undefined);
			return response;
		}
		const response = await this.fetcher(url);
		if (!response.ok) throw new Error(`Could not download ${path} (${response.status}).`);
		return response;
	}

	private async json<T>(path: string): Promise<T> {
		return (await (await this.response(path)).json()) as T;
	}

	private async bytes(
		path: string,
		fileIndex: number,
		fileCount: number,
		progress: ProgressCallback
	): Promise<Uint8Array> {
		const response = await this.response(path);
		const total = Number(response.headers.get('content-length') ?? 0);
		if (!response.body) return new Uint8Array(await response.arrayBuffer());
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.byteLength;
			const fileProgress = total ? loaded / total : 0;
			progress({
				status: 'progress',
				file: path,
				progress: ((fileIndex + fileProgress) / fileCount) * 100,
				loaded,
				total: total || undefined
			});
		}
		const result = new Uint8Array(loaded);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}

	async load(backend: Backend, progress: ProgressCallback): Promise<void> {
		progress({ status: 'loading', file: 'Configuration', progress: 0 });
		[this.config, this.indexer] = await Promise.all([
			this.json<TtsConfig>('onnx/tts.json'),
			this.json<number[]>('onnx/unicode_indexer.json')
		]);
		const options: ort.InferenceSession.SessionOptions = {
			executionProviders: [backend],
			graphOptimizationLevel: 'all'
		};
		for (const [index, file] of MODEL_FILES.entries()) {
			progress({
				status: 'loading',
				file: `Loading ${file.replace('.onnx', '').replaceAll('_', ' ')}`,
				progress: (index / MODEL_FILES.length) * 100
			});
			const data = await this.bytes(`onnx/${file}`, index, MODEL_FILES.length, progress);
			this.sessions.push(await ort.InferenceSession.create(data, options));
		}
		// The first WebGPU run includes shader and graph compilation. Supertone's
		// official Space absorbs that cost before enabling Generate; do the same
		// here so the user's first Play gesture is not the warm-up benchmark.
		progress({ status: 'loading', file: 'Warming up WebGPU', progress: 96 });
		try {
			const style = await this.style(this.descriptor.defaultVoice);
			await this.infer('Hello, this is a quick warmup.', 'en', style, undefined, 1);
		} catch (error) {
			console.warn(
				'Supertonic warm-up did not complete; normal synthesis can still continue.',
				error
			);
		}
		progress({ status: 'ready', file: 'Supertonic 3 ready', progress: 100 });
	}

	private textInputs(text: string, language: string): { ids: ort.Tensor; mask: ort.Tensor } {
		if (!this.indexer) throw new Error('Supertonic text processing is not ready.');
		const normalized = normalizeText(text, language);
		const codePoints = Array.from(normalized, (character) => character.codePointAt(0) ?? 0);
		const ids = new BigInt64Array(
			codePoints.map((codePoint) => BigInt(this.indexer![codePoint] ?? -1))
		);
		return {
			ids: new ort.Tensor('int64', ids, [1, ids.length]),
			mask: new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [1, 1, ids.length])
		};
	}

	private async style(voiceId: string): Promise<VoiceStyle> {
		const cached = this.styles.get(voiceId);
		if (cached) return cached;
		const source = await this.json<VoiceStyleJson>(`voice_styles/${voiceId}.json`);
		const style = {
			ttl: new ort.Tensor('float32', flattenNumbers(source.style_ttl.data), source.style_ttl.dims),
			dp: new ort.Tensor('float32', flattenNumbers(source.style_dp.data), source.style_dp.dims)
		};
		this.styles.set(voiceId, style);
		return style;
	}

	private noisyLatent(duration: number): {
		latent: Float32Array;
		mask: ort.Tensor;
		dims: number[];
	} {
		if (!this.config) throw new Error('Supertonic configuration is not ready.');
		const chunkSize = this.config.ae.base_chunk_size * this.config.ttl.chunk_compress_factor;
		const latentLength = Math.ceil((duration * this.config.ae.sample_rate) / chunkSize);
		const latentChannels = this.config.ttl.latent_dim * this.config.ttl.chunk_compress_factor;
		const latent = new Float32Array(latentChannels * latentLength);
		for (let index = 0; index < latent.length; index += 2) {
			const first = Math.max(0.0001, Math.random());
			const second = Math.random();
			const magnitude = Math.sqrt(-2 * Math.log(first));
			latent[index] = magnitude * Math.cos(2 * Math.PI * second);
			if (index + 1 < latent.length) latent[index + 1] = magnitude * Math.sin(2 * Math.PI * second);
		}
		return {
			latent,
			mask: new ort.Tensor('float32', new Float32Array(latentLength).fill(1), [1, 1, latentLength]),
			dims: [1, latentChannels, latentLength]
		};
	}

	private async infer(
		text: string,
		language: string,
		style: VoiceStyle,
		progress?: (step: number, total: number) => void,
		totalSteps = 8
	): Promise<{ audio: Float32Array; duration: number }> {
		if (!this.config || this.sessions.length !== 4)
			throw new Error('Supertonic 3 is not loaded yet.');
		const [durationPredictor, textEncoder, vectorEstimator, vocoder] = this.sessions;
		const { ids, mask } = this.textInputs(text, language);
		const durationOutput = await durationPredictor.run({
			text_ids: ids,
			style_dp: style.dp,
			text_mask: mask
		});
		const duration = Number(durationOutput.duration.data[0]);
		const encoded = await textEncoder.run({
			text_ids: ids,
			style_ttl: style.ttl,
			text_mask: mask
		});
		const sampled = this.noisyLatent(duration);
		const latent = sampled.latent;
		const totalStepTensor = new ort.Tensor('float32', new Float32Array([totalSteps]), [1]);
		const stepTensors = Array.from(
			{ length: totalSteps },
			(_, step) => new ort.Tensor('float32', new Float32Array([step]), [1])
		);
		for (let step = 0; step < totalSteps; step += 1) {
			const output = await vectorEstimator.run({
				noisy_latent: new ort.Tensor('float32', latent, sampled.dims),
				text_emb: encoded.text_emb,
				style_ttl: style.ttl,
				latent_mask: sampled.mask,
				text_mask: mask,
				current_step: stepTensors[step],
				total_step: totalStepTensor
			});
			latent.set(output.denoised_latent.data as Float32Array);
			progress?.(step + 1, totalSteps);
		}
		const decoded = await vocoder.run({
			latent: new ort.Tensor('float32', latent, sampled.dims)
		});
		const audio = new Float32Array(decoded.wav_tts.data as Float32Array);
		return { audio: audio.slice(0, Math.floor(duration * this.config.ae.sample_rate)), duration };
	}

	async synthesize(
		text: string,
		voiceId: string,
		language = 'en',
		progress?: (step: number, total: number) => void
	): Promise<{ audio: Float32Array; sampleRate: number }> {
		if (!this.config) throw new Error('Supertonic 3 is not loaded yet.');
		const style = await this.style(voiceId);
		const chunks = chunkText(text, language === 'ko' || language === 'ja' ? 120 : 300);
		const silence = new Float32Array(Math.floor(this.config.ae.sample_rate * 0.3));
		const parts: Float32Array[] = [];
		let length = 0;
		for (const [index, chunk] of chunks.entries()) {
			const result = await this.infer(chunk, language, style, progress);
			if (index) {
				parts.push(silence);
				length += silence.length;
			}
			parts.push(result.audio);
			length += result.audio.length;
		}
		const audio = new Float32Array(length);
		let offset = 0;
		for (const part of parts) {
			audio.set(part, offset);
			offset += part.length;
		}
		return { audio, sampleRate: this.config.ae.sample_rate };
	}

	async dispose(): Promise<void> {
		await Promise.all(this.sessions.map((session) => session.release()));
		this.sessions = [];
		this.styles.clear();
	}
}
