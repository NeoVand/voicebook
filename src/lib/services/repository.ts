import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type {
	AudioVariantMeta,
	ListenedRange,
	NormalizedDocument,
	PlaybackPosition,
	StorageSnapshot,
	StoredAudio
} from '$lib/domain/types';

interface SettingRecord {
	key: string;
	value: unknown;
}

/** The playback pointer and listened ranges change every second or two while
 * listening; documents can be megabytes. Persisting position through this
 * small record keeps the hot path off full-document writes. Full document
 * writes mirror into it so the two never diverge backwards. */
export interface PlaybackRecord {
	documentId: string;
	playback?: PlaybackPosition;
	listened?: Record<string, ListenedRange[]>;
	updatedAt: number;
}

interface VoicebookDb extends DBSchema {
	documents: {
		key: string;
		value: NormalizedDocument;
		indexes: { fingerprint: string; updatedAt: number };
	};
	audio: {
		key: string;
		value: StoredAudio;
		indexes: { documentId: string; segmentId: string };
	};
	settings: {
		key: string;
		value: SettingRecord;
	};
	playback: {
		key: string;
		value: PlaybackRecord;
	};
}

let databasePromise: Promise<IDBPDatabase<VoicebookDb>> | undefined;

function database(): Promise<IDBPDatabase<VoicebookDb>> {
	if (!databasePromise) {
		databasePromise = openDB<VoicebookDb>('voicebook-v1', 2, {
			upgrade(db, oldVersion) {
				if (oldVersion < 1) {
					const documents = db.createObjectStore('documents', { keyPath: 'id' });
					documents.createIndex('fingerprint', 'fingerprint');
					documents.createIndex('updatedAt', 'updatedAt');
					const audio = db.createObjectStore('audio', { keyPath: 'key' });
					audio.createIndex('documentId', 'documentId');
					audio.createIndex('segmentId', 'segmentId');
					db.createObjectStore('settings', { keyPath: 'key' });
				}
				if (oldVersion < 2) {
					db.createObjectStore('playback', { keyPath: 'documentId' });
				}
			}
		});
	}
	return databasePromise;
}

/** Overlay the hot-path playback record when it is at least as fresh as the
 * stored document (equal timestamps come from the mirror write). */
function withPlayback(
	document: NormalizedDocument,
	record: PlaybackRecord | undefined
): NormalizedDocument {
	if (!record || record.updatedAt < document.updatedAt) return document;
	return {
		...document,
		...(record.playback ? { playback: record.playback } : {}),
		...(record.listened ? { listened: record.listened } : {})
	};
}

function safePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
	try {
		return await navigator.storage.getDirectory();
	} catch {
		return null;
	}
}

async function directoryFor(
	path: string,
	create: boolean
): Promise<{ directory: FileSystemDirectoryHandle; name: string } | null> {
	const root = await opfsRoot();
	if (!root) return null;
	const parts = path.split('/').filter(Boolean).map(safePart);
	const name = parts.pop();
	if (!name) return null;
	let directory = root;
	for (const part of parts) {
		directory = await directory.getDirectoryHandle(part, { create });
	}
	return { directory, name };
}

async function writeOpfs(path: string, data: Blob): Promise<boolean> {
	try {
		const target = await directoryFor(path, true);
		if (!target) return false;
		const handle = await target.directory.getFileHandle(target.name, { create: true });
		const writable = await handle.createWritable();
		await writable.write(data);
		await writable.close();
		return true;
	} catch {
		return false;
	}
}

async function readOpfs(path: string): Promise<Blob | null> {
	try {
		const target = await directoryFor(path, false);
		if (!target) return null;
		return await (await target.directory.getFileHandle(target.name)).getFile();
	} catch {
		return null;
	}
}

async function removeOpfs(path: string): Promise<void> {
	try {
		const target = await directoryFor(path, false);
		if (target) await target.directory.removeEntry(target.name);
	} catch {
		// The file may already have been evicted.
	}
}

