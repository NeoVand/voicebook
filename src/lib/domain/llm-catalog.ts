/**
 * The narration LLM catalog and pure device/selection logic. Nothing here
 * touches the network or the GPU — capability probing that actually loads a
 * model lives in services/llm/llm-runtime.ts (never trust a load without a
 * timed tiny generation). Kept separate from the speech-engine catalog on
 * purpose: the TTS machinery is typed to a single model id, and the two model
 * tracks have independent lifecycles.
 */

export interface LlmModelSpec {
	id: string;
	/** Short human label ("LFM2.5 1.2B"). */
	label: string;
	dtype: 'q4f16';
	/** Approximate download size of the q4f16 weights, in MB. */
	sizeMb: number;
	/** True when wasm is too slow / memory-hungry to be worth offering. Both
	 * narration models set this: 1–5 tok/s on CPU while fighting the speech
	 * engine for cores is not viable as a background feature. */
	requiresWebGpu: boolean;
	recommendedRamGb: number;
	/** One-line card copy after the size. */
	tagline: string;
	/** Weight license shown on the model card. */
	license: string;
	licenseUrl: string;
}

export const DEFAULT_LLM_ID = 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX';
export const QUALITY_LLM_ID = 'onnx-community/Qwen3.5-2B-ONNX';

export const LLM_CATALOG: LlmModelSpec[] = [
	{
		// Single q4f16 decoder (760 MB). Fast, instruction-reliable at this
		// size, and the default because it fits comfortably next to the
		// speech engine on mid-range GPUs.
		id: DEFAULT_LLM_ID,
		label: 'LFM2.5 1.2B',
		dtype: 'q4f16',
		sizeMb: 760,
		requiresWebGpu: true,
		recommendedRamGb: 6,
		tagline: 'fast · recommended',
		license: 'LFM Open License v1.0',
		licenseUrl: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-ONNX'
	},
	{
		// Multimodal repo (decoder + embed_tokens + vision_encoder). The
		// text-generation pipeline skips the vision files.
		id: QUALITY_LLM_ID,
		label: 'Qwen3.5 2B',
		dtype: 'q4f16',
		sizeMb: 1330,
		requiresWebGpu: true,
		recommendedRamGb: 8,
		tagline: 'richer descriptions · for 8 GB+ GPUs',
		license: 'Apache 2.0',
		licenseUrl: 'https://huggingface.co/onnx-community/Qwen3.5-2B-ONNX'
	}
];

export function getLlmModel(id: string): LlmModelSpec | null {
	return LLM_CATALOG.find((m) => m.id === id) ?? null;
}

export interface LlmDeviceCaps {
	webgpu: boolean;
	/** navigator.deviceMemory (Chrome caps it at 8); null when unavailable. */
	ramGb: number | null;
}

export interface LlmModelGate {
	ok: boolean;
	reason?: string;
}

/** Can this model be OFFERED on this device? (The warm-up probe still decides.) */
export function canRunLlmModel(spec: LlmModelSpec, caps: LlmDeviceCaps): LlmModelGate {
	if (spec.requiresWebGpu && !caps.webgpu) {
		return { ok: false, reason: 'needs WebGPU, which this browser does not expose' };
	}
	if (caps.ramGb !== null && caps.ramGb < spec.recommendedRamGb / 2) {
		return { ok: false, reason: `needs about ${spec.recommendedRamGb} GB of memory` };
	}
	return { ok: true };
}

/**
 * Device attempt cascade for the warm-up probe: WebGPU first when exposed,
 * wasm as the fallback — unless the model is WebGPU-only (all current
 * narration models are; the wasm branch stays for future catalog entries).
 */
export function llmAttemptCascade(spec: LlmModelSpec, caps: LlmDeviceCaps): ('webgpu' | 'wasm')[] {
	if (spec.requiresWebGpu) return caps.webgpu ? ['webgpu'] : [];
	return caps.webgpu ? ['webgpu', 'wasm'] : ['wasm'];
}
