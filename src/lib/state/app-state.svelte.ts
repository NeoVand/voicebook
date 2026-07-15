import { MODEL_CATALOG, getModel } from '$lib/domain/model-catalog';
import {
	DOCUMENT_NORMALIZATION_VERSION,
	documentFromText,
	fingerprint,
	importFile
} from '$lib/domain/importers';
import { refreshDocumentSegments, segmentBlocks } from '$lib/domain/segmenter';
import { DEFAULT_GENERATION_STEPS, normalizeGenerationSteps } from '$lib/domain/synthesis';
import type {
	DeviceCapabilities,
	ModelDescriptor,
	NormalizedDocument,
	StorageSnapshot
} from '$lib/domain/types';
import {
	clearGeneratedAudio,
	deleteDocument as deleteStoredDocument,
	getDocumentByFingerprint,
	getSource,
	getSetting,
	listDocuments,
	putDocument,
	reconcileStorage,
	requestPersistentStorage,
	setSetting,
	storageSnapshot
} from '$lib/services/repository';
import { ttsClient } from '$lib/services/tts-client';
import { clearLegacyModelAssets, clearPinnedModelAssets } from '$lib/services/model-asset-cache';
import { recoverInterruptedRuntimeOperation } from '$lib/services/runtime-diagnostics';

interface DuplicateImport {
	file: File;
	existing: NormalizedDocument;
}

interface ModelProgress {
	status: 'idle' | 'loading' | 'ready' | 'error';
	progress: number;
	file?: string;
	message?: string;
}

interface ModelLoadUpdate {
	status: string;
	progress: number;
	file?: string;
}

const EMPTY_STORAGE: StorageSnapshot = { usage: 0, quota: 0, persisted: false };
const EMPTY_CAPABILITIES: DeviceCapabilities = {
	webgpu: false,
	shaderF16: false,
	webCodecs: false,
	opfs: false,
	backend: 'wasm'
};

function findMigratedSegment(
	previous: NormalizedDocument,
	migrated: NormalizedDocument,
	segmentId: string,
	excerpt = ''
) {
	const oldSegment = previous.segments.find((segment) => segment.id === segmentId);
	const sameId = migrated.segments.find((segment) => segment.id === segmentId);
	if (sameId && (!oldSegment || sameId.normalizedText === oldSegment.normalizedText)) return sameId;
	if (oldSegment) {
		const sameText = migrated.segments.find(
			(segment) => segment.normalizedText === oldSegment.normalizedText
		);
		if (sameText) return sameText;
	}
	const normalizedExcerpt = excerpt.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
	return normalizedExcerpt
		? migrated.segments.find((segment) =>
				segment.normalizedText.toLocaleLowerCase().includes(normalizedExcerpt)
			)
		: undefined;
}

async function migrateDocumentNormalization(
	document: NormalizedDocument
): Promise<NormalizedDocument> {
	if (document.normalizationVersion === DOCUMENT_NORMALIZATION_VERSION) return document;
	if (document.sourceKind !== 'markdown') {
		return { ...document, normalizationVersion: DOCUMENT_NORMALIZATION_VERSION };
	}
	const source = await getSource(document);
	if (!source) return document;
	try {
		const reparsed = await importFile(
			new File([source], document.sourceName, { type: document.mimeType })
		);
		reparsed.includeCode = document.includeCode;
		reparsed.segments = segmentBlocks(reparsed.blocks, reparsed.includeCode);
		reparsed.id = document.id;
		reparsed.fingerprint = document.fingerprint;
		reparsed.createdAt = document.createdAt;
		reparsed.updatedAt = document.updatedAt;
		reparsed.sourcePath = document.sourcePath;
		reparsed.sourceBlob = document.sourceBlob;
		reparsed.bookmarks = document.bookmarks.map((bookmark) => {
			const segment = findMigratedSegment(document, reparsed, bookmark.segmentId, bookmark.excerpt);
			return segment
				? {
						...bookmark,
						segmentId: segment.id,
						wordIndex: Math.min(bookmark.wordIndex, Math.max(0, segment.words.length - 1))
					}
				: bookmark;
		});
		if (document.playback) {
			const segment = findMigratedSegment(document, reparsed, document.playback.segmentId);
			reparsed.playback = segment
				? {
						...document.playback,
						segmentId: segment.id,
						wordIndex: Math.min(document.playback.wordIndex, Math.max(0, segment.words.length - 1))
					}
				: document.playback;
		}
		return reparsed;
	} catch {
		return document;
	}
}

