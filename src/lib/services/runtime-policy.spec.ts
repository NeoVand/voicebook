import { describe, expect, it } from 'vitest';
import { isAppleMobileWebKit, speechRuntimePolicy } from './runtime-policy';

describe('speechRuntimePolicy', () => {
	it('forces the true WASM runtime for Chrome and Safari on iPhone', () => {
		const chrome = speechRuntimePolicy({
			userAgent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 CriOS/150.0 Mobile/15E148 Safari/604.1'
		});
		const safari = speechRuntimePolicy({
			userAgent:
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Mobile/15E148 Safari/604.1'
		});

		for (const policy of [chrome, safari]) {
			expect(policy).toMatchObject({
				appleMobileWebKit: true,
				allowWebGpu: false,
				skipWarmup: true,
				modelChunkBytes: 4 * 1024 * 1024,
				wasmThreads: 1
			});
		}
	});

	it('recognizes an iPad requesting a desktop user agent', () => {
		expect(
			isAppleMobileWebKit({
				userAgent:
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
			})
		).toBe(true);
	});

	it('keeps WebGPU eligible on desktop Chromium', () => {
		expect(
			speechRuntimePolicy({
				userAgent:
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0 Safari/537.36'
			})
		).toMatchObject({
			appleMobileWebKit: false,
			allowWebGpu: true,
			skipWarmup: false,
			modelChunkBytes: undefined,
			wasmThreads: undefined
		});
	});
});
