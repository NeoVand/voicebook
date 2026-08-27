/**
 * Premium provider catalog: the bring-your-own-key cloud engines that can
 * replace (or sit beside) the on-device models. Pure data + selection logic —
 * network clients live in services/cloud-llm.ts and services/elevenlabs.ts.
 *
 * Keys are stored only in this browser's IndexedDB and sent only to the
 * provider they belong to.
 */

export type CloudLlmProvider = 'anthropic' | 'openai' | 'gemini';
export type ApiProvider = CloudLlmProvider | 'elevenlabs';

/** Which engine writes the spoken descriptions. */
export type DescriptionEngine = 'local' | CloudLlmProvider;

/** Which cloud engine builds the study tree; 'auto' follows whichever
 * provider has a key (OpenAI first — its fast tier is the tuned default). */
export type StudyEngine = 'auto' | CloudLlmProvider;

/** Auto-pick order for the study engine. */
export const STUDY_PROVIDER_ORDER: CloudLlmProvider[] = ['openai', 'anthropic', 'gemini'];

/** Which engine synthesizes speech. */
export type SpeechEngine = 'local' | 'elevenlabs';

export interface CloudLlmModelSpec {
	/** Provider API model id. */
	id: string;
	label: string;
	tagline: string;
}

export interface CloudLlmProviderSpec {
	id: CloudLlmProvider;
	/** Short product label shown on cards ("Claude"). */
	label: string;
	vendor: string;
	tagline: string;
	keyPlaceholder: string;
	keyUrl: string;
	/** First entry is the default model. */
	models: CloudLlmModelSpec[];
}