export class VoicebookState {
	private initialization?: Promise<void>;
	documents = $state<NormalizedDocument[]>([]);
	initialized = $state(false);
	importing = $state(false);
	statusMessage = $state('Preparing your private library…');
	errorMessage = $state('');
	runtimeNotice = $state('');
	duplicate = $state<DuplicateImport | null>(null);
	capabilities = $state<DeviceCapabilities>(EMPTY_CAPABILITIES);
	storage = $state<StorageSnapshot>(EMPTY_STORAGE);
	selectedModelId = $state<ModelDescriptor['id']>('supertonic-3');
	selectedVoiceId = $state('F1');
	generationSteps = $state(DEFAULT_GENERATION_STEPS);
	installedModels = $state<ModelDescriptor['id'][]>([]);
	acceptedLicenses = $state<string[]>([]);
	modelProgress = $state<Record<string, ModelProgress>>({
		'supertonic-3': { status: 'idle', progress: 0 }
	});

	get selectedModel(): ModelDescriptor {
		return getModel(this.selectedModelId);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialization ??= this.openLibrary();
		await this.initialization;
	}

	private async openLibrary(): Promise<void> {
		try {
			const interrupted = recoverInterruptedRuntimeOperation();
			if (interrupted) {
				this.runtimeNotice =
					interrupted.operation === 'model-load'
						? 'The previous page ended while the voice engine was loading. The resumable download is safe; local diagnostics were saved under System settings.'
						: 'The previous page ended during speech generation. Voicebook saved local diagnostics, and the inference memory has been reset.';
				this.errorMessage = this.runtimeNotice;
			}
			await clearLegacyModelAssets();
			const [
				documents,
				modelId,
				voiceId,
				generationSteps,
				installed,
				accepted,
				capabilities,
				storage
			] = await Promise.all([
				listDocuments(),
				getSetting<string>('selected-model', 'supertonic-3'),
				getSetting('selected-voice', 'F1'),
				getSetting('generation-steps', DEFAULT_GENERATION_STEPS),
				getSetting<ModelDescriptor['id'][]>('installed-models', []),
				getSetting<string[]>('accepted-licenses', []),
				ttsClient.capabilities(),
				storageSnapshot()
			]);
			const normalizedDocuments = await Promise.all(documents.map(migrateDocumentNormalization));
			const refreshedDocuments = normalizedDocuments.map(refreshDocumentSegments);
			this.documents = refreshedDocuments;
			await Promise.all(
				refreshedDocuments.map((document, index) =>
					document === documents[index]
						? Promise.resolve()
						: putDocument(document).then(() => undefined)
				)
			);
			const migratedModelId = 'supertonic-3' as const;
			this.selectedModelId = migratedModelId;
			this.selectedVoiceId = getModel(migratedModelId).voices.some((voice) => voice.id === voiceId)
				? voiceId
				: getModel(migratedModelId).defaultVoice;
			this.generationSteps = normalizeGenerationSteps(generationSteps);
			// Retired engine caches are legacy state. Only an explicit V3 installation
			// is considered runnable by the current four-session engine.
			this.installedModels = installed.filter((id) => (id as string) === 'supertonic-3');
			this.acceptedLicenses = accepted.filter((id) => id === 'supertonic-3');
			this.capabilities = capabilities;
			this.storage = storage;
			for (const id of this.installedModels)
				this.modelProgress[id] = { status: 'ready', progress: 100 };
			if (
				modelId !== migratedModelId ||
				installed.length !== this.installedModels.length ||
				generationSteps !== this.generationSteps
			) {
				await Promise.all([
					setSetting('selected-model', migratedModelId),
					setSetting('selected-voice', this.selectedVoiceId),
					setSetting('generation-steps', this.generationSteps),
					setSetting('installed-models', [...this.installedModels])
				]);
			}
			await reconcileStorage();
			this.statusMessage = '';
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : 'Voicebook could not open its local library.';
		} finally {
			this.initialized = true;
		}
	}

