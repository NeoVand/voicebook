import type { DeviceCapabilities, ModelDescriptor, TimingMap } from '$lib/domain/types';
import { DEFAULT_GENERATION_STEPS, normalizeGenerationSteps } from '$lib/domain/synthesis';
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

	private ensureWorker(): Worker {
		if (!this.worker) {
			this.worker = new Worker(new URL('./tts.worker.ts', import.meta.url), {
				type: 'module',
				name: 'voicebook-tts'
			});
			this.worker.addEventListener('message', (event: MessageEvent<TtsWorkerResponse>) =>
				this.receive(event.data)
			);
			this.worker.addEventListener('error', (event) => {
				for (const request of this.pending.values())
					request.reject(new Error(event.message || 'The speech worker stopped unexpectedly.'));
				this.pending.clear();
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
		if (message.type === 'error' || message.type === 'gpu-lost')
			request.reject(new Error(message.message));
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
		const response = await this.request(
			{ type: 'load', requestId: crypto.randomUUID(), modelId, backend },
			progress
		);
		if (response.type !== 'loaded') throw new Error('The speech worker did not finish loading.');
		this.modelId = response.modelId;
		this.backend = response.backend;
		this.dtype = response.dtype;
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
			return {
				audio: response.audio,
				sampleRate: response.sampleRate,
				timing: response.timing,
				metrics: response.metrics
			};
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
