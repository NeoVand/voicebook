/**
 * Bring-your-own-key provider state: API keys, the description-engine and
 * speech-engine selections, and the ElevenLabs voice/model choices. Keys are
 * persisted only in this browser's IndexedDB settings store and are sent
 * only to the provider they belong to.
 *
 * In dev builds, keys can be pre-seeded from a gitignored .env
 * (VITE_DEV_*_API_KEY) so the premium paths are testable without typing
 * secrets into the UI; those dev keys are never persisted and the production
 * bundle contains none of this (the DEV branch is compiled out).
 */
import {
	DEFAULT_ELEVENLABS_VOICE,
	ELEVENLABS_MODELS,
	defaultCloudLlmModel,
	getCloudLlmProvider,
	isCloudLlmProvider,
	type ApiProvider,
	type CloudLlmProvider,
	type DescriptionEngine,
	type ElevenLabsVoice,
	type SpeechEngine
} from '$lib/domain/provider-catalog';
import { listElevenLabsVoices } from '$lib/services/elevenlabs';
import { getSetting, setSetting } from '$lib/services/repository';

type KeyMap = Partial<Record<ApiProvider, string>>;

function devKeyDefaults(): KeyMap {
	// Static member accesses only: Vite constant-folds the DEV guard, making
	// everything below unreachable in production builds — the minifier then
	// strips it, so a local build with a populated .env ships no key material.
	if (!import.meta.env.DEV) return {};
	const keys: KeyMap = {};
	const add = (provider: ApiProvider, value: string | undefined) => {
		const trimmed = value?.trim();
		if (trimmed) keys[provider] = trimmed;
	};
	add('anthropic', import.meta.env.VITE_DEV_ANTHROPIC_API_KEY);
	add('openai', import.meta.env.VITE_DEV_OPENAI_API_KEY);
	add('gemini', import.meta.env.VITE_DEV_GEMINI_API_KEY);
	add('elevenlabs', import.meta.env.VITE_DEV_ELEVENLABS_API_KEY);
	return keys;
}

export class ProvidersState {
	private initialization?: Promise<void>;
	initialized = $state(false);

	/** User-entered keys (persisted). Dev .env keys are merged in via keyFor. */
	private userKeys = $state<KeyMap>({});
	private devKeys: KeyMap = {};

	descriptionEngine = $state<DescriptionEngine>('local');
	private cloudLlmModels = $state<Partial<Record<CloudLlmProvider, string>>>({});

