export type DocumentKind = 'pdf' | 'docx' | 'markdown' | 'text';
export type BlockKind =
	| 'heading'
	| 'paragraph'
	| 'list-item'
	| 'quote'
	| 'code'
	| 'math'
	| 'footnote'
	| 'frontmatter'
	| 'table'
	| 'divider'
	| 'page-break';

export type InlineMark = 'strong' | 'emphasis' | 'delete' | 'code';

export interface InlineRun {
	text: string;
	marks?: InlineMark[];
	math?: boolean;
	href?: string;
	title?: string;
}

export interface ListMetadata {
	ordered: boolean;
	depth: number;
	index: number;
	start?: number;
	checked?: boolean;
}

export type TableAlignment = 'left' | 'center' | 'right' | null;

export interface TableCell {
	text: string;
	inlines: InlineRun[];
}

export interface DocumentTable {
	align: TableAlignment[];
	header: TableCell[];
	rows: TableCell[][];
}

export interface SourceAnchor {
	page?: number;
	path?: string;
	start?: number;
	end?: number;
}

export interface WordSpan {
	text: string;
	start: number;
	end: number;
}

export interface DocumentBlock {
	id: string;
	kind: BlockKind;
	text: string;
	level?: number;
	inlines?: InlineRun[];
	list?: ListMetadata;
	codeLanguage?: string;
	footnoteId?: string;
	footnoteLabel?: string;
	table?: DocumentTable;
	speak: boolean;
	anchor: SourceAnchor;
}

export interface SpeechSegment {
	id: string;
	blockId: string;
	text: string;
	normalizedText: string;
	start: number;
	end: number;
	words: WordSpan[];
	estimatedDuration: number;
	anchor: SourceAnchor;
}

export interface OutlineEntry {
	id: string;
	blockId: string;
	title: string;
	level: number;
}

export interface PlaybackPosition {
	segmentId: string;
	wordIndex: number;
	offset: number;
	updatedAt: number;
}

export interface Bookmark {
	id: string;
	documentId: string;
	segmentId: string;
	wordIndex: number;
	excerpt: string;
	label: string;
	note: string;
	createdAt: number;
}

export interface NormalizedDocument {
	normalizationVersion?: number;
	id: string;
	fingerprint: string;
	title: string;
	sourceName: string;
	sourceKind: DocumentKind;
	mimeType: string;
	language: string;
	createdAt: number;
	updatedAt: number;
	blocks: DocumentBlock[];
	segments: SpeechSegment[];
	outline: OutlineEntry[];
	bookmarks: Bookmark[];
	playback?: PlaybackPosition;
	warnings: string[];
	includeCode: boolean;
	sourcePath?: string;
	sourceBlob?: Blob;
}

export type TimingConfidence = 'native' | 'estimated';

export interface WordTiming {
	word: string;
	start: number;
	end: number;
}

export interface TimingMap {
	confidence: TimingConfidence;
	words: WordTiming[];
}

export interface VoiceDescriptor {
	id: string;
	name: string;
	language: string;
	gender?: string;
	sampleUrl?: string;
}

export type ModelLicense = 'Apache-2.0' | 'OpenRAIL-M';

export interface ModelDescriptor {
	id: 'supertonic-3';
	name: string;
	repository: string;
	revision: string;
	license: ModelLicense;
	licenseUrl: string;
	description: string;
	sizeMb: number;
	languages: string[];
	voices: VoiceDescriptor[];
	defaultVoice: string;
	supportsWebGpu: boolean;
	supportsWasm: boolean;
	nativeTiming: 'phoneme' | 'none';
	voiceCloning: boolean;
}

export interface AudioVariantMeta {
	key: string;
	documentId: string;
	segmentId: string;
	modelId: ModelDescriptor['id'];
	modelRevision: string;
	voiceId: string;
	generationSteps: number;
	backend: 'webgpu' | 'wasm';
	dtype: string;
	duration: number;
	mimeType: string;
	timing: TimingMap;
	createdAt: number;
}

export interface StoredAudio extends AudioVariantMeta {
	storage: 'opfs' | 'idb';
	path?: string;
	blob?: Blob;
}

export interface StorageSnapshot {
	usage: number;
	quota: number;
	persisted: boolean;
}

export interface DeviceCapabilities {
	webgpu: boolean;
	shaderF16: boolean;
	webCodecs: boolean;
	opfs: boolean;
	backend: 'webgpu' | 'wasm';
}
