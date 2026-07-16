import {
	DEFAULT_LLM_ID,
	LLM_CATALOG,
	canRunLlmModel,
	getLlmModel,
	type LlmDeviceCaps,
	type LlmModelSpec
} from '$lib/domain/llm-catalog';
import { activeLlmHost, disposeLlmHost, type LlmProgress } from '$lib/services/llm/llm-client';
import { warmLlm } from '$lib/services/llm/llm-runtime';
import { deleteLlmModelAssets } from '$lib/services/llm/llm-cache';
import type { NarrationPromptHashes } from '$lib/domain/narration';
import {
	DEFAULT_NARRATION_PROMPTS,
	NARRATION_GENERATION_PARAMS,
	narrationPromptHashes,
	resolveNarrationPrompts,
	type NarrationPromptKey,
	type NarrationPromptOverrides,
	type NarrationPromptTemplates
} from '$lib/domain/narration-prompts';
import {
	getNarrationPreset,
	isNarrationPresetId,
	type NarrationParamsMap,
	type NarrationPresetId
} from '$lib/domain/narration-presets';
import { getSetting, setSetting } from '$lib/services/repository';
import { narrationRuntimePolicy, type NarrationRuntimePolicy } from '$lib/services/runtime-policy';
import { appState } from './app-state.svelte';

export type LlmPhase = 'idle' | 'downloading' | 'loading' | 'probing' | 'ready' | 'error';

export interface LlmDownloadProgress {
	file: string;
	percent: number;
}

/**
 * Lifecycle state for the narration LLM: install consent, download progress,
 * warm-up, removal, and the narration feature toggles. A parallel track to
 * the speech-engine state in app-state — the two models have independent
 * catalogs and lifecycles. Settings persist in the IndexedDB settings store
 * like every other app-domain setting.
 */
export class LlmState {
	private initialization?: Promise<void>;
	private warmAbort: AbortController | null = null;

	initialized = $state(false);
	phase = $state<LlmPhase>('idle');
	download = $state<LlmDownloadProgress | null>(null);
	error = $state('');
	device = $state<'webgpu' | 'wasm' | null>(null);
	/** The model currently loaded in the worker (ready or being activated). */
	activeModelId = $state<string | null>(null);
	installedModels = $state<string[]>([]);
	selectedModelId = $state<string>(DEFAULT_LLM_ID);
	acceptedLicenses = $state<string[]>([]);
	narrationEnabled = $state(true);
	narrationHintDismissed = $state(false);
	/** Active description style; 'custom' uses the user's edited templates. */
	promptPreset = $state<NarrationPresetId>('balanced');
	/** User-edited prompt templates; absent keys fall back to the defaults. */
	promptOverrides = $state<NarrationPromptOverrides>({});

	/** The templates the active preset actually sends. */
	get promptTemplates(): NarrationPromptTemplates {
		const preset = getNarrationPreset(this.promptPreset);
		return preset ? preset.prompts : resolveNarrationPrompts(this.promptOverrides);
	}

	/** What the rewriter receives as template overrides. */
	get activePromptOverrides(): NarrationPromptOverrides {
		const preset = getNarrationPreset(this.promptPreset);
		return preset ? preset.prompts : this.promptOverrides;
	}

	/** Per-kind token budgets for the active preset (custom edits keep the
	 * balanced budgets — they change wording, not spend). */
	get generationParams(): NarrationParamsMap {
		return getNarrationPreset(this.promptPreset)?.params ?? NARRATION_GENERATION_PARAMS;
	}

	get promptHashes(): NarrationPromptHashes {
		// Budgets are part of a style's identity: switching presets that share
		// a template but differ in spend (Concise's reading-only equations)
		// still re-queues lazily.
		const base = narrationPromptHashes(this.activePromptOverrides);
		const params = this.generationParams;
		const hashes: NarrationPromptHashes = {};
		for (const [kind, hash] of Object.entries(base) as Array<[keyof NarrationParamsMap, string]>) {
			const budget = params[kind];
			hashes[kind] = `${hash}:${budget.maxNewTokens}:${budget.maxChars}:${budget.mathProse ?? 's'}`;
		}
		return hashes;
	}

	get selectedModel(): LlmModelSpec {
		return getLlmModel(this.selectedModelId) ?? LLM_CATALOG[0];
	}

	get installed(): boolean {
		return this.installedModels.includes(this.selectedModelId);
	}

