export type DocumentKind = 'pdf' | 'docx' | 'markdown' | 'text';
/** How the spoken layer adapts a document for listening. */
export type ListeningMode = 'verbatim' | 'natural' | 'focused';
export type BlockKind =
	| 'heading'
	| 'paragraph'
	| 'list'
	| 'list-item'
	| 'quote'
	| 'alert'
	| 'details'
	| 'definition-list'
	| 'definition-term'
	| 'definition-description'
	| 'code'
	| 'math'
	| 'mermaid'
	| 'footnote'
	| 'html'
	| 'frontmatter'
	| 'table'
	| 'divider'
	| 'page-break';

export type InlineMark =
	'strong' | 'emphasis' | 'delete' | 'code' | 'sub' | 'sup' | 'mark' | 'kbd' | 'abbr';

/** A shape box in a document diagram (Word drawing), in viewBox units. */
export interface DiagramBox {
	shape: 'rect' | 'round' | 'ellipse';
	x: number;
	y: number;
	width: number;
	height: number;
	/** Authored fill, or 'none' for invisible label containers. */
	fill: string;
	stroke: string;
	strokeWidth: number;
	cornerRadius: number;
	lines: string[];
	fontSize: number;
	/** Authored label color — honored only inside filled boxes; floating
	 * labels take the reader theme's ink instead. */
	fontColor: string;
	bold: boolean;
}

export interface DiagramConnector {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	strokeWidth: number;
	arrow: boolean;
}

/** Structured geometry for a Word shape diagram, rendered as theme-aware
 * inline SVG by the reader. */
export interface DocumentDiagram {
	viewBox: { x: number; y: number; width: number; height: number };
	pixelWidth: number;
	pixelHeight: number;
	boxes: DiagramBox[];
	connectors: DiagramConnector[];
}

export interface InlineImage {
	src?: string;
	alt: string;
	title?: string;
	/** Present for Word shape diagrams: the reader renders this instead of a
	 * bitmap, with theme-aware ink. */
	diagram?: DocumentDiagram;
}

export interface InlineProgress {
	value: number;
	max: number;
}

export interface InlineRun {
	text: string;
	marks?: InlineMark[];
	math?: boolean;
	image?: InlineImage;
	progress?: InlineProgress;
	href?: string;
	title?: string;
}

export interface ListMetadata {
	ordered: boolean;
	depth: number;
	index: number;
	start?: number;
	checked?: boolean;
	spread?: boolean;
}

export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export type SafeHtmlTag =
	| 'p'
	| 'div'
	| 'span'
	| 'strong'
	| 'em'
	| 'del'
	| 'sub'
	| 'sup'
	| 'mark'
	| 'kbd'
	| 'abbr'
	| 'a'
	| 'img'
	| 'br'
	| 'table'
	| 'thead'
	| 'tbody'
	| 'tr'
	| 'th'
	| 'td'
	| 'progress';

export type SafeHtmlNode =
	| { type: 'text'; text: string }
	| {
			type: 'element';
			tag: SafeHtmlTag;
			attributes?: Record<string, string | number | boolean>;
			children: SafeHtmlNode[];
	  };

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
	parentId?: string;
	children?: string[];
	level?: number;
	inlines?: InlineRun[];
	list?: ListMetadata;
	alertKind?: AlertKind;
	detailsSummary?: string;
	codeLanguage?: string;
	footnoteId?: string;
	footnoteLabel?: string;
	table?: DocumentTable;
	html?: SafeHtmlNode[];
	speak: boolean;
	anchor: SourceAnchor;
}

export type NarrationConstructKind =
	'math-block' | 'math-inline' | 'mermaid' | 'code-block' | 'table-header' | 'table-row' | 'image';

export type NarrationStatus = 'pending' | 'ready' | 'failed';

/** One construct's LLM-generated narration, persisted with the document. */
export interface NarrationEntry {
	constructId: string;
	kind: NarrationConstructKind;
	status: NarrationStatus;
	/** Speakable prose; present when status === 'ready'. */
	text?: string;
	/** Hash of the construct source — a mismatch invalidates the entry. */
	sourceHash: string;
	modelId?: string;
	promptVersion?: number;
	/** Hash of the prompt (system + template) that produced this narration —
	 * editing a prompt in settings re-queues affected constructs lazily. */
	promptHash?: string;
	/** 'manual' pins a user-edited description: it survives prompt edits and
	 * bulk regeneration, and only source changes or an explicit per-construct
	 * regenerate replace it. Absent means LLM-generated. */
	origin?: 'llm' | 'manual';
	updatedAt: number;
}

/** Set on segments whose spoken text is narration rather than (or substituted
 * into) the displayed text. */
export interface SegmentNarration {
	constructIds: string[];
	/** 'construct' = the whole segment narrates one construct (equation,
	 * diagram, table row); 'inline' = a text sentence with substituted runs. */
	kind: 'construct' | 'inline';
	constructKind?: NarrationConstructKind;
	/** True while a fallback is being spoken and an LLM rewrite is expected. */
	pending: boolean;
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
	narration?: SegmentNarration;
	/** Seconds of silence a human narrator would leave before this passage —
	 * a beat between paragraphs, a longer breath around a heading or figure.
	 * Applied only when arriving here by natural playback, never on a manual
	 * jump or resume. Set on the first segment of each block. */
	pauseBefore?: number;
	/** Set on citation apparatus (references, notes, acknowledgements). Natural
	 * playback announces and skips it; manual navigation still plays it. */
	role?: 'back-matter';
}

export interface OutlineEntry {
	id: string;
	blockId: string;
	title: string;
	level: number;
	/** Source page for PDF bookmarks; shown alongside the entry in the TOC. */
	page?: number;
}

/**
 * Per-page metadata for PDF sources. Sizes the original-page view before
 * pdf.js renders anything, and records which pages came from OCR. Word boxes
 * and text items are deliberately NOT persisted — a future synced page view
 * can recompute them for a single page from the stored source bytes
 * (LiteParse `targetPages` + `emitWordBoxes`) far cheaper than storing them
 * for every document up front.
 */
export interface DocumentPageInfo {
	page: number;
	/** PDF points (1/72 inch), from LiteParse's ParsedPage. */
	width: number;
	height: number;
	/** True when this page's text came from on-device OCR. */
	ocr?: boolean;
}

export interface PlaybackPosition {
	segmentId: string;
	wordIndex: number;
	offset: number;
	updatedAt: number;
}

export interface ListenedRange {
	start: number;
	end: number;
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
	playback?: PlaybackPosition;
	listened?: Record<string, ListenedRange[]>;
	narrations?: Record<string, NarrationEntry>;
	warnings: string[];
	includeCode: boolean;
	/** How the spoken layer adapts this document; absent means the app default
	 * (Natural). Set explicitly by the reader's mode control. */
	listeningMode?: ListeningMode;
	sourcePath?: string;
	sourceBlob?: Blob;
	/** Present for PDF sources parsed since normalization v13. */
	pages?: DocumentPageInfo[];
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
	/** 'supertonic-3' for the on-device engine, or a cloud engine id such as
	 * 'elevenlabs'. */
	modelId: string;
	modelRevision: string;
	voiceId: string;
	generationSteps: number;
	backend: 'webgpu' | 'wasm' | 'cloud';
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
