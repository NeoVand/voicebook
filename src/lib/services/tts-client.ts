import type { DeviceCapabilities, ModelDescriptor, TimingMap } from '$lib/domain/types';
import { DEFAULT_GENERATION_STEPS, normalizeGenerationSteps } from '$lib/domain/synthesis';
import {
	beginRuntimeOperation,
	finishRuntimeOperation,
	recordRuntimeEvent
} from './runtime-diagnostics';
import type {
	BackendPreference,
	SynthesisMetrics,
	TtsWorkerRequest,
	TtsWorkerResponse
} from './tts-messages';

interface ProgressUpdate {
	file?: string;
	status: string;
	progress: number;
	loaded?: number;
	total?: number;
}

interface SynthesisProgress {
	status: string;
	progress: number;
}

interface PendingRequest {
	resolve: (message: TtsWorkerResponse) => void;
	reject: (error: Error) => void;
	progress?: (update: ProgressUpdate) => void;
}

export interface SynthesisResult {
	audio: Float32Array;
	sampleRate: number;
	timing: TimingMap;
	metrics: SynthesisMetrics;
}

export class TtsClient {
	private worker?: Worker;
	private pending = new Map<string, PendingRequest>();
	modelId?: ModelDescriptor['id'];
	backend: 'webgpu' | 'wasm' = 'wasm';
	dtype = 'q8';

	/** True while any load/synthesis request is in flight — the narration
	 * scheduler yields the GPU to speech work while this holds. */
	get busy(): boolean {
		return this.pending.size > 0;
	}

	private ensureWorker(): Worker {
		if (!this.worker) {
			const speechWorker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
				type: 'module',
				name: 'voicebook-tts'
			});
			this.worker = speechWorker;
			speechWorker.addEventListener('message', (event: MessageEvent<TtsWorkerResponse>) =>
				this.receive(event.data)
			);
			speechWorker.addEventListener('error', (event) => {
				recordRuntimeEvent('worker-error', event.message || 'speech worker stopped unexpectedly');
				for (const request of this.pending.values())
					request.reject(new Error(event.message || 'The speech worker stopped unexpectedly.'));
				this.pending.clear();
				if (this.worker === speechWorker) {
					speechWorker.terminate();
					this.worker = undefined;
					this.modelId = undefined;
				}
			});
		}
		return this.worker;
	}

	private receive(message: TtsWorkerResponse): void {
		const request = this.pending.get(message.requestId);
		if (!request) return;
		if (message.type === 'progress') {
			request.progress?.(message);
			return;
		}
		this.pending.delete(message.requestId);
		if (message.type === 'gpu-lost') {
			recordRuntimeEvent('gpu-lost', message.message);
			this.modelId = undefined;
			request.reject(new Error(message.message));
		} else if (message.type === 'error') request.reject(new Error(message.message));
		else request.resolve(message);
	}

	private request(
		message: TtsWorkerRequest,
		progress?: (update: ProgressUpdate) => void
	): Promise<TtsWorkerResponse> {
		return new Promise((resolve, reject) => {
			this.pending.set(message.requestId, { resolve, reject, progress });
			this.ensureWorker().postMessage(message);
		});
	}

	async capabilities(): Promise<DeviceCapabilities> {
		const response = await this.request({ type: 'capabilities', requestId: crypto.randomUUID() });
		if (response.type !== 'capabilities')
			throw new Error('The speech worker returned an invalid capability response.');
		return response.capabilities;
	}

	async load(
		modelId: ModelDescriptor['id'],
		backend: BackendPreference = 'auto',
		progress?: (update: ProgressUpdate) => void
	): Promise<void> {
		const operationId = beginRuntimeOperation('model-load', { modelId, backend });
		try {
			const response = await this.request(
				{ type: 'load', requestId: crypto.randomUUID(), modelId, backend },
				progress
			);
			if (response.type !== 'loaded') throw new Error('The speech worker did not finish loading.');
			this.modelId = response.modelId;
			this.backend = response.backend;
			this.dtype = response.dtype;
			finishRuntimeOperation(
				operationId,
				'completed',
				`${response.backend.toUpperCase()} · ${response.dtype}`
			);
		} catch (error) {
			finishRuntimeOperation(
				operationId,
				'failed',
				error instanceof Error ? error.message : 'unknown model load error'
			);
			throw error;
		}
	}

	async synthesize(
		text: string,
		voiceId: string,
		signal?: AbortSignal,
		progress?: (update: SynthesisProgress) => void,
		totalSteps = DEFAULT_GENERATION_STEPS
	): Promise<SynthesisResult> {
		if (signal?.aborted) throw new DOMException('Speech generation was canceled.', 'AbortError');
		const requestId = crypto.randomUUID();
		const operationId = beginRuntimeOperation('speech-generation', {
			characters: text.length,
			steps: normalizeGenerationSteps(totalSteps),
			backend: this.backend
		});
		let timedOut = false;
		const abort = () => {
			this.ensureWorker().postMessage({ type: 'cancel', requestId } satisfies TtsWorkerRequest);
			const pending = this.pending.get(requestId);
			pending?.reject(new DOMException('Speech generation was canceled.', 'AbortError'));
			this.pending.delete(requestId);
		};
		signal?.addEventListener('abort', abort, { once: true });
		const timeout = globalThis.setTimeout(() => {
			if (!this.pending.has(requestId)) return;
			timedOut = true;
			this.cancelAll();
		}, 90_000);
		try {
			const response = await this.request(
				{
					type: 'synthesize',
					requestId,
					text,
					voiceId,
					totalSteps: normalizeGenerationSteps(totalSteps)
				},
				(update) => progress?.({ status: update.status, progress: update.progress })
			).catch((error) => {
				if (timedOut)
					throw new Error(
						'Speech generation did not finish within 90 seconds. The voice engine was stopped so it cannot keep slowing down this device.'
					);
				throw error;
			});
			if (response.type !== 'result')
				throw new Error('The speech worker returned an invalid audio result.');
			const result = {
				audio: response.audio,
				sampleRate: response.sampleRate,
				timing: response.timing,
				metrics: response.metrics
			};
			finishRuntimeOperation(operationId, 'completed');
			return result;
		} catch (error) {
			finishRuntimeOperation(
				operationId,
				'failed',
				error instanceof Error ? error.message : 'unknown synthesis error'
			);
			throw error;
		} finally {
			globalThis.clearTimeout(timeout);
			signal?.removeEventListener('abort', abort);
		}
	}

	cancelAll(): void {
		const error = new DOMException('Speech generation was canceled.', 'AbortError');
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
		this.worker?.terminate();
		this.worker = undefined;
		this.modelId = undefined;
	}

	async dispose(): Promise<void> {
		if (!this.worker) return;
		await this.request({ type: 'dispose', requestId: crypto.randomUUID() });
		this.worker.terminate();
		this.worker = undefined;
		this.modelId = undefined;
	}
}

export const ttsClient = new TtsClient();
