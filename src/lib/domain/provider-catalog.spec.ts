import { describe, expect, it } from 'vitest';
import {
	CLOUD_LLM_PROVIDERS,
	DEFAULT_ELEVENLABS_MODEL,
	DEFAULT_ELEVENLABS_OPTIONS,
	ELEVENLABS_FAMILIES,
	ELEVENLABS_MODELS,
	defaultCloudLlmModel,
	elevenLabsRevision,
	elevenLabsVoiceSettings,
	getCloudLlmProvider,
	getElevenLabsModel,
	isCloudLlmProvider,
	normalizeElevenLabsOptions,
	type ElevenLabsModelSpec
} from './provider-catalog';

describe('cloud LLM provider catalog', () => {
	it('exposes three providers, each with a default model first', () => {
		expect(CLOUD_LLM_PROVIDERS.map((provider) => provider.id)).toEqual([
			'anthropic',
			'openai',
			'gemini'
		]);
		for (const provider of CLOUD_LLM_PROVIDERS) {
			expect(provider.models.length).toBeGreaterThan(0);
			expect(defaultCloudLlmModel(provider.id)).toBe(provider.models[0].id);
		}
	});

	it('guards engine ids', () => {
		expect(isCloudLlmProvider('anthropic')).toBe(true);
		expect(isCloudLlmProvider('local')).toBe(false);
		expect(isCloudLlmProvider('elevenlabs')).toBe(false);
		expect(getCloudLlmProvider('nope')).toBeNull();
	});
});

describe('elevenlabs model catalog', () => {
	it('offers both generations and defaults to the cheapest v2 model', () => {
		expect(getElevenLabsModel(DEFAULT_ELEVENLABS_MODEL)).not.toBeNull();
		expect(DEFAULT_ELEVENLABS_MODEL).toBe('eleven_flash_v2_5');
		// v3 now returns character alignment from the with-timestamps
		// endpoint, so word highlighting survives the switch.
		expect(ELEVENLABS_MODELS.map((model) => model.id)).toEqual([
			'eleven_v3',
			'eleven_v3_conversational',
			'eleven_flash_v2_5',
			'eleven_turbo_v2_5',
			'eleven_multilingual_v2'
		]);
	});

	it('groups every model into exactly one family', () => {
		const grouped = ELEVENLABS_FAMILIES.flatMap((family) => family.models);
		expect(grouped).toHaveLength(ELEVENLABS_MODELS.length);
		expect(new Set(grouped.map((model) => model.id)).size).toBe(ELEVENLABS_MODELS.length);
		expect(ELEVENLABS_FAMILIES[0].id).toBe('v3');
	});
});

describe('elevenlabs voice options', () => {
	const v3 = getElevenLabsModel('eleven_v3') as ElevenLabsModelSpec;
	const conversational = getElevenLabsModel('eleven_v3_conversational') as ElevenLabsModelSpec;
	const flash = getElevenLabsModel('eleven_flash_v2_5') as ElevenLabsModelSpec;
	const multilingual = getElevenLabsModel('eleven_multilingual_v2') as ElevenLabsModelSpec;

	it('snaps v3 stability to the three named points', () => {
		expect(normalizeElevenLabsOptions(v3, { stability: 0.2 }).stability).toBe(0);
		expect(normalizeElevenLabsOptions(v3, { stability: 0.4 }).stability).toBe(0.5);
		expect(normalizeElevenLabsOptions(v3, { stability: 0.9 }).stability).toBe(1);
		// v2 keeps the continuous value.
		expect(normalizeElevenLabsOptions(flash, { stability: 0.2 }).stability).toBe(0.2);
	});

	it('clamps out-of-range and non-finite values', () => {
		expect(normalizeElevenLabsOptions(flash, { similarity: 4 }).similarity).toBe(1);
		expect(normalizeElevenLabsOptions(flash, { speed: 0.1 }).speed).toBe(0.7);
		expect(normalizeElevenLabsOptions(flash, { speed: 9 }).speed).toBe(1.2);
		expect(normalizeElevenLabsOptions(flash, { stability: Number.NaN }).stability).toBe(
			DEFAULT_ELEVENLABS_OPTIONS.stability
		);
	});

	it('forces knobs a model ignores back to their defaults', () => {
		// v3 accepts `speed` on the wire but produces identical audio, and
		// reports can_use_style / can_use_speaker_boost false.
		const tuned = normalizeElevenLabsOptions(v3, {
			speed: 1.2,
			style: 0.8,
			similarity: 0.1,
			speakerBoost: false
		});
		expect(tuned.speed).toBe(1);
		expect(tuned.style).toBe(0);
		expect(tuned.similarity).toBe(DEFAULT_ELEVENLABS_OPTIONS.similarity);
		expect(tuned.speakerBoost).toBe(true);
	});

	it('sends nothing while the options are untouched', () => {
		for (const model of ELEVENLABS_MODELS) {
			const options = normalizeElevenLabsOptions(model, null);
			expect(elevenLabsVoiceSettings(model, options)).toBeUndefined();
			// The bare id keeps audio cached before these controls existed.
			expect(elevenLabsRevision(model, options)).toBe(model.id);
		}
	});

	it('sends only the fields the model honours', () => {
		const v3Body = elevenLabsVoiceSettings(v3, normalizeElevenLabsOptions(v3, { stability: 0 }));
		expect(v3Body).toEqual({ stability: 0 });

		const boostBody = elevenLabsVoiceSettings(
			conversational,
			normalizeElevenLabsOptions(conversational, { speakerBoost: false })
		);
		expect(boostBody).toEqual({ stability: 0.5, use_speaker_boost: false });

		const flashBody = elevenLabsVoiceSettings(
			flash,
			normalizeElevenLabsOptions(flash, { speed: 1.1 })
		);
		expect(flashBody).toEqual({ stability: 0.5, similarity_boost: 0.75, speed: 1.1 });

		const fullBody = elevenLabsVoiceSettings(
			multilingual,
			normalizeElevenLabsOptions(multilingual, { style: 0.4 })
		);
		expect(fullBody).toEqual({
			stability: 0.5,
			similarity_boost: 0.75,
			style: 0.4,
			speed: 1,
			use_speaker_boost: true
		});
	});

	it('gives tuned options a stable, order-independent revision', () => {
		const a = elevenLabsRevision(flash, normalizeElevenLabsOptions(flash, { speed: 1.1 }));
		const b = elevenLabsRevision(flash, normalizeElevenLabsOptions(flash, { speed: 1.1 }));
		expect(a).toBe(b);
		expect(a).toBe('eleven_flash_v2_5#similarity_boost=0.75,speed=1.1,stability=0.5');
		expect(a).not.toBe(elevenLabsRevision(flash, normalizeElevenLabsOptions(flash, { speed: 1 })));
	});
});
