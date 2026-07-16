/**
 * Main-thread proxy for the language-model worker: messages are plain
 * {role, content} pairs and callers get single-shot completions. One shared
 * worker, model swap disposes the old one first, per-job correlation ids,
 * and an HMR-surviving global slot so dev reloads never hold two model
 * copies in memory.
 */

const browser = typeof window !== 'undefined' && typeof Worker !== 'undefined';

export interface LlmChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface LlmProgress {
	status?: string;
	progress?: number;
	file?: string;
}

export interface LlmHostOptions {
	model: string;
	dtype?: string;
	device?: 'webgpu' | 'wasm' | 'auto';
	onProgress?: (p: LlmProgress) => void;
}

export interface LlmGenerateOptions {
	maxNewTokens?: number;
	temperature?: number;
	/** Reject the pending job when aborted. The in-flight inference itself
	 * cannot be interrupted mid-token; its late result is simply dropped. */
	signal?: AbortSignal;
	timeoutMs?: number;
	onToken?: (t: string) => void;
}

const DEFAULT_JOB_TIMEOUT_MS = 90_000;

interface PendingJob {
	resolve: (value: string) => void;
	reject: (err: Error) => void;
	tokens: string[];
	onToken?: (t: string) => void;
	cleanup: () => void;
}

export class LlmWorkerHost {
	worker: Worker | null = null;
	ready = false;
	private waitReady: Promise<void> | null = null;
	private jobs = new Map<string, PendingJob>();
	private modelId: string | null = null;

	constructor(public modelOpts: LlmHostOptions) {}

	private id() {
		return Math.random().toString(36).slice(2, 10);
	}

	private ensureWorker() {
		if (!browser) throw new Error('The narration model can only run in the browser.');
		if (this.worker) return;
		this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		this.worker.addEventListener('message', (ev: MessageEvent) => this.handle(ev.data));
	}

	private handle(msg: {
		type: string;
		id?: string;
		text?: string;
		message?: string;
		payload?: LlmProgress;
	}) {
		if (msg.type === 'progress' && msg.payload) {
			this.modelOpts.onProgress?.(msg.payload);
			return;
		}
		if (!msg.id) return;
		const job = this.jobs.get(msg.id);
		if (!job && msg.type !== 'ready') return;
		if (msg.type === 'token' && msg.text != null) {
			job!.tokens.push(msg.text);
			job!.onToken?.(msg.text);
		} else if (msg.type === 'done') {
			job!.cleanup();
			job!.resolve(msg.text ?? job!.tokens.join(''));
			this.jobs.delete(msg.id);
		} else if (msg.type === 'error') {
			job!.cleanup();
			job!.reject(new Error(msg.message || 'Narration model error'));
			this.jobs.delete(msg.id);
		} else if (msg.type === 'ready') {
			this.modelId = this.modelOpts.model;
			this.ready = true;
		}
	}

	async ensureReady() {
		this.ensureWorker();
		if (this.ready && this.modelId === this.modelOpts.model) return;
		if (this.waitReady) return this.waitReady;
		this.waitReady = new Promise<void>((resolve, reject) => {
			const id = this.id();
			const onReady = (ev: MessageEvent) => {
				const msg = ev.data as { type: string; id?: string; message?: string };
				if (msg.id !== id) return;
				if (msg.type === 'ready') {
					this.worker!.removeEventListener('message', onReady);
					this.ready = true;
					this.modelId = this.modelOpts.model;
					resolve();
				} else if (msg.type === 'error') {
					this.worker!.removeEventListener('message', onReady);
					reject(new Error(msg.message || 'init error'));
				}
			};
			this.worker!.addEventListener('message', onReady);
			this.worker!.postMessage({
				type: 'init',
				id,
				model: this.modelOpts.model,
				dtype: this.modelOpts.dtype,
				device: this.modelOpts.device ?? 'webgpu'
			});
		});
		try {
			await this.waitReady;
		} finally {
			this.waitReady = null;
		}
	}

	/** Tear down the worker (and free the model it holds in memory). */
	dispose() {
		this.worker?.terminate();
		this.worker = null;
		this.ready = false;
		this.modelId = null;
		this.waitReady = null;
		for (const job of this.jobs.values()) {
			job.cleanup();
			job.reject(new Error('Narration model was shut down.'));
		}
		this.jobs.clear();
	}

	get busy(): boolean {
		return this.jobs.size > 0;
	}

	async generate(messages: LlmChatMessage[], options: LlmGenerateOptions = {}): Promise<string> {
		await this.ensureReady();
		if (options.signal?.aborted) throw new Error('Narration request cancelled.');
		return new Promise<string>((resolve, reject) => {
			const id = this.id();
			const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
			const timer = setTimeout(() => {
				fail(new Error(`Narration generation timed out after ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			const onAbort = () => fail(new Error('Narration request cancelled.'));
			const cleanup = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener('abort', onAbort);
			};
			const fail = (err: Error) => {
				cleanup();
				this.jobs.delete(id);
				reject(err);
			};
			options.signal?.addEventListener('abort', onAbort, { once: true });
			this.jobs.set(id, { resolve, reject, tokens: [], onToken: options.onToken, cleanup });
			this.worker!.postMessage({
				type: 'generate',
				id,
				messages,
				max_new_tokens: options.maxNewTokens ?? 192,
				temperature: options.temperature ?? 0.2,
				stream: Boolean(options.onToken)
			});
		});
	}
}

// Keep the worker on globalThis so it's a single shared instance for the whole app and
// survives dev HMR module re-execution — the model loads into memory once. Switching
// models terminates the old worker first, so we never hold two model copies at once.
const _g = globalThis as unknown as { __vbLlm?: { host: LlmWorkerHost | null; key: string } };
_g.__vbLlm ??= { host: null, key: '' };

export function getLlmHost(opts: LlmHostOptions): LlmWorkerHost {
	const key = `${opts.model}|${opts.dtype}|${opts.device ?? 'webgpu'}`;
	const slot = _g.__vbLlm!;
	if (slot.host && slot.key === key) {
		slot.host.modelOpts = opts;
		return slot.host;
	}
	slot.host?.dispose();
	slot.host = new LlmWorkerHost(opts);
	slot.key = key;
	return slot.host;
}

/** The active host, if any — without creating one. */
export function activeLlmHost(): LlmWorkerHost | null {
	return _g.__vbLlm!.host;
}

/** Drop the shared host entirely (used when a device attempt fails mid-probe,
 * on OOM recovery, and when the model is removed). */
export function disposeLlmHost() {
	const slot = _g.__vbLlm!;
	slot.host?.dispose();
	slot.host = null;
	slot.key = '';
}