export async function listDocuments(): Promise<NormalizedDocument[]> {
	const db = await database();
	const [records, playback] = await Promise.all([
		db.getAllFromIndex('documents', 'updatedAt'),
		db.getAll('playback')
	]);
	const playbackById = new Map(playback.map((record) => [record.documentId, record]));
	return records
		.map((record) => withPlayback(record, playbackById.get(record.id)))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDocument(id: string): Promise<NormalizedDocument | undefined> {
	const db = await database();
	const [document, playback] = await Promise.all([db.get('documents', id), db.get('playback', id)]);
	return document && withPlayback(document, playback);
}

export async function getDocumentByFingerprint(
	value: string
): Promise<NormalizedDocument | undefined> {
	return (await database()).getFromIndex('documents', 'fingerprint', value);
}

export async function putDocument(
	document: NormalizedDocument,
	source?: Blob
): Promise<NormalizedDocument> {
	const record: NormalizedDocument = structuredClone(document);
	if (source) {
		const extension = document.sourceName.split('.').pop() ?? 'bin';
		const path = `voicebook/documents/${document.id}/source.${safePart(extension)}`;
		if (await writeOpfs(path, source)) {
			record.sourcePath = path;
			delete record.sourceBlob;
		} else {
			record.sourceBlob = source;
		}
	}
	record.updatedAt = Date.now();
	const db = await database();
	await db.put('documents', record);
	// Mirror so the hot-path record can never be older than the document —
	// a full save (which may clear listened ranges) always wins over a
	// position write from an earlier session.
	await db.put('playback', {
		documentId: record.id,
		playback: record.playback,
		listened: record.listened,
		updatedAt: record.updatedAt
	});
	return record;
}

export async function putPlayback(
	documentId: string,
	playback: PlaybackPosition | undefined,
	listened: Record<string, ListenedRange[]> | undefined
): Promise<void> {
	await (
		await database()
	).put('playback', {
		documentId,
		playback,
		listened,
		updatedAt: Date.now()
	});
}

export async function deleteDocument(id: string): Promise<void> {
	const db = await database();
	const transaction = db.transaction(['documents', 'audio', 'playback'], 'readwrite');
	const audioIndex = transaction.objectStore('audio').index('documentId');
	let cursor = await audioIndex.openCursor(id);
	const paths: string[] = [];
	while (cursor) {
		if (cursor.value.path) paths.push(cursor.value.path);
		await cursor.delete();
		cursor = await cursor.continue();
	}
	await transaction.objectStore('documents').delete(id);
	await transaction.objectStore('playback').delete(id);
	await transaction.done;
	await Promise.all(paths.map(removeOpfs));
	try {
		const root = await opfsRoot();
		const voicebook = await root?.getDirectoryHandle('voicebook');
		const documents = await voicebook?.getDirectoryHandle('documents');
		await documents?.removeEntry(safePart(id), { recursive: true });
	} catch {
		// The source may have been stored in IndexedDB or already evicted.
	}
}

export async function getSource(document: NormalizedDocument): Promise<Blob | null> {
	if (document.sourcePath) return readOpfs(document.sourcePath);
	return document.sourceBlob ?? null;
}

export async function putAudio(meta: AudioVariantMeta, blob: Blob): Promise<StoredAudio> {
	const path = `voicebook/audio/${meta.documentId}/${meta.key}.${blob.type.includes('webm') ? 'webm' : 'wav'}`;
	const opfs = await writeOpfs(path, blob);
	const record: StoredAudio = {
		...meta,
		storage: opfs ? 'opfs' : 'idb',
		path: opfs ? path : undefined,
		blob: opfs ? undefined : blob
	};
	await (await database()).put('audio', record);
	return record;
}

export async function getAudio(key: string): Promise<{ meta: StoredAudio; blob: Blob } | null> {
	const meta = await (await database()).get('audio', key);
	if (!meta) return null;
	const blob =
		meta.storage === 'opfs' && meta.path ? await readOpfs(meta.path) : (meta.blob ?? null);
	if (!blob) {
		await (await database()).delete('audio', key);
		return null;
	}
	return { meta, blob };
}

export async function listAudioVariants(documentId: string): Promise<AudioVariantMeta[]> {
	const records = await (await database()).getAllFromIndex('audio', 'documentId', documentId);
	return records.map((record) => ({
		key: record.key,
		documentId: record.documentId,
		segmentId: record.segmentId,
		modelId: record.modelId,
		modelRevision: record.modelRevision,
		voiceId: record.voiceId,
		generationSteps: record.generationSteps,
		backend: record.backend,
		dtype: record.dtype,
		duration: record.duration,
		mimeType: record.mimeType,
		timing: record.timing,
		createdAt: record.createdAt
	}));
}

/**
 * Purge every stored variant of the given segments. Used when a narration
 * rewrite changes a segment's spoken text: any cached audio for that segment
 * id is stale regardless of voice, backend, or quality settings.
 */
export async function deleteAudioForSegments(
	documentId: string,
	segmentIds: string[]
): Promise<void> {
	if (!segmentIds.length) return;
	const ids = new Set(segmentIds);
	const db = await database();
	const records = (await db.getAllFromIndex('audio', 'documentId', documentId)).filter((record) =>
		ids.has(record.segmentId)
	);
	if (!records.length) return;
	const transaction = db.transaction('audio', 'readwrite');
	await Promise.all(records.map((record) => transaction.store.delete(record.key)));
	await transaction.done;
	await Promise.all(records.flatMap((record) => (record.path ? [removeOpfs(record.path)] : [])));
}

export async function clearGeneratedAudio(documentId?: string): Promise<void> {
	const db = await database();
	const records = documentId
		? await db.getAllFromIndex('audio', 'documentId', documentId)
		: await db.getAll('audio');
	const transaction = db.transaction('audio', 'readwrite');
	await Promise.all(records.map((record) => transaction.store.delete(record.key)));
	await transaction.done;
	await Promise.all(records.flatMap((record) => (record.path ? [removeOpfs(record.path)] : [])));
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
	const record = await (await database()).get('settings', key);
	return (record?.value as T | undefined) ?? fallback;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
	await (await database()).put('settings', { key, value });
}

/**
 * Factory reset: drop Voicebook's entire local footprint — the database
 * (documents, audio, settings including API keys), OPFS files, and every
 * CacheStorage bucket (model weights, app shell). Local preferences such as
 * the theme go too. The caller reloads the app afterwards.
 */
export async function eraseAllData(): Promise<void> {
	try {
		(await database()).close();
	} catch {
		// The database may never have been opened in this session.
	}
	databasePromise = undefined;
	await new Promise<void>((resolve) => {
		const request = indexedDB.deleteDatabase('voicebook-v1');
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
	try {
		const root = await opfsRoot();
		await root?.removeEntry('voicebook', { recursive: true });
	} catch {
		// OPFS may be unavailable or already empty.
	}
	try {
		if (typeof caches !== 'undefined') {
			for (const key of await caches.keys()) await caches.delete(key);
		}
	} catch {
		// CacheStorage may be unavailable (insecure context).
	}
	try {
		localStorage.clear();
	} catch {
		// Storage access can be denied in some embedded contexts.
	}
}

export async function storageSnapshot(): Promise<StorageSnapshot> {
	const estimate = await navigator.storage.estimate();
	return {
		usage: estimate.usage ?? 0,
		quota: estimate.quota ?? 0,
		persisted: await navigator.storage.persisted()
	};
}

export async function requestPersistentStorage(): Promise<boolean> {
	return navigator.storage.persist();
}

export async function reconcileStorage(): Promise<number> {
	const db = await database();
	const records = await db.getAll('audio');
	let removed = 0;
	for (const record of records) {
		if (record.storage === 'opfs' && record.path && !(await readOpfs(record.path))) {
			await db.delete('audio', record.key);
			removed += 1;
		}
	}
	return removed;
}
