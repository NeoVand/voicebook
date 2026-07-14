import type { Page } from '@playwright/test';

export async function installFakeTts(page: Page): Promise<void> {
	await page.addInitScript(() => {
		interface LoggedWorkerMessage {
			type: string;
			requestId: string;
			modelId?: string;
			text?: string;
			totalSteps?: number;
		}

		const workerMessages: LoggedWorkerMessage[] = [];
		Object.defineProperty(window, '__voicebookTtsMessages', {
			value: workerMessages,
			configurable: true
		});

		class FakeSpeechWorker {
			private listeners: Record<
				string,
				Array<(event: { data?: unknown; message?: string }) => void>
			> = {
				message: [],
				error: []
			};

			addEventListener(
				type: string,
				listener: (event: { data?: unknown; message?: string }) => void
			): void {
				this.listeners[type]?.push(listener);
			}

			postMessage(message: LoggedWorkerMessage): void {
				workerMessages.push(message);
				if (message.type === 'cancel') return;
				const respond = () => {
					if (message.type === 'capabilities') {
						this.emit({
							type: 'capabilities',
							requestId: message.requestId,
							capabilities: {
								webgpu: true,
								shaderF16: true,
								webCodecs: typeof AudioEncoder !== 'undefined',
								opfs: Boolean(navigator.storage?.getDirectory),
								backend: 'webgpu'
							}
						});
					} else if (message.type === 'load') {
						this.emit({
							type: 'progress',
							requestId: message.requestId,
							status: 'progress',
							progress: 65,
							file: 'model_quantized.onnx'
						});
						this.emit({
							type: 'loaded',
							requestId: message.requestId,
							modelId: message.modelId,
							backend: 'webgpu',
							dtype: 'fp32'
						});
					} else if (message.type === 'synthesize') {
						const audio = new Float32Array(24_000);
						for (let index = 0; index < audio.length; index += 1)
							audio[index] = Math.sin((index / 24_000) * Math.PI * 2 * 220) * 0.08;
						this.emit({
							type: 'result',
							requestId: message.requestId,
							audio,
							sampleRate: 24_000,
							timing: {
								confidence: 'native',
								words: [
									{ word: 'Voicebook', start: 0, end: 0.45 },
									{ word: 'reads', start: 0.45, end: 1 }
								]
							},
							metrics: { elapsedMs: 18, audioDuration: 1, backend: 'webgpu' }
						});
					} else if (message.type === 'dispose') {
						this.emit({ type: 'disposed', requestId: message.requestId });
					}
				};
				const synthesisDelay = Number(
					(
						window as unknown as {
							__voicebookTtsDelayMs?: number;
						}
					).__voicebookTtsDelayMs ?? 0
				);
				if (message.type === 'synthesize' && synthesisDelay > 0)
					window.setTimeout(respond, synthesisDelay);
				else queueMicrotask(respond);
			}

			private emit(data: unknown): void {
				for (const listener of this.listeners.message) listener({ data });
			}

			terminate(): void {}
		}

		Object.defineProperty(window, 'Worker', { value: FakeSpeechWorker, configurable: true });
	});
}