	get ready(): boolean {
		return this.phase === 'ready' && this.activeModelId === this.selectedModelId;
	}

	/** Desktop + worker-verified WebGPU. Depends on appState.capabilities,
	 * which the library boot populates before any narration surface renders. */
	get policy(): NarrationRuntimePolicy {
		if (typeof navigator === 'undefined') return { eligible: false, reason: 'No browser.' };
		return narrationRuntimePolicy(
			{ userAgent: navigator.userAgent },
			{ webgpu: appState.capabilities.webgpu }
		);
	}

	get eligible(): boolean {
		return this.policy.eligible;
	}

	get deviceCaps(): LlmDeviceCaps {
		const nav =
			typeof navigator === 'undefined'
				? undefined
				: (navigator as Navigator & { deviceMemory?: number });
		return {
			webgpu: appState.capabilities.webgpu,
			ramGb: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null
		};
	}

	canOffer(spec: LlmModelSpec): { ok: boolean; reason?: string } {
		if (!this.eligible) return { ok: false, reason: this.policy.reason };
		return canRunLlmModel(spec, this.deviceCaps);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialization ??= this.load();
		await this.initialization;
	}

	private async load(): Promise<void> {
		try {
			const [installed, selected, accepted, enabled, hintDismissed, promptOverrides, preset] =
				await Promise.all([
					getSetting<string[]>('llm-installed-models', []),
					getSetting<string | null>('llm-selected-model', null),
					getSetting<string[]>('llm-accepted-licenses', []),
					getSetting('narration-enabled', true),
					getSetting('narration-hint-dismissed', false),
					getSetting<NarrationPromptOverrides>('narration-prompt-overrides', {}),
					getSetting<string>('narration-preset', 'balanced')
				]);
			this.installedModels = installed.filter((id) => getLlmModel(id) !== null);
			this.selectedModelId =
				selected && getLlmModel(selected) ? selected : (this.installedModels[0] ?? DEFAULT_LLM_ID);
			this.acceptedLicenses = accepted;
			this.narrationEnabled = Boolean(enabled);
			this.narrationHintDismissed = Boolean(hintDismissed);
			this.promptOverrides = promptOverrides ?? {};
			this.promptPreset = isNarrationPresetId(preset) ? preset : 'balanced';
		} finally {
			this.initialized = true;
		}
	}

	/** Choose a description style; affected narrations re-queue lazily. */
	async setPromptPreset(preset: NarrationPresetId): Promise<void> {
		this.promptPreset = preset;
		await setSetting('narration-preset', preset);
	}

	/** Seed the Custom style from the active preset's templates and switch to
	 * it — the entry point for "customize this preset". */
	async customizeActivePreset(): Promise<void> {
		const preset = getNarrationPreset(this.promptPreset);
		if (preset) {
			this.promptOverrides = { ...preset.prompts };
			await setSetting('narration-prompt-overrides', { ...this.promptOverrides });
		}
		await this.setPromptPreset('custom');
	}

	/** Save a user-edited prompt template into the Custom style; text equal to
	 * the default (or empty) removes the override. Affected narrations
	 * re-queue on next document open. */
	async setPromptTemplate(key: NarrationPromptKey, text: string): Promise<void> {
		const trimmed = text.replace(/\r\n/g, '\n').trim();
		const next: NarrationPromptOverrides = { ...this.promptOverrides };
		if (!trimmed || trimmed === DEFAULT_NARRATION_PROMPTS[key].trim()) {
			delete next[key];
		} else {
			next[key] = trimmed;
		}
		this.promptOverrides = next;
		await setSetting('narration-prompt-overrides', { ...next });
		if (this.promptPreset !== 'custom') await this.setPromptPreset('custom');
	}

	async setLicenseAcceptance(modelId: string, accepted: boolean): Promise<void> {
		this.acceptedLicenses = accepted
			? this.acceptedLicenses.includes(modelId)
				? [...this.acceptedLicenses]
				: [...this.acceptedLicenses, modelId]
			: this.acceptedLicenses.filter((id) => id !== modelId);
		await setSetting('llm-accepted-licenses', [...this.acceptedLicenses]);
	}

	async setNarrationEnabled(value: boolean): Promise<void> {
		this.narrationEnabled = value;
		await setSetting('narration-enabled', value);
	}

	async dismissHint(): Promise<void> {
		this.narrationHintDismissed = true;
		await setSetting('narration-hint-dismissed', true);
	}

