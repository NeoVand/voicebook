import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TtsWorkerRequest, TtsWorkerResponse } from './tts-messages';
import { TtsClient } from './tts-client';

class FakeWorker {
	static instances: FakeWorker[] = [];
	static autoRespond = true;
	readonly messages: TtsWorkerRequest[] = [];
	terminated = false;
	private messageListeners: Array<(event: MessageEvent<TtsWorkerResponse>) => void> = [];
	private errorListeners: Array<(event: ErrorEvent) => void> = [];

	constructor() {
		FakeWorker.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		if (type === 'message')
			this.messageListeners.push(
				listener as unknown as (event: MessageEvent<TtsWorkerResponse>) => void
			);
		if (type === 'error')
			this.errorListeners.push(listener as unknown as (event: ErrorEvent) => void);
	}

	postMessage(message: TtsWorkerRequest): void {
		this.messages.push(message);
		if (message.type === 'cancel' || !FakeWorker.autoRespond) return;
		queueMicrotask(() => {
			if (message.type === 'capabilities') {
				this.emit({
					type: 'capabilities',
					requestId: message.requestId,
					capabilities: {
						webgpu: true,
						shaderF16: true,
						webCodecs: true,
						opfs: true,
						backend: 'webgpu'
					}
				});
			} else if (message.type === 'load') {
				this.emit({
					type: 'progress',
					requestId: message.requestId,
					status: 'progress',
					progress: 50,
					file: 'model.onnx'
				});
				this.emit({
					type: 'loaded',
					requestId: message.requestId,
					modelId: message.modelId,
					backend: 'webgpu',
					dtype: 'fp32'
				});
			} else if (message.type === 'synthesize') {
				this.emit({
					type: 'result',
					requestId: message.requestId,
					audio: new Float32Array([0, 0.5]),
					sampleRate: 24_000,
					timing: { confidence: 'native', words: [{ word: 'Hello', start: 0, end: 1 }] },
					metrics: { elapsedMs: 24, audioDuration: 1, backend: 'webgpu' }
				});
			} else if (message.type === 'dispose') {
				this.emit({ type: 'disposed', requestId: message.requestId });
			}
		});
	}

	emit(message: TtsWorkerResponse): void {
		for (const listener of this.messageListeners)
			listener({ data: message } as MessageEvent<TtsWorkerResponse>);
	}

	fail(message: string): void {
		for (const listener of this.errorListeners) listener({ message } as ErrorEvent);
	}

	terminate(): void {
		this.terminated = true;
	}
}

beforeEach(() => {
	FakeWorker.instances = [];
	FakeWorker.autoRespond = true;
	vi.stubGlobal('Worker', FakeWorker);
});

