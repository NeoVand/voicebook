/**
 * Warm-up for the language model: walk the device cascade and only accept a
 * device after a timed tiny generation actually produces text — a pipeline
 * that loads but can't generate (broken WebGPU adapters do exactly this)
 * falls through instead of shipping a dead feature.
 */
import { llmAttemptCascade, type LlmDeviceCaps, type LlmModelSpec } from '$lib/domain/llm-catalog';
import { getLlmHost, disposeLlmHost, type LlmProgress } from './llm-client';

export interface LlmWarmResult {
	device: 'webgpu' | 'wasm';
	/** Milliseconds the timed tiny generation took on the accepted device. */
	probeMs: number;
}

export interface LlmWarmOptions {
	onProgress?: (p: LlmProgress) => void;
	/** Phase notes for the UI: 'loading (webgpu)', 'warming up (webgpu)'. */
	onPhase?: (phase: string) => void;
	/** First run downloads the weights — generous by default. */
	initTimeoutMs?: number;
	/** First inference compiles GPU kernels — also slow the first time. */
	probeTimeoutMs?: number;
	signal?: AbortSignal;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			}
		);
	});
}

export async function warmLlm(
	spec: LlmModelSpec,
	caps: LlmDeviceCaps,
	opts: LlmWarmOptions = {}
): Promise<LlmWarmResult> {
	const attempts = llmAttemptCascade(spec, caps);
	if (attempts.length === 0) {
		throw new Error(`${spec.label} is not supported on this device.`);
	}
	const initTimeout = opts.initTimeoutMs ?? 600_000;
	const probeTimeout = opts.probeTimeoutMs ?? 120_000;

	let lastError: Error | null = null;
	for (const device of attempts) {
		if (opts.signal?.aborted) throw new Error('Narration model activation cancelled.');
		try {
			opts.onPhase?.(`loading (${device})`);
			const host = getLlmHost({
				model: spec.id,
				dtype: spec.dtype,
				device,
				onProgress: opts.onProgress
			});
			await withTimeout(host.ensureReady(), initTimeout, `${device} init`);

			opts.onPhase?.(`warming up (${device})`);
			const started = performance.now();
			const out = await withTimeout(
				host.generate([{ role: 'user', content: 'Reply with the single word: ok' }], {
					maxNewTokens: 8,
					timeoutMs: probeTimeout,
					signal: opts.signal
				}),
				probeTimeout,
				`${device} warm-up generate`
			);
			if (typeof out !== 'string') throw new Error('warm-up produced no text');
			return { device, probeMs: Math.round(performance.now() - started) };
		} catch (e) {
			lastError = e instanceof Error ? e : new Error(String(e));
			// Drop the failed worker before trying the next device.
			disposeLlmHost();
			if (opts.signal?.aborted) throw lastError;
		}
	}
	throw lastError ?? new Error('No usable device for the narration model.');
}
