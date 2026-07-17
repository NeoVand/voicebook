import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { documentFromText } from '$lib/domain/importers';
import type { AudioVariantMeta } from '$lib/domain/types';
import {
	clearGeneratedAudio,
	deleteAudioForSegments,
	deleteDocument,
	getAudio,
	getDocument,
	getDocumentByFingerprint,
	getSetting,
	getSource,
	listAudioVariants,
	listDocuments,
	putAudio,
	putDocument,
	putPlayback,
	reconcileStorage,
	requestPersistentStorage,
	setSetting,
	storageSnapshot
} from './repository';

class MemoryFileHandle {
	blob = new Blob();

	async createWritable() {
		return {
			write: async (data: Blob) => {
				this.blob = data;
			},
			close: async () => undefined
		};
	}

	async getFile(): Promise<File> {
		return new File([this.blob], 'stored-file', { type: this.blob.type });
	}
}

class MemoryDirectoryHandle {
	directories = new Map<string, MemoryDirectoryHandle>();
	files = new Map<string, MemoryFileHandle>();

	async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
		const existing = this.directories.get(name);
		if (existing) return existing;
		if (!options.create) throw new DOMException('Directory missing', 'NotFoundError');
		const directory = new MemoryDirectoryHandle();
		this.directories.set(name, directory);
		return directory;
	}

	async getFileHandle(name: string, options: { create?: boolean } = {}) {
		const existing = this.files.get(name);
		if (existing) return existing;
		if (!options.create) throw new DOMException('File missing', 'NotFoundError');
		const file = new MemoryFileHandle();
		this.files.set(name, file);
		return file;
	}

	async removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name) && !this.directories.delete(name))
			throw new DOMException('Entry missing', 'NotFoundError');
	}
}

const opfsRoot = new MemoryDirectoryHandle();
let opfsEnabled = false;
const storage = {
	getDirectory: async () => {
		if (!opfsEnabled) throw new Error('OPFS unavailable in unit tests');
		return opfsRoot as unknown as FileSystemDirectoryHandle;
	},
	estimate: async () => ({ usage: 1_024, quota: 8_192 }),
	persisted: async () => false,
	persist: async () => true
};

beforeAll(() => {
	Object.defineProperty(globalThis.navigator, 'storage', { value: storage, configurable: true });
});

beforeEach(() => {
	opfsEnabled = false;
});

function audioMeta(documentId: string, key = 'audio-key'): AudioVariantMeta {
	return {
		key,
		documentId,
		segmentId: 'b0:s0',
		modelId: 'supertonic-3',
		modelRevision: 'revision',
		voiceId: 'F1',
		generationSteps: 10,
		backend: 'wasm',
		dtype: 'fp32',
		duration: 1,
		mimeType: 'audio/wav',
		timing: { confidence: 'estimated', words: [{ word: 'Hello', start: 0, end: 1 }] },
		createdAt: Date.now()
	};
}

