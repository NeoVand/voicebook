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
		tagline: 'Strong general rewriting',
		keyPlaceholder: 'sk-proj-…',
		keyUrl: 'https://platform.openai.com/api-keys',
		models: [
			{ id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', tagline: 'fast · recommended' },
			{ id: 'gpt-5.5', label: 'GPT-5.5', tagline: 'highest quality' }
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

export interface ElevenLabsModelSpec {
	id: string;
	label: string;
	tagline: string;
}

/** TTS models that support the with-timestamps endpoint (word highlighting
 * needs character alignment, so v3 alpha is deliberately absent). First entry
 * is the default. */
export const ELEVENLABS_MODELS: ElevenLabsModelSpec[] = [
	{
		id: 'eleven_flash_v2_5',
		label: 'Flash v2.5',
		tagline: 'half the credits · recommended'
	},
	{ id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', tagline: 'fast · half the credits' },
	{
		id: 'eleven_multilingual_v2',
		label: 'Multilingual v2',
		tagline: 'highest quality · double credits'
	}
];

/** George — a warm narrator that suits long-form reading. */
export const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

export interface ElevenLabsVoice {
	id: string;
	name: string;
	/** "male · american · middle aged" style summary from the voice labels. */
	description: string;
	previewUrl?: string;
}

export const PROVIDER_LABELS: Record<ApiProvider, { label: string; vendor: string }> = {
	anthropic: { label: 'Claude', vendor: 'Anthropic' },
	openai: { label: 'GPT', vendor: 'OpenAI' },
	gemini: { label: 'Gemini', vendor: 'Google' },
	elevenlabs: { label: 'ElevenLabs', vendor: 'ElevenLabs' }
};