	private async addImportedDocument(
		document: NormalizedDocument,
		source?: Blob
	): Promise<NormalizedDocument> {
		const saved = await putDocument(document, source);
		this.documents = [saved, ...this.documents.filter((candidate) => candidate.id !== saved.id)];
		this.storage = await storageSnapshot();
		if (!this.storage.persisted && this.documents.length === 1) {
			await requestPersistentStorage();
			this.storage = await storageSnapshot();
		}
		return saved;
	}

	async importFiles(files: File[]): Promise<NormalizedDocument[]> {
		if (!files.length) return [];
		this.importing = true;
		this.errorMessage = '';
		const imported: NormalizedDocument[] = [];
		try {
			for (const file of files) {
				this.statusMessage = `Reading ${file.name}…`;
				const hash = await fingerprint(file);
				const existing = await getDocumentByFingerprint(hash);
				if (existing) {
					this.duplicate = { file, existing };
					continue;
				}
				const document = await importFile(file);
				imported.push(await this.addImportedDocument(document, file));
			}
			this.statusMessage = imported.length
				? `${imported.length} ${imported.length === 1 ? 'document' : 'documents'} added.`
				: '';
			return imported;
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : 'The document could not be imported.';
			return imported;
		} finally {
			this.importing = false;
		}
	}

	async importDuplicateCopy(): Promise<NormalizedDocument | null> {
		if (!this.duplicate) return null;
		const { file } = this.duplicate;
		this.duplicate = null;
		try {
			const document = await importFile(file);
			document.title = `${document.title} — Copy`;
			document.fingerprint = `${document.fingerprint}:${document.id}`;
			return await this.addImportedDocument(document, file);
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : 'The duplicate could not be imported.';
			return null;
		}
	}

	async addPastedText(title: string, text: string): Promise<NormalizedDocument | null> {
		if (!text.trim()) return null;
		try {
			const document = documentFromText(title, text);
			return await this.addImportedDocument(
				document,
				new Blob([text], { type: document.mimeType })
			);
		} catch (error) {
			this.errorMessage =
				error instanceof Error ? error.message : 'The pasted text could not be saved.';
			return null;
		}
	}

	async saveDocument(document: NormalizedDocument): Promise<void> {
		const saved = await putDocument($state.snapshot(document));
		this.documents = this.documents.map((candidate) =>
			candidate.id === saved.id ? saved : candidate
		);
	}

	async deleteDocument(id: string): Promise<void> {
		await deleteStoredDocument(id);
		this.documents = this.documents.filter((document) => document.id !== id);
		this.storage = await storageSnapshot();
	}

	async selectModel(id: ModelDescriptor['id']): Promise<void> {
		this.selectedModelId = id;
		this.selectedVoiceId = getModel(id).defaultVoice;
		await Promise.all([
			setSetting('selected-model', id),
			setSetting('selected-voice', this.selectedVoiceId)
		]);
	}

	async selectVoice(id: string): Promise<void> {
		if (!this.selectedModel.voices.some((voice) => voice.id === id)) return;
		this.selectedVoiceId = id;
		await setSetting('selected-voice', id);
	}

	async setGenerationSteps(value: number): Promise<void> {
		const next = normalizeGenerationSteps(value);
		if (next === this.generationSteps) return;
		await setSetting('generation-steps', next);
		this.generationSteps = next;
	}