	speechEngine = $state<SpeechEngine>('local');
	elevenLabsModelId = $state<string>(ELEVENLABS_MODELS[0].id);
	elevenLabsVoiceId = $state<string>(DEFAULT_ELEVENLABS_VOICE);
	/** Cached voice list (refreshed whenever settings opens with a key). */
	elevenLabsVoices = $state<ElevenLabsVoice[]>([]);
	private voicesLoad?: Promise<ElevenLabsVoice[]>;

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialization ??= this.load();
		await this.initialization;
	}

	private async load(): Promise<void> {
		try {
			this.devKeys = devKeyDefaults();
			const [keys, engine, models, speech, elModel, elVoice, elVoices] = await Promise.all([
				getSetting<KeyMap>('provider-api-keys', {}),
				getSetting<string>('description-engine', 'local'),
				getSetting<Partial<Record<CloudLlmProvider, string>>>('cloud-llm-models', {}),
				getSetting<string>('speech-engine', 'local'),
				getSetting<string>('elevenlabs-model', ELEVENLABS_MODELS[0].id),
				getSetting<string>('elevenlabs-voice', DEFAULT_ELEVENLABS_VOICE),
				getSetting<ElevenLabsVoice[]>('elevenlabs-voices-cache', [])
			]);
			this.userKeys = keys ?? {};
			this.descriptionEngine = engine === 'local' || isCloudLlmProvider(engine) ? engine : 'local';
			this.cloudLlmModels = models ?? {};
			this.speechEngine = speech === 'elevenlabs' ? 'elevenlabs' : 'local';
			this.elevenLabsModelId = ELEVENLABS_MODELS.some((model) => model.id === elModel)
				? elModel
				: ELEVENLABS_MODELS[0].id;
			this.elevenLabsVoiceId = elVoice || DEFAULT_ELEVENLABS_VOICE;
			this.elevenLabsVoices = elVoices ?? [];
		} finally {
			this.initialized = true;
		}
	}

	keyFor(provider: ApiProvider): string | undefined {
		return this.userKeys[provider]?.trim() || this.devKeys[provider];
	}

	hasKey(provider: ApiProvider): boolean {
		return Boolean(this.keyFor(provider));
	}

	/** True when the effective key came from the dev .env, not the user. */
	isDevKey(provider: ApiProvider): boolean {
		return !this.userKeys[provider]?.trim() && Boolean(this.devKeys[provider]);
	}

	async setKey(provider: ApiProvider, value: string): Promise<void> {
		const next: KeyMap = { ...this.userKeys };
		const trimmed = value.trim();
		if (trimmed) next[provider] = trimmed;
		else delete next[provider];
		this.userKeys = next;
		await setSetting('provider-api-keys', { ...next });
	}

	async clearKey(provider: ApiProvider): Promise<void> {
		await this.setKey(provider, '');
	}

	/* ── Description engine ──────────────────────────────────────────────── */

	cloudLlmModelFor(provider: CloudLlmProvider): string {
		const selected = this.cloudLlmModels[provider];
		const spec = getCloudLlmProvider(provider);
		return selected && spec?.models.some((model) => model.id === selected)
			? selected
			: defaultCloudLlmModel(provider);
	}

	async setDescriptionEngine(engine: DescriptionEngine): Promise<void> {
		this.descriptionEngine = engine;
		await setSetting('description-engine', engine);
	}

	async setCloudLlmModel(provider: CloudLlmProvider, modelId: string): Promise<void> {
		this.cloudLlmModels = { ...this.cloudLlmModels, [provider]: modelId };
		await setSetting('cloud-llm-models', { ...this.cloudLlmModels });
	}

	/** The cloud description engine that is selected AND has a key, if any. */
	get cloudDescriptionEngine(): {
		provider: CloudLlmProvider;
		model: string;
		apiKey: string;
	} | null {
		if (this.descriptionEngine === 'local') return null;
		const apiKey = this.keyFor(this.descriptionEngine);
		if (!apiKey) return null;
		return {
			provider: this.descriptionEngine,
			model: this.cloudLlmModelFor(this.descriptionEngine),
			apiKey
		};
	}

	/* ── Speech engine ───────────────────────────────────────────────────── */

	get elevenLabsReady(): boolean {
		return this.hasKey('elevenlabs');
	}

	async setSpeechEngine(engine: SpeechEngine): Promise<void> {
		this.speechEngine = engine;
		await setSetting('speech-engine', engine);
	}

	async setElevenLabsModel(modelId: string): Promise<void> {
		this.elevenLabsModelId = modelId;
		await setSetting('elevenlabs-model', modelId);
	}

	async setElevenLabsVoice(voiceId: string): Promise<void> {
		this.elevenLabsVoiceId = voiceId;
		await setSetting('elevenlabs-voice', voiceId);
	}

	async refreshElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
		const apiKey = this.keyFor('elevenlabs');
		if (!apiKey) return this.elevenLabsVoices;
		this.voicesLoad ??= listElevenLabsVoices(apiKey)
			.then(async (voices) => {
				if (voices.length) {
					this.elevenLabsVoices = voices;
					await setSetting('elevenlabs-voices-cache', voices);
				}
				return voices;
			})
			.finally(() => {
				this.voicesLoad = undefined;
			});
		return this.voicesLoad;
	}

	elevenLabsVoiceName(voiceId: string): string {
		return this.elevenLabsVoices.find((voice) => voice.id === voiceId)?.name ?? 'ElevenLabs voice';
	}
}

export const providersState = new ProvidersState();