export const CLOUD_LLM_PROVIDERS: CloudLlmProviderSpec[] = [
	{
		id: 'anthropic',
		label: 'Claude',
		vendor: 'Anthropic',
		tagline: 'Excellent at faithful, compact descriptions',
		keyPlaceholder: 'sk-ant-…',
		keyUrl: 'https://console.anthropic.com/settings/keys',
		models: [
			{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tagline: 'fast · recommended' },
			{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tagline: 'highest quality' }
		]
	},
	{
		id: 'openai',
		label: 'GPT',
		vendor: 'OpenAI',
		tagline: 'Strong general rewriting · unlocks the voice assistant',
		keyPlaceholder: 'sk-proj-…',
		keyUrl: 'https://platform.openai.com/api-keys',
		models: [
			{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tagline: 'fast · recommended' },
			{ id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', tagline: 'balanced' },
			{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tagline: 'highest quality' }
		]
	},
	{
		id: 'gemini',
		label: 'Gemini',
		vendor: 'Google',
		tagline: 'Fast with a generous free tier',
		keyPlaceholder: 'AQ.… or AIza…',
		keyUrl: 'https://aistudio.google.com/apikey',
		models: [
			{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', tagline: 'fast · recommended' },
			{ id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', tagline: 'fastest' }
		]
	}
];

export function getCloudLlmProvider(id: string): CloudLlmProviderSpec | null {
	return CLOUD_LLM_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function defaultCloudLlmModel(provider: CloudLlmProvider): string {
	return getCloudLlmProvider(provider)?.models[0]?.id ?? '';
}

export function isCloudLlmProvider(value: string): value is CloudLlmProvider {
	return CLOUD_LLM_PROVIDERS.some((provider) => provider.id === value);
}

/* ── ElevenLabs speech ───────────────────────────────────────────────────── */

/** v3 is a different generation with its own controls — grouped in the UI and
 * gated separately when building the request body. */
export type ElevenLabsFamily = 'v3' | 'v2';

/** Which voice_settings a model actually honours. Probed against
 * GET /v1/models (can_use_style, can_use_speaker_boost) and by measuring
 * generated audio — v3 accepts `speed` but ignores it, so it is off here. */
export interface ElevenLabsModelOptionSupport {
	/** v3 exposes three named stability points; v2 takes any 0–1 value. */
	stability: 'discrete' | 'continuous';
	similarity: boolean;
	style: boolean;
	speed: boolean;
	speakerBoost: boolean;
}

export interface ElevenLabsModelSpec {
	id: string;
	label: string;
	tagline: string;
	family: ElevenLabsFamily;
	/** Per-request cap from the model's maximum_text_length_per_request.
	 * Passages are capped far below this; the guard is for safety. */
	maxCharacters: number;
	options: ElevenLabsModelOptionSupport;
}

/** Every TTS model that returns character alignment from the with-timestamps
 * endpoint — word highlighting depends on it, which v3 now supports too.
 * DEFAULT_ELEVENLABS_MODEL, not the array order, picks the default. */
export const ELEVENLABS_MODELS: ElevenLabsModelSpec[] = [
	{
		id: 'eleven_v3',
		label: 'Eleven v3',
		tagline: 'most expressive · 70+ languages',
		family: 'v3',
		maxCharacters: 5_000,
		options: {
			stability: 'discrete',
			similarity: false,
			style: false,
			speed: false,
			speakerBoost: false
		}
	},
	{
		id: 'eleven_v3_conversational',
		label: 'Eleven v3 Conversational',
		tagline: 'expressive · half the credits',
		family: 'v3',
		maxCharacters: 5_000,
		options: {
			stability: 'discrete',
			similarity: false,
			style: false,
			speed: false,
			speakerBoost: true
		}
	},
	{
		id: 'eleven_flash_v2_5',
		label: 'Flash v2.5',
		tagline: 'half the credits · recommended',
		family: 'v2',
		maxCharacters: 40_000,
		options: {
			stability: 'continuous',
			similarity: true,
			style: false,
			speed: true,
			speakerBoost: false
		}
	},
	{
		id: 'eleven_turbo_v2_5',
		label: 'Turbo v2.5',
		tagline: 'fast · half the credits',
		family: 'v2',
		maxCharacters: 40_000,
		options: {
			stability: 'continuous',
			similarity: true,
			style: false,
			speed: true,
			speakerBoost: false
		}
	},
	{
		id: 'eleven_multilingual_v2',
		label: 'Multilingual v2',
		tagline: 'steadiest long-form read',
		family: 'v2',
		maxCharacters: 10_000,
		options: {
			stability: 'continuous',
			similarity: true,
			style: true,
			speed: true,
			speakerBoost: true
		}
	}
];

/** Flash v2.5 stays the default: cheapest per character and the steadiest on
 * the short passages the segmenter produces. v3 is one click away. */
export const DEFAULT_ELEVENLABS_MODEL = 'eleven_flash_v2_5';

export function getElevenLabsModel(id: string): ElevenLabsModelSpec | null {
	return ELEVENLABS_MODELS.find((model) => model.id === id) ?? null;
}

/** The catalog in display order: v3 first, then the v2 generation. */
export const ELEVENLABS_FAMILIES: Array<{
	id: ElevenLabsFamily;
	label: string;
	note: string;
	models: ElevenLabsModelSpec[];
}> = [
	{
		id: 'v3',
		label: 'Eleven v3',
		note: 'Newest generation — richer delivery, more variation between takes.',
		models: ELEVENLABS_MODELS.filter((model) => model.family === 'v3')
	},
	{
		id: 'v2',
		label: 'Eleven v2',
		note: 'Predictable and cheap — the steady choice for a long read.',
		models: ELEVENLABS_MODELS.filter((model) => model.family === 'v2')
	}
];

/** The three stability points the v3 models expose, in ElevenLabs' order. */
export const ELEVENLABS_V3_STABILITY: Array<{
	value: number;
	label: string;
	tagline: string;
}> = [
	{ value: 0, label: 'Creative', tagline: 'most emotion · can drift' },
	{ value: 0.5, label: 'Natural', tagline: 'closest to the voice' },
	{ value: 1, label: 'Robust', tagline: 'steadiest · least directable' }
];

/** Per-model synthesis knobs. Values match the ElevenLabs defaults, so an
 * untouched set is indistinguishable from sending nothing. */
export interface ElevenLabsVoiceOptions {
	stability: number;
	similarity: number;
	style: number;
	speed: number;
	speakerBoost: boolean;
}

export const DEFAULT_ELEVENLABS_OPTIONS: ElevenLabsVoiceOptions = {
	stability: 0.5,
	similarity: 0.75,
	style: 0,
	speed: 1,
	speakerBoost: true
};

/** Snap to the nearest of the three v3 stability points. */
function snapStability(value: number): number {
	return ELEVENLABS_V3_STABILITY.reduce((best, point) =>
		Math.abs(point.value - value) < Math.abs(best.value - value) ? point : best
	).value;
}

function clamp(value: number, low: number, high: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(high, Math.max(low, value));
}

/**
 * Fill in and clamp a stored option set for one model. Knobs the model does
 * not honour are forced back to their default so they can never leak into a
 * request (or into the cache signature) for a model that ignores them.
 */
export function normalizeElevenLabsOptions(
	model: ElevenLabsModelSpec,
	stored?: Partial<ElevenLabsVoiceOptions> | null
): ElevenLabsVoiceOptions {
	const raw = { ...DEFAULT_ELEVENLABS_OPTIONS, ...(stored ?? {}) };
	const stability = clamp(raw.stability, 0, 1, DEFAULT_ELEVENLABS_OPTIONS.stability);
	const support = model.options;
	return {
		stability: support.stability === 'discrete' ? snapStability(stability) : stability,
		similarity: support.similarity
			? clamp(raw.similarity, 0, 1, DEFAULT_ELEVENLABS_OPTIONS.similarity)
			: DEFAULT_ELEVENLABS_OPTIONS.similarity,
		style: support.style ? clamp(raw.style, 0, 1, DEFAULT_ELEVENLABS_OPTIONS.style) : 0,
		speed: support.speed ? clamp(raw.speed, 0.7, 1.2, DEFAULT_ELEVENLABS_OPTIONS.speed) : 1,
		speakerBoost: support.speakerBoost
			? Boolean(raw.speakerBoost)
			: DEFAULT_ELEVENLABS_OPTIONS.speakerBoost
	};
}

export function isDefaultElevenLabsOptions(options: ElevenLabsVoiceOptions): boolean {
	return (
		options.stability === DEFAULT_ELEVENLABS_OPTIONS.stability &&
		options.similarity === DEFAULT_ELEVENLABS_OPTIONS.similarity &&
		options.style === DEFAULT_ELEVENLABS_OPTIONS.style &&
		options.speed === DEFAULT_ELEVENLABS_OPTIONS.speed &&
		options.speakerBoost === DEFAULT_ELEVENLABS_OPTIONS.speakerBoost
	);
}

/** The voice_settings body, or undefined to let the voice's own saved
 * settings apply — which is what an untouched set has always meant, so
 * audio cached before these controls existed still matches. */
export function elevenLabsVoiceSettings(
	model: ElevenLabsModelSpec,
	options: ElevenLabsVoiceOptions
): Record<string, number | boolean> | undefined {
	const normalized = normalizeElevenLabsOptions(model, options);
	if (isDefaultElevenLabsOptions(normalized)) return undefined;
	const settings: Record<string, number | boolean> = { stability: normalized.stability };
	if (model.options.similarity) settings.similarity_boost = normalized.similarity;
	if (model.options.style) settings.style = normalized.style;
	if (model.options.speed) settings.speed = normalized.speed;
	if (model.options.speakerBoost) settings.use_speaker_boost = normalized.speakerBoost;
	return settings;
}

/**
 * Cache-key fragment for a model plus its options: the bare model id while the
 * options are untouched (so audio generated before the controls shipped keeps
 * matching), and a stable suffix once any knob moves.
 */
export function elevenLabsRevision(
	model: ElevenLabsModelSpec,
	options: ElevenLabsVoiceOptions
): string {
	const settings = elevenLabsVoiceSettings(model, options);
	if (!settings) return model.id;
	const suffix = Object.keys(settings)
		.sort()
		.map((key) => `${key}=${settings[key]}`)
		.join(',');
	return `${model.id}#${suffix}`;
}

/** George — a warm narrator that suits long-form reading. */
export const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

export interface ElevenLabsVoice {
	id: string;
	name: string;
	/** "male · american · middle aged" style summary from the voice labels. */
	description: string;
	previewUrl?: string;
}

/* ── OpenAI realtime voice assistant ─────────────────────────────────────── */

export interface RealtimeModelSpec {
	id: string;
	label: string;
	tagline: string;
}

/** Speech-to-speech models for the voice assistant (uses the OpenAI key).
 * First entry is the default. */
export const REALTIME_MODELS: RealtimeModelSpec[] = [
	{ id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1', tagline: 'best quality · recommended' },
	{ id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini', tagline: 'faster · cheaper' }
];

export interface RealtimeVoiceSpec {
	id: string;
	label: string;
	/** A short character note, shown under the name in pickers. */
	tagline: string;
	/** OpenAI's conversation-tuned picks, shown with a badge. */
	recommended?: boolean;
}

/** Every voice the realtime endpoint accepts (probed from the API's own
 * validation error). Marin and cedar are the newest, tuned for
 * conversation. The same ids work on the speech endpoint, which is what
 * voice previews use. */
export const REALTIME_VOICES: RealtimeVoiceSpec[] = [
	{ id: 'marin', label: 'Marin', tagline: 'Warm, natural guide', recommended: true },
	{ id: 'cedar', label: 'Cedar', tagline: 'Deep and grounded', recommended: true },
	{ id: 'alloy', label: 'Alloy', tagline: 'Even, neutral read' },
	{ id: 'ash', label: 'Ash', tagline: 'Warm and steady' },
	{ id: 'ballad', label: 'Ballad', tagline: 'Soft storyteller' },
	{ id: 'coral', label: 'Coral', tagline: 'Upbeat energy' },
	{ id: 'echo', label: 'Echo', tagline: 'Clear and direct' },
	{ id: 'sage', label: 'Sage', tagline: 'Calm and gentle' },
	{ id: 'shimmer', label: 'Shimmer', tagline: 'Light and bright' },
	{ id: 'verse', label: 'Verse', tagline: 'Expressive range' }
];

/** Marin — the voice OpenAI recommends for natural conversation. */
export const DEFAULT_REALTIME_VOICE = 'marin';

export type RealtimeEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** session.reasoning.effort values, in effort order. */
export const REALTIME_EFFORTS: Array<{ id: RealtimeEffort; label: string }> = [
	{ id: 'minimal', label: 'Min' },
	{ id: 'low', label: 'Low' },
	{ id: 'medium', label: 'Med' },
	{ id: 'high', label: 'High' },
	{ id: 'xhigh', label: 'Max' }
];

/** Low keeps answers snappy — the docs' recommendation for voice agents. */
export const DEFAULT_REALTIME_EFFORT: RealtimeEffort = 'low';

export function isRealtimeEffort(value: string): value is RealtimeEffort {
	return REALTIME_EFFORTS.some((effort) => effort.id === value);
}

export const PROVIDER_LABELS: Record<ApiProvider, { label: string; vendor: string }> = {
	anthropic: { label: 'Claude', vendor: 'Anthropic' },
	openai: { label: 'GPT', vendor: 'OpenAI' },
	gemini: { label: 'Gemini', vendor: 'Google' },
	elevenlabs: { label: 'ElevenLabs', vendor: 'ElevenLabs' }
};