describe('local repository', () => {
	it('stores documents, source fallbacks, fingerprints, and recency ordering', async () => {
		const first = documentFromText('First', 'Hello first.');
		const second = documentFromText('Second', 'Hello second.');
		const source = new Blob(['source text'], { type: 'text/plain' });
		const savedFirst = await putDocument(first, source);
		await new Promise((resolve) => setTimeout(resolve, 2));
		await putDocument(second);

		expect(savedFirst.sourceBlob).toBeInstanceOf(Blob);
		expect(await getSource(savedFirst)).toEqual(source);
		expect((await getDocument(first.id))?.title).toBe('First');
		expect((await getDocumentByFingerprint(first.fingerprint))?.id).toBe(first.id);
		expect((await listDocuments()).slice(0, 2).map((item) => item.title)).toEqual([
			'Second',
			'First'
		]);

		await deleteDocument(first.id);
		await deleteDocument(second.id);
		expect(await getDocument(first.id)).toBeUndefined();
	});

	it('stores audio in IndexedDB when OPFS is unavailable and cleans by document', async () => {
		const document = documentFromText('Audio', 'Cached speech.');
		await putDocument(document);
		const blob = new Blob(['wave'], { type: 'audio/wav' });
		const stored = await putAudio(audioMeta(document.id), blob);
		expect(stored).toMatchObject({ storage: 'idb', path: undefined });
		expect((await getAudio(stored.key))?.blob).toEqual(blob);
		expect(await listAudioVariants(document.id)).toEqual([
			expect.objectContaining({ key: stored.key, documentId: document.id, voiceId: 'F1' })
		]);
		expect(await listAudioVariants('another-document')).toEqual([]);
		await clearGeneratedAudio(document.id);
		expect(await getAudio(stored.key)).toBeNull();
		await deleteDocument(document.id);
	});

	it('persists playback position without rewriting the document', async () => {
		const document = documentFromText('Position', 'One sentence. Another sentence.');
		const saved = await putDocument(document);
		const segmentId = saved.segments[0].id;

		// A hot-path position write is visible on read without a document write.
		await putPlayback(
			saved.id,
			{ segmentId, wordIndex: 1, offset: 0.4, updatedAt: Date.now() },
			{
				[segmentId]: [{ start: 0, end: 0.4 }]
			}
		);
		const reloaded = await getDocument(saved.id);
		expect(reloaded?.playback).toMatchObject({ segmentId, wordIndex: 1 });
		expect(reloaded?.listened?.[segmentId]).toEqual([{ start: 0, end: 0.4 }]);
		expect((await listDocuments()).find((item) => item.id === saved.id)?.playback).toMatchObject({
			segmentId,
			wordIndex: 1
		});

		// A later full save wins over the older position record (e.g. clearing
		// listened ranges must not be resurrected by the overlay).
		await new Promise((resolve) => setTimeout(resolve, 2));
		const cleared = await putDocument({ ...reloaded!, playback: undefined, listened: {} });
		const afterClear = await getDocument(cleared.id);
		expect(afterClear?.playback).toBeUndefined();
		expect(afterClear?.listened).toEqual({});

		await deleteDocument(saved.id);
		expect(await getDocument(saved.id)).toBeUndefined();
	});

	it('persists settings and reports browser quota state', async () => {
		expect(await getSetting('missing', 'fallback')).toBe('fallback');
		await setSetting('reader-rate', 1.5);
		expect(await getSetting('reader-rate', 1)).toBe(1.5);
		expect(await storageSnapshot()).toEqual({ usage: 1_024, quota: 8_192, persisted: false });
		expect(await requestPersistentStorage()).toBe(true);
		expect(await reconcileStorage()).toBe(0);
	});

	it('uses OPFS for source files and audio, then removes them consistently', async () => {
		opfsEnabled = true;
		const document = documentFromText('OPFS', 'Stored outside IndexedDB.');
		document.sourceName = 'unsafe source?.txt';
		const source = new Blob(['original'], { type: 'text/plain' });
		const saved = await putDocument(document, source);
		expect(saved.sourcePath).toContain('voicebook/documents/');
		expect(saved.sourceBlob).toBeUndefined();
		expect(await getSource(saved)).toEqual(expect.objectContaining({ size: source.size }));

		const opus = new Blob(['opus'], { type: 'audio/webm;codecs=opus' });
		const stored = await putAudio(audioMeta(document.id, 'opfs-audio'), opus);
		expect(stored).toMatchObject({ storage: 'opfs' });
		expect(stored.path).toContain('.webm');
		expect((await getAudio(stored.key))?.blob.size).toBe(opus.size);

		await clearGeneratedAudio();
		expect(await getAudio(stored.key)).toBeNull();
		await deleteDocument(document.id);
	});

	it('purges every variant of a rewritten segment and leaves the rest alone', async () => {
		opfsEnabled = true;
		const document = documentFromText('Rewrites', 'Swap my spoken text.');
		await putDocument(document);
		const rewritten = await putAudio(
			{ ...audioMeta(document.id, 'stale-variant'), segmentId: 'b1:n0' },
			new Blob(['old'], { type: 'audio/wav' })
		);
		const untouched = await putAudio(
			{ ...audioMeta(document.id, 'fresh-variant'), segmentId: 'b2:s0' },
			new Blob(['new'], { type: 'audio/wav' })
		);

		await deleteAudioForSegments(document.id, []);
		expect(await getAudio(rewritten.key)).not.toBeNull();

		await deleteAudioForSegments(document.id, ['b1:n0', 'b9:missing']);
		expect(await getAudio(rewritten.key)).toBeNull();
		expect(await getAudio(untouched.key)).not.toBeNull();

		await deleteAudioForSegments(document.id, ['b9:missing']);
		expect(await getAudio(untouched.key)).not.toBeNull();
		await deleteDocument(document.id);
	});

	it('repairs metadata when an OPFS audio file has been evicted', async () => {
		opfsEnabled = true;
		const document = documentFromText('Repair', 'Repair this cache.');
		await putDocument(document);
		const stored = await putAudio(
			audioMeta(document.id, 'evicted-audio'),
			new Blob(['wave'], { type: 'audio/wav' })
		);
		const parts = stored.path!.split('/');
		const fileName = parts.pop()!;
		let directory = opfsRoot;
		for (const part of parts) directory = await directory.getDirectoryHandle(part);
		await directory.removeEntry(fileName);

		expect(await reconcileStorage()).toBe(1);
		expect(await getAudio(stored.key)).toBeNull();
		expect(await getSource({ ...document, sourcePath: 'voicebook/missing/source.txt' })).toBeNull();
		await deleteDocument(document.id);
	});
});
