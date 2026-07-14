import { describe, expect, it, vi } from 'vitest';
import { createHuggingFaceFetch } from './huggingface-fetch';

vi.mock('@huggingface/hub', () => ({
	downloadFile: vi.fn(async () => new Blob([new Uint8Array([8, 9, 10, 11])]))
}));

describe('createHuggingFaceFetch', () => {
	it('routes pinned Hub files through the Xet-capable downloader', async () => {
		const nativeFetch = vi.fn<typeof fetch>();
		const fetcher = createHuggingFaceFetch(nativeFetch);
		const response = await fetcher(
			'https://huggingface.co/org/model/resolve/abcdef/onnx/model.onnx'
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('4');
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([8, 9, 10, 11]);
		expect(nativeFetch).not.toHaveBeenCalled();
	});

	it('preserves byte-range semantics used by browser model cache probes', async () => {
		const fetcher = createHuggingFaceFetch(vi.fn<typeof fetch>());
		const response = await fetcher(
			'https://huggingface.co/org/model/resolve/abcdef/voices/af_heart.bin',
			{ headers: { Range: 'bytes=1-2' } }
		);

		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 1-2/4');
		expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([9, 10]);
	});

	it('leaves non-Hub requests alone', async () => {
		const expected = new Response('ok');
		const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(expected);
		const fetcher = createHuggingFaceFetch(nativeFetch);

		expect(await fetcher('https://example.com/file.bin')).toBe(expected);
	});
});