	async selectModel(modelId: string): Promise<void> {
		if (!getLlmModel(modelId)) return;
		this.selectedModelId = modelId;
		await setSetting('llm-selected-model', modelId);
	}

	/**
	 * Download (with consent) and/or warm the model. `install: true` is
	 * required for a model that has never been downloaded — nothing fetches
	 * without an explicit user gesture. Warming an installed model reads the
	 * weights from Cache Storage.
	 */
	async activate(modelId: string = this.selectedModelId, options: { install?: boolean } = {}) {
		await this.initialize();
		const spec = getLlmModel(modelId);
		if (!spec) throw new Error(`Unknown narration model: ${modelId}`);
		const offer = this.canOffer(spec);
		if (!offer.ok) throw new Error(offer.reason ?? 'This device cannot run the narration model.');
		const installed = this.installedModels.includes(modelId);
		if (!installed && !options.install) {
			throw new Error('The narration model has not been downloaded yet.');
		}
		if (!installed && !this.acceptedLicenses.includes(modelId)) {
			throw new Error(`Review and accept the ${spec.license} before downloading this model.`);
		}
		if (this.ready && this.activeModelId === modelId && this.selectedModelId === modelId) return;

		this.warmAbort?.abort();
		const abort = new AbortController();
		this.warmAbort = abort;
		this.error = '';
		this.activeModelId = modelId;
		this.phase = installed ? 'loading' : 'downloading';
		this.download = null;

		try {
			const result = await warmLlm(spec, this.deviceCaps, {
				signal: abort.signal,
				onProgress: (p: LlmProgress) => {
					if (abort.signal.aborted) return;
					if (p.status === 'progress' && p.file) {
						if (!installed) this.phase = 'downloading';
						this.download = { file: p.file, percent: Math.round(p.progress ?? 0) };
					}
				},
				onPhase: (phase) => {
					if (abort.signal.aborted) return;
					this.phase = phase.startsWith('warming') ? 'probing' : installed ? 'loading' : this.phase;
				}
			});
			if (abort.signal.aborted) return;
			this.device = result.device;
			this.phase = 'ready';
			this.download = null;
			if (!this.installedModels.includes(modelId)) {
				this.installedModels = [...this.installedModels, modelId];
				await setSetting('llm-installed-models', [...this.installedModels]);
				await appState.refreshStorage();
			}
			if (this.selectedModelId !== modelId) await this.selectModel(modelId);
		} catch (error) {
			if (abort.signal.aborted) {
				this.phase = 'idle';
				this.download = null;
				this.activeModelId = null;
				return;
			}
			this.phase = 'error';
			this.download = null;
			this.error =
				error instanceof Error ? error.message : 'The narration model could not be loaded.';
			this.activeModelId = null;
			throw error;
		} finally {
			if (this.warmAbort === abort) this.warmAbort = null;
		}
	}

	/** Warm an already-installed model silently (document open). Never downloads. */
	async ensureReadyForNarration(): Promise<boolean> {
		await this.initialize();
		if (!this.eligible || !this.narrationEnabled || !this.installed) return false;
		if (this.ready) return true;
		if (this.phase === 'loading' || this.phase === 'probing' || this.phase === 'downloading') {
			return false;
		}
		try {
			await this.activate(this.selectedModelId);
			return this.ready;
		} catch {
			return false;
		}
	}

	cancelActivation(): void {
		this.warmAbort?.abort();
		this.warmAbort = null;
		disposeLlmHost();
		this.phase = 'idle';
		this.download = null;
		this.activeModelId = null;
	}

	/** Drop the worker (e.g. after an out-of-memory error) without touching
	 * the installed flags — the next activation reloads from Cache Storage. */
	unload(): void {
		disposeLlmHost();
		if (this.phase !== 'error') this.phase = 'idle';
		this.activeModelId = null;
		this.device = null;
	}

	async remove(modelId: string): Promise<void> {
		await this.initialize();
		if (this.activeModelId === modelId) {
			this.warmAbort?.abort();
			this.warmAbort = null;
			disposeLlmHost();
			this.activeModelId = null;
			this.device = null;
			this.phase = 'idle';
		}
		await deleteLlmModelAssets(modelId);
		this.installedModels = this.installedModels.filter((id) => id !== modelId);
		await setSetting('llm-installed-models', [...this.installedModels]);
		await appState.refreshStorage();
	}

	get busy(): boolean {
		return Boolean(activeLlmHost()?.busy);
	}
}

export const llmState = new LlmState();