describe('TTS worker client', () => {
	it('scans capabilities, aggregates progress, and records loaded runtime details', async () => {
		const client = new TtsClient();
		await expect(client.capabilities()).resolves.toMatchObject({ webgpu: true, shaderF16: true });
		const progress = vi.fn();
		await client.load('supertonic-3', 'auto', progress);
		expect(progress).toHaveBeenCalledWith(expect.objectContaining({ progress: 50 }));
		expect(client).toMatchObject({ modelId: 'supertonic-3', backend: 'webgpu', dtype: 'fp32' });
	});

	it('transfers synthesis results and disposes its worker', async () => {
		const client = new TtsClient();
		const result = await client.synthesize('Hello', 'F1');
		expect(result.audio).toEqual(new Float32Array([0, 0.5]));
		expect(result.timing.confidence).toBe('native');
		expect(FakeWorker.instances[0].messages[0]).toMatchObject({
			type: 'synthesize',
			totalSteps: 10
		});
		await client.dispose();
		expect(FakeWorker.instances[0].terminated).toBe(true);
		expect(client.modelId).toBeUndefined();
	});

	it('normalizes the requested generation quality before posting it to the worker', async () => {
		const client = new TtsClient();
		await client.synthesize('Hello', 'F1', undefined, undefined, 30);
		expect(FakeWorker.instances[0].messages[0]).toMatchObject({ totalSteps: 16 });
	});

	it('rejects pre-aborted and in-flight canceled synthesis', async () => {
		const client = new TtsClient();
		const alreadyCanceled = new AbortController();
		alreadyCanceled.abort();
		await expect(client.synthesize('No', 'af_heart', alreadyCanceled.signal)).rejects.toMatchObject(
			{
				name: 'AbortError'
			}
		);

		const controller = new AbortController();
		const promise = client.synthesize('Cancel me', 'af_heart', controller.signal);
		controller.abort();
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
		expect(FakeWorker.instances[0].messages.at(-1)?.type).toBe('cancel');
	});

	it('cancels a timed-out request without restarting the warm engine', async () => {
		vi.useFakeTimers();
		try {
			const client = new TtsClient();
			await client.load('supertonic-3');
			FakeWorker.autoRespond = false;
			const slow = client.synthesize('Very slow passage', 'F1');
			vi.advanceTimersByTime(90_000);
			await expect(slow).rejects.toThrow('did not finish within 90 seconds');
			// The request was canceled per-request: the worker lives on and the
			// loaded model does not need to reload for the next passage.
			expect(FakeWorker.instances[0].messages.at(-1)?.type).toBe('cancel');
			expect(FakeWorker.instances[0].terminated).toBe(false);
			expect(client.modelId).toBe('supertonic-3');

			// A second consecutive timeout escalates to a full engine reset.
			const wedged = client.synthesize('Still stuck', 'F1');
			vi.advanceTimersByTime(90_000);
			await expect(wedged).rejects.toThrow('stalled twice in a row');
			expect(FakeWorker.instances[0].terminated).toBe(true);
			expect(client.modelId).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects all pending work if the worker crashes', async () => {
		const client = new TtsClient();
		const promise = client.capabilities();
		FakeWorker.instances[0].fail('worker crashed');
		await expect(promise).rejects.toThrow('worker crashed');
	});

	it('terminates the worker and rejects every pending request when all work is canceled', async () => {
		FakeWorker.autoRespond = false;
		const client = new TtsClient();
		const capabilities = client.capabilities();
		const synthesis = client.synthesize('Stop now', 'af_heart');

		client.cancelAll();

		await expect(capabilities).rejects.toMatchObject({ name: 'AbortError' });
		await expect(synthesis).rejects.toMatchObject({ name: 'AbortError' });
		expect(FakeWorker.instances[0].terminated).toBe(true);
		expect(client.modelId).toBeUndefined();

		FakeWorker.autoRespond = true;
		await client.capabilities();
		expect(FakeWorker.instances).toHaveLength(2);
	});

	it('does nothing when disposed before a worker is created', async () => {
		const client = new TtsClient();
		await expect(client.dispose()).resolves.toBeUndefined();
		expect(FakeWorker.instances).toHaveLength(0);
	});

	it('rejects invalid response kinds and explicit worker errors', async () => {
		FakeWorker.autoRespond = false;
		const capabilitiesClient = new TtsClient();
		const capabilities = capabilitiesClient.capabilities();
		const capabilityRequest = FakeWorker.instances[0].messages[0];
		FakeWorker.instances[0].emit({
			type: 'disposed',
			requestId: capabilityRequest.requestId
		});
		await expect(capabilities).rejects.toThrow('invalid capability response');

		const loadClient = new TtsClient();
		const load = loadClient.load('supertonic-3');
		const loadRequest = FakeWorker.instances[1].messages[0];
		FakeWorker.instances[1].emit({ type: 'disposed', requestId: loadRequest.requestId });
		await expect(load).rejects.toThrow('did not finish loading');

		const synthesisClient = new TtsClient();
		const synthesis = synthesisClient.synthesize('Hello', 'F1');
		const synthesisRequest = FakeWorker.instances[2].messages[0];
		FakeWorker.instances[2].emit({
			type: 'error',
			requestId: synthesisRequest.requestId,
			message: 'Model failed',
			recoverable: true
		});
		await expect(synthesis).rejects.toThrow('Model failed');
	});
});
