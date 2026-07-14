/// <reference lib="webworker" />

import { getModel } from '$lib/domain/model-catalog';
import type { DeviceCapabilities, TimingMap } from '$lib/domain/types';
import { createHuggingFaceFetch } from './huggingface-fetch';
import { SupertonicAdapter } from './supertonic-adapter';
import type { TtsWorkerRequest, TtsWorkerResponse } from './tts-messages';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const hubFetch = createHuggingFaceFetch(globalThis.fetch.bind(globalThis));

interface ProgressEvent {
	status?: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

let supertonic: SupertonicAdapter | undefined;
let activeModel: 'supertonic-3' | undefined;
let activeBackend: 'webgpu' | 'wasm' = 'wasm';
let activeDtype = 'fp32';
const canceled = new Set<string>();
let operationChain: Promise<void> = Promise.resolve();

function send(message: TtsWorkerResponse, transfer: Transferable[] = []): void {
	worker.postMessage(message, transfer);
}

async function capabilities(): Promise<DeviceCapabilities> {
	let webgpu = false;
	let shaderF16 = false;
	try {
		if (navigator.gpu) {
			const adapter = await navigator.gpu.requestAdapter();
			webgpu = Boolean(adapter);
			shaderF16 = adapter?.features.has('shader-f16') ?? false;
		}
	} catch {
		webgpu = false;
	}
	return {
		webgpu,
		shaderF16,
		webCodecs: typeof AudioEncoder !== 'undefined',
		opfs: 'storage' in navigator && typeof navigator.storage.getDirectory === 'function',
		backend: webgpu ? 'webgpu' : 'wasm'
	};
}

async function disposeCurrent(): Promise<void> {
	await supertonic?.dispose();
	supertonic = undefined;
	activeModel = undefined;
}

function estimatedTiming(text: string, duration: number): TimingMap {
	const matches = Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu));
	const units = matches.map((match, index) => {
		const word = match[0];
		const end = (match.index ?? 0) + word.length;
		const nextStart = matches[index + 1]?.index ?? text.length;
		const gap = text.slice(end, nextStart);
		const pause = /[.!?…]/u.test(gap)
			? 4
			: /[;:]/u.test(gap)
				? 2.5
				: /[,]/u.test(gap)
					? 1.5
					: /\n/u.test(gap)
						? 1
						: 0;
		return { word, speech: Math.max(1.5, Array.from(word).length * 0.62), pause };
	});
	const total = units.reduce((sum, unit) => sum + unit.speech + unit.pause, 0) || 1;
	let cursor = 0;
	return {
		confidence: 'estimated',
		words: units.map((unit) => {
			const start = (cursor / total) * duration;
			cursor += unit.speech;
			const end = (cursor / total) * duration;
			cursor += unit.pause;
			return { word: unit.word, start, end };
		})
	};
}

async function loadModel(message: Extract<TtsWorkerRequest, { type: 'load' }>): Promise<void> {
	const descriptor = getModel(message.modelId);
	const device = await capabilities();
	const backend = message.backend === 'auto' ? device.backend : message.backend;
	if (backend === 'webgpu' && !device.webgpu)
		throw new Error('WebGPU is not available on this device. Choose the WASM fallback.');
	if (activeModel === message.modelId && activeBackend === backend) {
		send({
			type: 'loaded',
			requestId: message.requestId,
			modelId: message.modelId,
			backend,
			dtype: activeDtype
		});
		return;
	}
	await disposeCurrent();
	activeBackend = backend;
	activeDtype = 'fp32';
	const progress = (event: unknown) => {
		const info = event as ProgressEvent;
		send({
			type: 'progress',
			requestId: message.requestId,
			status: info.status ?? 'loading',
			file: info.file,
			progress: Math.max(0, Math.min(100, info.progress ?? 0)),
			loaded: info.loaded,
			total: info.total
		});
	};

	supertonic = new SupertonicAdapter(descriptor, hubFetch);
	await supertonic.load(backend, progress);
	activeModel = message.modelId;
	send({
		type: 'loaded',
		requestId: message.requestId,
		modelId: message.modelId,
		backend,
		dtype: activeDtype
	});
}

async function synthesize(
	message: Extract<TtsWorkerRequest, { type: 'synthesize' }>
): Promise<void> {
	const startedAt = performance.now();
	if (canceled.delete(message.requestId)) return;
	if (!activeModel) throw new Error('Install and load a voice model before playing.');
	send({
		type: 'progress',
		requestId: message.requestId,
		status: 'Preparing text…',
		progress: 5
	});
	const result = await supertonic!.synthesize(
		message.text,
		message.voiceId,
		'en',
		(step, total) =>
			send({
				type: 'progress',
				requestId: message.requestId,
				status: `Generating speech · ${step} of ${total}`,
				progress: (step / total) * 100
			}),
		message.totalSteps
	);
	const audio = result.audio;
	const sampleRate = result.sampleRate;
	const timing: TimingMap = estimatedTiming(message.text, audio.length / sampleRate);
	if (canceled.delete(message.requestId)) return;
	send({
		type: 'progress',
		requestId: message.requestId,
		status: 'Speech ready. Starting playback…',
		progress: 100
	});
	const audioDuration = audio.length / sampleRate;
	send(
		{
			type: 'result',
			requestId: message.requestId,
			audio,
			sampleRate,
			timing,
			metrics: {
				elapsedMs: performance.now() - startedAt,
				audioDuration,
				backend: activeBackend
			}
		},
		[audio.buffer]
	);
}

worker.addEventListener('message', (event: MessageEvent<TtsWorkerRequest>) => {
	const message = event.data;
	void (async () => {
		try {
			switch (message.type) {
				case 'capabilities':
					send({
						type: 'capabilities',
						requestId: message.requestId,
						capabilities: await capabilities()
					});
					break;
				case 'load':
					operationChain = operationChain.catch(() => undefined).then(() => loadModel(message));
					await operationChain;
					break;
				case 'synthesize':
					operationChain = operationChain.catch(() => undefined).then(() => synthesize(message));
					await operationChain;
					break;
				case 'cancel':
					canceled.add(message.requestId);
					break;
				case 'dispose':
					operationChain = operationChain.catch(() => undefined).then(disposeCurrent);
					await operationChain;
					send({ type: 'disposed', requestId: message.requestId });
					break;
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : 'Unknown speech engine error';
			if (/device lost|gpu.*lost|webgpu.*lost/i.test(detail)) {
				await disposeCurrent();
				send({ type: 'gpu-lost', requestId: message.requestId, message: detail });
				return;
			}
			send({
				type: 'error',
				requestId: message.requestId,
				message:
					error instanceof Error
						? error.message
						: 'The speech engine encountered an unknown error.',
				recoverable: true
			});
		}
	})();
});
