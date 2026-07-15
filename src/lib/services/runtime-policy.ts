export interface BrowserRuntimeIdentity {
	userAgent: string;
	platform?: string;
	hardwareConcurrency?: number;
}

export interface SpeechRuntimePolicy {
	appleMobileWebKit: boolean;
	allowWebGpu: boolean;
	skipWarmup: boolean;
	modelChunkBytes: number | undefined;
	wasmThreads: number | undefined;
}

const MOBILE_MODEL_CHUNK_BYTES = 4 * 1024 * 1024;

export function isAppleMobileWebKit(identity: BrowserRuntimeIdentity): boolean {
	return (
		/\b(iPhone|iPad|iPod)\b/i.test(identity.userAgent) ||
		(/\bMacintosh\b/i.test(identity.userAgent) && /\bMobile\//i.test(identity.userAgent))
	);
}

export function speechRuntimePolicy(identity: BrowserRuntimeIdentity): SpeechRuntimePolicy {
	const appleMobileWebKit = isAppleMobileWebKit(identity);
	return {
		appleMobileWebKit,
		// ONNX Runtime Web does not currently support its WebGPU execution
		// provider in Chrome or Safari on iOS. navigator.gpu alone is therefore
		// not a sufficient capability signal on Apple mobile browsers.
		allowWebGpu: !appleMobileWebKit,
		skipWarmup: appleMobileWebKit,
		modelChunkBytes: appleMobileWebKit ? MOBILE_MODEL_CHUNK_BYTES : undefined,
		wasmThreads: appleMobileWebKit ? 1 : undefined
	};
}

export function currentSpeechRuntimePolicy(): SpeechRuntimePolicy {
	return speechRuntimePolicy({
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		hardwareConcurrency: navigator.hardwareConcurrency
	});
}
