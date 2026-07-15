import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHuggingFaceFetch } from './huggingface-fetch';

const hubMocks = vi.hoisted(() => ({
	downloadFile: vi.fn(),
	pathsInfo: vi.fn()
}));

vi.mock('@huggingface/hub', () => ({
	downloadFile: hubMocks.downloadFile,
	pathsInfo: hubMocks.pathsInfo
}));

describe('createHuggingFaceFetch', () => {
	beforeEach(() => {
		hubMocks.downloadFile.mockReset();
		hubMocks.downloadFile.mockResolvedValue(new Blob([new Uint8Array([8, 9, 10, 11])]));
		hubMocks.pathsInfo.mockReset();
		hubMocks.pathsInfo.mockResolvedValue([]);
	});

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

	it('reuses one lazy Hub asset descriptor across resumable byte ranges', async () => {
		const fetcher = createHuggingFaceFetch(vi.fn<typeof fetch>());
		const url = 'https://huggingface.co/org/model/resolve/abcdef/onnx/model.onnx';

		await (await fetcher(url, { headers: { Range: 'bytes=0-1' } })).arrayBuffer();
		await (await fetcher(url, { headers: { Range: 'bytes=2-3' } })).arrayBuffer();

		expect(hubMocks.downloadFile).toHaveBeenCalledOnce();
	});

	it('leaves non-Hub requests alone', async () => {
		const expected = new Response('ok');
		const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(expected);
		const fetcher = createHuggingFaceFetch(nativeFetch);

		expect(await fetcher('https://example.com/file.bin')).toBe(expected);
	});

	it('repairs mobile metadata probes when Content-Range is not exposed', async () => {
		hubMocks.downloadFile
			.mockRejectedValueOnce(new Error('Expected size information'))
			.mockResolvedValueOnce(new Blob([new Uint8Array([1])]));
		hubMocks.pathsInfo.mockResolvedValueOnce([
			{ path: 'onnx/model.onnx', type: 'file', size: 415_000_000, oid: 'immutable-oid' }
		]);
		const nativeFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(null, {
				status: 200,
				headers: { 'content-type': 'application/octet-stream' }
			})
		);
		const fetcher = createHuggingFaceFetch(nativeFetch);

		await fetcher('https://huggingface.co/org/model/resolve/abcdef/onnx/model.onnx');

		expect(hubMocks.pathsInfo).toHaveBeenCalledOnce();
		expect(hubMocks.downloadFile).toHaveBeenCalledTimes(2);
		const repairedFetch = hubMocks.downloadFile.mock.calls[1]?.[0].fetch as typeof fetch;
		const response = await repairedFetch('https://huggingface.co/org/model/resolve/abcdef/file', {
			headers: { Range: 'bytes=0-0' }
		});
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 0-0/415000000');
		expect(response.headers.get('x-linked-etag')).toBe('immutable-oid');
	});
});