	async setLicenseAcceptance(modelId: ModelDescriptor['id'], accepted: boolean): Promise<void> {
		this.acceptedLicenses = accepted
			? this.acceptedLicenses.includes(modelId)
				? [...this.acceptedLicenses]
				: [...this.acceptedLicenses, modelId]
			: this.acceptedLicenses.filter((id) => id !== modelId);
		await setSetting('accepted-licenses', [...this.acceptedLicenses]);
	}

	async acceptLicense(modelId: ModelDescriptor['id']): Promise<void> {
		await this.setLicenseAcceptance(modelId, true);
	}

	async installModel(
		modelId: ModelDescriptor['id'],
		backend: 'auto' | 'webgpu' | 'wasm' = 'auto',
		onProgress?: (update: ModelLoadUpdate) => void
	): Promise<void> {
		const model = getModel(modelId);
		if (model.license === 'OpenRAIL-M' && !this.acceptedLicenses.includes(modelId)) {
			throw new Error('Review and accept the OpenRAIL license before installing this model.');
		}
		this.modelProgress[modelId] = {
			status: 'loading',
			progress: 0,
			message: 'Preparing model files…'
		};
		try {
			// Ask while this method is still reached from the user's install gesture.
			// Unsupported browsers simply continue with their normal origin quota.
			try {
				if (!(await navigator.storage.persisted())) await requestPersistentStorage();
			} catch {
				// Persistence is an optimization; resumable chunks still work without it.
			}
			await ttsClient.load(modelId, backend, (update) => {
				onProgress?.(update);
				this.modelProgress[modelId] = {
					status: 'loading',
					progress: update.progress,
					file: update.file,
					message:
						update.status === 'progress'
							? 'Downloading securely from Hugging Face…'
							: 'Initializing the local model…'
				};
			});
			if (!this.installedModels.includes(modelId))
				this.installedModels = [...this.installedModels, modelId];
			this.modelProgress[modelId] = {
				status: 'ready',
				progress: 100,
				message: `Ready on ${ttsClient.backend.toUpperCase()}`
			};
			onProgress?.({ status: 'Saving the local installation…', progress: 100 });
			await setSetting('installed-models', [...this.installedModels]);
			this.storage = await storageSnapshot();
			onProgress?.({ status: 'Voice engine ready.', progress: 100 });
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				this.modelProgress[modelId] = this.installedModels.includes(modelId)
					? { status: 'ready', progress: 100, message: 'Ready to resume' }
					: { status: 'idle', progress: 0 };
				throw error;
			}
			this.modelProgress[modelId] = {
				status: 'error',
				progress: 0,
				message: error instanceof Error ? error.message : 'The model could not be installed.'
			};
			throw error;
		} finally {
			try {
				this.storage = await storageSnapshot();
			} catch {
				// Keep the original install result if a browser cannot estimate storage.
			}
		}
	}

	cancelModelInstall(modelId: ModelDescriptor['id']): void {
		ttsClient.cancelAll();
		this.modelProgress[modelId] = this.installedModels.includes(modelId)
			? { status: 'ready', progress: 100, message: 'Ready' }
			: { status: 'idle', progress: 0 };
	}

	async removeModel(modelId: ModelDescriptor['id']): Promise<void> {
		const model = getModel(modelId);
		if (ttsClient.modelId === modelId) await ttsClient.dispose();
		await clearPinnedModelAssets(model);
		this.installedModels = this.installedModels.filter((id) => id !== modelId);
		this.modelProgress[modelId] = { status: 'idle', progress: 0 };
		await setSetting('installed-models', [...this.installedModels]);
		this.storage = await storageSnapshot();
	}

	async clearAudio(documentId?: string): Promise<void> {
		await clearGeneratedAudio(documentId);
		this.storage = await storageSnapshot();
	}

	async refreshStorage(): Promise<void> {
		this.storage = await storageSnapshot();
	}

	clearError(): void {
		this.errorMessage = '';
	}

	clearRuntimeNotice(): void {
		this.runtimeNotice = '';
	}
}

export const appState = new VoicebookState();
export { MODEL_CATALOG };
