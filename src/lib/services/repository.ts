import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type {
	AudioVariantMeta,
	NormalizedDocument,
	StorageSnapshot,
	StoredAudio
} from '$lib/domain/types';

interface SettingRecord {
	key: string;
	value: unknown;
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
}

let databasePromise: Promise<IDBPDatabase<VoicebookDb>> | undefined;

function database(): Promise<IDBPDatabase<VoicebookDb>> {
	if (!databasePromise) {
		databasePromise = openDB<VoicebookDb>('voicebook-v1', 1, {
			upgrade(db) {
				const documents = db.createObjectStore('documents', { keyPath: 'id' });
				documents.createIndex('fingerprint', 'fingerprint');
				documents.createIndex('updatedAt', 'updatedAt');
				const audio = db.createObjectStore('audio', { keyPath: 'key' });
				audio.createIndex('documentId', 'documentId');
				audio.createIndex('segmentId', 'segmentId');
				db.createObjectStore('settings', { keyPath: 'key' });
			}
		});
	}
	return databasePromise;
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
	const records = await (await database()).getAllFromIndex('documents', 'updatedAt');
	return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDocument(id: string): Promise<NormalizedDocument | undefined> {
	return (await database()).get('documents', id);
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
	await (await database()).put('documents', record);
	return record;
}

export async function deleteDocument(id: string): Promise<void> {
	const db = await database();
	const transaction = db.transaction(['documents', 'audio'], 'readwrite');
	const audioIndex = transaction.objectStore('audio').index('documentId');
	let cursor = await audioIndex.openCursor(id);
	const paths: string[] = [];
	while (cursor) {
		if (cursor.value.path) paths.push(cursor.value.path);
		await cursor.delete();
		cursor = await cursor.continue();
	}
	await transaction.objectStore('documents').delete(id);
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
