<script lang="ts">
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import {
		AlertTriangle,
		ArrowUpRight,
		Bug,
		Check,
		ClipboardCopy,
		Cpu,
		Database,
		Download,
		Gauge,
		HardDrive,
		Keyboard,
		LoaderCircle,
		LockKeyhole,
		Mic2,
		Play,
		RefreshCw,
		ShieldCheck,
		BrainCircuit,
		Cloud,
		Square,
		Trash2,
		Wifi
	} from '@lucide/svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { LLM_CATALOG, type LlmModelSpec } from '$lib/domain/llm-catalog';
	import {
		CLOUD_LLM_PROVIDERS,
		ELEVENLABS_MODELS,
		type ApiProvider,
		type CloudLlmProvider,
		type DescriptionEngine,
		type ElevenLabsVoice,
		type SpeechEngine
	} from '$lib/domain/provider-catalog';
	import ApiKeyField from '$lib/components/ApiKeyField.svelte';
	import { verifyCloudLlmKey } from '$lib/services/cloud-llm';
	import { elevenLabsUsage, type ElevenLabsUsage } from '$lib/services/elevenlabs';
	import { player } from '$lib/state/player.svelte';
	import { providersState } from '$lib/state/providers.svelte';
	import {
		DEFAULT_NARRATION_PROMPTS,
		type NarrationPromptKey
	} from '$lib/domain/narration-prompts';
	import type { VoiceDescriptor } from '$lib/domain/types';
	import { runtimeDiagnosticsReport } from '$lib/services/runtime-diagnostics';
	import { ttsClient } from '$lib/services/tts-client';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { narrationState } from '$lib/state/narrations.svelte';
	import { requestPersistentStorage } from '$lib/services/repository';

	type SettingsSection = 'models' | 'llm' | 'storage' | 'system';
	type PreviewState = 'idle' | 'loading' | 'playing' | 'error';

	const model = getModel('supertonic-3');
	const previewText = 'A calm voice can make every page feel closer.';
	let busy = $state(false);
	let storageBusy = $state(false);
	let previewState = $state<PreviewState>('idle');
	let previewVoiceId = $state<string>();
	let previewProgress = $state(0);
	let previewError = $state('');
	let previewAnnouncement = $state('');
	let previewContext: AudioContext | undefined;
	let previewGain: GainNode | undefined;
	let previewSource: AudioBufferSourceNode | undefined;
	let previewAbort: AbortController | undefined;
	let previewEngineLoad: Promise<void> | undefined;
	let previewSequence = 0;
	let diagnosticReport = $state('');
	let diagnosticsCopied = $state(false);
	let activeSection = $derived.by<SettingsSection>(() => {
		const section = page.url.searchParams.get('section');
		if (section === 'narration') return 'llm'; // pre-rename links
		return section === 'storage' || section === 'system' || section === 'llm' ? section : 'models';
	});
	let progress = $derived(appState.modelProgress['supertonic-3']);
	let installed = $derived(appState.installedModels.includes('supertonic-3'));
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));

	function bytes(value: number): string {
		if (!value) return '0 MB';
		const units = ['B', 'KB', 'MB', 'GB'];
		const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
		return (value / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0) + ' ' + units[exponent];
	}

	function friendlyError(message?: string): string {
		if (!message) return 'The voice engine could not be installed.';
		if (/out of memory|allocation|memory/i.test(message))
			return 'The engine did not fit in available memory. Close other GPU-heavy tabs or use compatibility mode.';
		return message;
	}

	function stopPreview(announce = true): void {
		previewSequence += 1;
		previewAbort?.abort();
		previewAbort = undefined;
		if (previewSource) {
			previewSource.onended = null;
			try {
				previewSource.stop();
			} catch {
				// A source that has already ended cannot be stopped twice.
			}
			previewSource.disconnect();
			previewSource = undefined;
		}
		const voice = model.voices.find((candidate) => candidate.id === previewVoiceId);
		previewState = 'idle';
		previewVoiceId = undefined;
		previewProgress = 0;
		previewError = '';
		if (announce && voice) previewAnnouncement = `Stopped ${voice.name} preview.`;
	}

	function previewButtonLabel(voice: VoiceDescriptor): string {
		if (voice.id !== previewVoiceId) return `Preview ${voice.name}`;
		if (previewState === 'loading') return `Stop preparing ${voice.name} preview`;
		if (previewState === 'playing') return `Stop ${voice.name} preview`;
		return `Preview ${voice.name}`;
	}

	async function ensurePreviewEngine(): Promise<void> {
		if (ttsClient.modelId === model.id) return;
		previewEngineLoad ??= ttsClient
			.load(model.id, 'auto', (update) => {
				if (previewState === 'loading') previewProgress = update.progress;
			})
			.finally(() => {
				previewEngineLoad = undefined;
			});
		await previewEngineLoad;
	}

	async function previewVoice(voice: VoiceDescriptor): Promise<void> {
		if (!installed || busy) return;
		if (voice.id === previewVoiceId && (previewState === 'loading' || previewState === 'playing')) {
			stopPreview();
			return;
		}

		stopPreview(false);
		const sequence = previewSequence;
		const controller = new AbortController();
		previewAbort = controller;
		previewVoiceId = voice.id;
		previewState = 'loading';
		previewProgress = 0;
		previewError = '';
		previewAnnouncement = `Preparing ${voice.name} preview.`;

		try {
			previewContext ??= new AudioContext({ latencyHint: 'interactive' });
			previewGain ??= previewContext.createGain();
			previewGain.gain.value = 0.85;
			previewGain.connect(previewContext.destination);
			const resumeAudio =
				previewContext.state === 'suspended' ? previewContext.resume() : Promise.resolve();

			await ensurePreviewEngine();
			const result = await ttsClient.synthesize(
				previewText,
				voice.id,
				controller.signal,
				(update) => {
					if (sequence === previewSequence) previewProgress = update.progress;
				},
				appState.generationSteps
			);
			await resumeAudio;
			if (sequence !== previewSequence || controller.signal.aborted) return;

			const buffer = previewContext.createBuffer(1, result.audio.length, result.sampleRate);
			buffer.getChannelData(0).set(result.audio);
			const source = previewContext.createBufferSource();
			source.buffer = buffer;
			source.connect(previewGain);
			previewSource = source;
			previewState = 'playing';
			previewProgress = 100;
			previewAnnouncement = `Playing ${voice.name} preview.`;
			source.onended = () => {
				if (sequence !== previewSequence) return;
				source.disconnect();
				previewSource = undefined;
				previewAbort = undefined;
				previewState = 'idle';
				previewVoiceId = undefined;
				previewProgress = 0;
				previewAnnouncement = `Finished ${voice.name} preview.`;
			};
			source.start();
		} catch (error) {
			if (sequence !== previewSequence || controller.signal.aborted) return;
			previewAbort = undefined;
			previewState = 'error';
			previewError = friendlyError(
				error instanceof Error ? error.message : 'This voice preview could not be played.'
			);
			previewAnnouncement = `${voice.name} preview failed. ${previewError}`;
		}
	}

	onDestroy(() => {
		stopPreview(false);
		previewGain?.disconnect();
		void previewContext?.close();
	});

	onMount(() => {
		diagnosticReport = runtimeDiagnosticsReport();
	});

	async function copyDiagnostics(): Promise<void> {
		try {
			diagnosticReport = runtimeDiagnosticsReport();
			await navigator.clipboard.writeText(diagnosticReport);
			diagnosticsCopied = true;
			setTimeout(() => (diagnosticsCopied = false), 2_000);
		} catch {
			appState.errorMessage = 'This browser did not allow Voicebook to copy the diagnostic report.';
		}
	}

	async function install(): Promise<void> {
		busy = true;
		try {
			await appState.installModel('supertonic-3');
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			appState.errorMessage = friendlyError(
				error instanceof Error ? error.message : 'The voice engine could not be installed.'
			);
		} finally {
			busy = false;
		}
	}

	function cancelInstall(): void {
		appState.cancelModelInstall('supertonic-3');
		busy = false;
	}

	async function remove(): Promise<void> {
		if (!confirm('Remove Supertonic 3 from this browser? Generated audio will remain available.'))
			return;
		busy = true;
		try {
			await appState.removeModel('supertonic-3');
		} catch (error) {
			appState.errorMessage =
				error instanceof Error ? error.message : 'The voice engine could not be removed.';
		} finally {
			busy = false;
		}
	}

	async function updateLicense(event: Event): Promise<void> {
		await appState.setLicenseAcceptance(
			'supertonic-3',
			(event.currentTarget as HTMLInputElement).checked
		);
	}

	async function clearAudio(): Promise<void> {
		if (
			!confirm(
				'Remove all generated speech? Documents, bookmarks, and reading positions will remain.'
			)
		)
			return;
		storageBusy = true;
		try {
			await appState.clearAudio();
		} finally {
			storageBusy = false;
		}
	}

	async function makePersistent(): Promise<void> {
		await requestPersistentStorage();
		await appState.refreshStorage();
	}

	/* ── Narration model management ────────────────────────────────────── */

	let llmBusy = $state(false);
	let llmError = $state('');
	let regenerating = $state(false);
	let llmActivating = $derived(
		llmState.phase === 'downloading' || llmState.phase === 'loading' || llmState.phase === 'probing'
	);

	onMount(() => {
		void llmState.initialize();
		void providersState.initialize().then(() => {
			if (providersState.speechEngine === 'elevenlabs' && providersState.elevenLabsReady) {
				void refreshElevenLabs();
			}
		});
	});

	/* ── ElevenLabs speech engine ────────────────────────────────────────── */

	let elUsage = $state<ElevenLabsUsage | null>(null);
	let elPreviewVoiceId = $state<string | undefined>();
	let elPreviewAudio: HTMLAudioElement | undefined;

	async function refreshElevenLabs(): Promise<void> {
		void providersState.refreshElevenLabsVoices();
		const key = providersState.keyFor('elevenlabs');
		if (!key) return;
		try {
			elUsage = await elevenLabsUsage(key);
		} catch {
			elUsage = null;
		}
	}

	async function chooseSpeechEngine(engine: SpeechEngine): Promise<void> {
		await player.chooseSpeechEngine(engine);
		if (engine === 'elevenlabs' && providersState.elevenLabsReady) void refreshElevenLabs();
	}

	async function saveElevenLabsKey(value: string): Promise<void> {
		await providersState.setKey('elevenlabs', value);
		if (value.trim()) await refreshElevenLabs();
	}

	async function testElevenLabsKey(): Promise<{ ok: boolean; message: string }> {
		const key = providersState.keyFor('elevenlabs');
		if (!key) return { ok: false, message: 'No key saved yet.' };
		try {
			const usage = await elevenLabsUsage(key);
			elUsage = usage;
			return {
				ok: true,
				message: `ElevenLabs accepted the key — ${usage.tier} plan, ${usage.used.toLocaleString()} of ${usage.limit.toLocaleString()} characters used.`
			};
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : 'ElevenLabs rejected the key.'
			};
		}
	}

	function stopElevenLabsPreview(): void {
		elPreviewAudio?.pause();
		elPreviewAudio = undefined;
		elPreviewVoiceId = undefined;
	}

	function previewElevenLabsVoice(voice: ElevenLabsVoice): void {
		if (elPreviewVoiceId === voice.id) {
			stopElevenLabsPreview();
			return;
		}
		stopElevenLabsPreview();
		if (!voice.previewUrl) return;
		const audio = new Audio(voice.previewUrl);
		elPreviewAudio = audio;
		elPreviewVoiceId = voice.id;
		audio.onended = () => {
			if (elPreviewVoiceId === voice.id) stopElevenLabsPreview();
		};
		void audio.play().catch(() => stopElevenLabsPreview());
	}

	onDestroy(() => stopElevenLabsPreview());

	/* ── Description engine (on-device or bring-your-own-key cloud) ──────── */

	/** A changed engine or key affects the open document immediately. */
	function reopenNarrations(): void {
		if (player.book) void narrationState.open(player.book);
	}

	async function chooseDescriptionEngine(engine: DescriptionEngine): Promise<void> {
		await providersState.setDescriptionEngine(engine);
		reopenNarrations();
	}

	async function chooseCloudModel(provider: CloudLlmProvider, modelId: string): Promise<void> {
		await providersState.setCloudLlmModel(provider, modelId);
		reopenNarrations();
	}

	async function saveProviderKey(provider: ApiProvider, value: string): Promise<void> {
		await providersState.setKey(provider, value);
		reopenNarrations();
	}

	async function updateLlmLicense(spec: LlmModelSpec, event: Event): Promise<void> {
		await llmState.setLicenseAcceptance(spec.id, (event.currentTarget as HTMLInputElement).checked);
	}

	async function installLlm(spec: LlmModelSpec): Promise<void> {
		llmBusy = true;
		llmError = '';
		try {
			await llmState.activate(spec.id, { install: true });
		} catch (error) {
			llmError =
				error instanceof Error ? error.message : 'The language model could not be installed.';
		} finally {
			llmBusy = false;
		}
	}

	function cancelLlmInstall(): void {
		llmState.cancelActivation();
		llmBusy = false;
	}

	async function removeLlm(spec: LlmModelSpec): Promise<void> {
		if (
			!confirm(
				`Remove ${spec.label} from this browser? Rewritten narrations are kept and can be regenerated later.`
			)
		)
			return;
		llmBusy = true;
		llmError = '';
		try {
			await llmState.remove(spec.id);
		} catch (error) {
			llmError =
				error instanceof Error ? error.message : 'The language model could not be removed.';
		} finally {
			llmBusy = false;
		}
	}

	async function useLlm(spec: LlmModelSpec): Promise<void> {
		await llmState.selectModel(spec.id);
	}

	async function toggleNarrationEnabled(event: Event): Promise<void> {
		await llmState.setNarrationEnabled((event.currentTarget as HTMLInputElement).checked);
	}

	async function regenerateNarrations(): Promise<void> {
		if (
			!confirm(
				'Rewrite every equation, table, and diagram narration again? The open document starts immediately; others regenerate the next time they are opened.'
			)
		)
			return;
		regenerating = true;
		try {
			await narrationState.regenerateAll();
		} finally {
			regenerating = false;
		}
	}

	/* ── Prompt editor ─────────────────────────────────────────────────── */

	const PROMPT_FIELDS: Array<{ key: NarrationPromptKey; label: string; hint: string }> = [
		{ key: 'system', label: 'Shared rules', hint: 'Prepended to every rewrite request.' },
		{
			key: 'math-block',
			label: 'Equations',
			hint: 'Asks only for the symbol-meaning sentence; the reading itself is generated exactly, without the model. Placeholders: {{reading}}, {{context}}, {{source}}'
		},
		{
			key: 'math-inline',
			label: 'Inline symbols',
			hint: 'Only for expressions the built-in verbalizer cannot read. Placeholders: {{source}}'
		},
		{
			key: 'table-row',
			label: 'Table rows',
			hint: 'Placeholders: {{source}}, {{header}}, {{context}}'
		},
		{ key: 'mermaid', label: 'Diagrams', hint: 'Placeholders: {{source}}, {{context}}' },
		{ key: 'image', label: 'Images', hint: 'Placeholders: {{source}}, {{context}}' }
	];

	let promptDrafts = $state<Record<NarrationPromptKey, string>>({
		...DEFAULT_NARRATION_PROMPTS
	});
	let promptsSynced = $state(false);
	let promptSavedKey = $state<NarrationPromptKey | null>(null);

	$effect(() => {
		if (llmState.initialized && !promptsSynced) {
			promptDrafts = { ...llmState.promptTemplates };
			promptsSynced = true;
		}
	});

	function promptDirty(key: NarrationPromptKey): boolean {
		return promptDrafts[key].trim() !== llmState.promptTemplates[key].trim();
	}

	function promptCustom(key: NarrationPromptKey): boolean {
		return llmState.promptOverrides[key] !== undefined;
	}

	async function savePrompt(key: NarrationPromptKey): Promise<void> {
		await llmState.setPromptTemplate(key, promptDrafts[key]);
		promptDrafts = { ...promptDrafts, [key]: llmState.promptTemplates[key] };
		promptSavedKey = key;
		setTimeout(() => {
			if (promptSavedKey === key) promptSavedKey = null;
		}, 2_000);
	}

	async function resetPrompt(key: NarrationPromptKey): Promise<void> {
		promptDrafts = { ...promptDrafts, [key]: DEFAULT_NARRATION_PROMPTS[key] };
		await llmState.setPromptTemplate(key, DEFAULT_NARRATION_PROMPTS[key]);
	}
</script>

<svelte:head>
	<title>Settings — Voicebook</title>
</svelte:head>

<div class="workspace-page settings-page">
	<header class="page-heading">
		<div>
			<p class="eyebrow">Preferences</p>
			<h1>
				{activeSection === 'models'
					? 'Voice'
					: activeSection === 'llm'
						? 'LLM'
						: activeSection === 'storage'
							? 'Storage'
							: 'System'}
			</h1>
			<p>
				{activeSection === 'models'
					? 'Pick who reads aloud — the free on-device engine, or premium voices with your own API key.'
					: activeSection === 'llm'
						? 'Rewrites equations, tables, and diagrams into speakable words — on-device for free, or with your own API key.'
						: activeSection === 'storage'
							? 'See and clean up the data Voicebook keeps on this device.'
							: 'Browser capabilities, privacy, and reader shortcuts.'}
			</p>
		</div>
		{#if activeSection === 'storage'}
			<button class="button" type="button" onclick={() => appState.refreshStorage()}>
				<RefreshCw size={15} /> Refresh
			</button>
		{/if}
	</header>

	{#if activeSection === 'models'}
		<section class="settings-section" aria-labelledby="speech-engine-choice-title">
			<header class="section-title">
				<div>
					<h2 id="speech-engine-choice-title">Reading voice</h2>
					<p>
						Where speech is generated. ElevenLabs voices use your own API key, sent only to
						ElevenLabs.
					</p>
				</div>
				<span
					class="runtime-state"
					class:ready={providersState.speechEngine === 'elevenlabs'
						? providersState.elevenLabsReady
						: installed}
				>
					<span></span>
					{providersState.speechEngine === 'elevenlabs'
						? providersState.elevenLabsReady
							? 'ElevenLabs active'
							: 'Key required'
						: installed
							? 'On-device active'
							: 'Not installed'}
				</span>
			</header>

			<div class="engine-list" role="radiogroup" aria-label="Speech engine">
				<div class="engine-option" class:selected={providersState.speechEngine === 'local'}>
					<button
						class="engine-row"
						type="button"
						role="radio"
						aria-checked={providersState.speechEngine === 'local'}
						onclick={() => void chooseSpeechEngine('local')}
					>
						<span class="engine-radio" aria-hidden="true"></span>
						<span class="engine-icon"><Mic2 size={16} /></span>
						<span class="engine-copy">
							<strong>On-device <em>· Supertonic 3</em></strong>
							<small>Private and free — ten studio voices, works offline</small>
						</span>
						<span class="engine-state" class:ok={installed}>
							{installed ? 'Ready' : 'Not installed'}
						</span>
					</button>
				</div>
				<div class="engine-option" class:selected={providersState.speechEngine === 'elevenlabs'}>
					<button
						class="engine-row"
						type="button"
						role="radio"
						aria-checked={providersState.speechEngine === 'elevenlabs'}
						onclick={() => void chooseSpeechEngine('elevenlabs')}
					>
						<span class="engine-radio" aria-hidden="true"></span>
						<span class="engine-icon cloud"><Cloud size={16} /></span>
						<span class="engine-copy">
							<strong>ElevenLabs <em>· premium cloud voices</em></strong>
							<small>Lifelike narration with word timing — bring your own API key</small>
						</span>
						<span class="engine-state" class:ok={providersState.elevenLabsReady}>
							{providersState.elevenLabsReady ? 'Key saved' : 'API key required'}
						</span>
					</button>
					{#if providersState.speechEngine === 'elevenlabs'}
						<div class="engine-config">
							<div class="engine-models" role="group" aria-label="ElevenLabs model">
								{#each ELEVENLABS_MODELS as model (model.id)}
									<button
										type="button"
										class="engine-model"
										class:selected={providersState.elevenLabsModelId === model.id}
										aria-pressed={providersState.elevenLabsModelId === model.id}
										onclick={() => void providersState.setElevenLabsModel(model.id)}
									>
										<strong>{model.label}</strong>
										<small>{model.tagline}</small>
									</button>
								{/each}
							</div>
							<ApiKeyField
								label="ElevenLabs API key"
								placeholder="sk_…"
								keyUrl="https://elevenlabs.io/app/settings/api-keys"
								hasKey={providersState.elevenLabsReady}
								isDevKey={providersState.isDevKey('elevenlabs')}
								onSave={saveElevenLabsKey}
								onClear={() => saveElevenLabsKey('')}
								onTest={testElevenLabsKey}
							/>
							{#if elUsage && elUsage.limit > 0}
								<div class="el-usage">
									<div>
										<strong>{elUsage.tier} plan</strong>
										<span>
											{elUsage.used.toLocaleString()} of {elUsage.limit.toLocaleString()} characters used
											· resets {elUsage.resetsAt.toLocaleDateString()}
										</span>
									</div>
									<progress max={elUsage.limit} value={elUsage.used}></progress>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</section>

		<section class="settings-section" aria-labelledby="engine-title">
			<header class="section-title">
				<div>
					<h2 id="engine-title">On-device engine</h2>
					<p>Downloaded once, then everything runs in this browser — even offline.</p>
				</div>
				<span class="runtime-state" class:ready={installed}>
					<span></span>{installed ? 'Installed' : 'Not installed'}
				</span>
			</header>

			<div class="engine-hero">
				<div class="engine-name">
					<span><Mic2 size={20} /></span>
					<div>
						<h3>{model.name}</h3>
						<p>{model.description}</p>
					</div>
				</div>
				<div class="engine-facts">
					<span><strong>{model.sizeMb} MB</strong><small>download</small></span>
					<span><strong>{model.languages.length}</strong><small>languages</small></span>
					<span><strong>{model.voices.length}</strong><small>voices</small></span>
					<span><strong>fp32</strong><small>WebGPU</small></span>
				</div>
			</div>

			<div class="setting-row license-row">
				<div>
					<strong>OpenRAIL license</strong>
					<p>
						Review the model’s use restrictions before the one-time download.
						<a href={model.licenseUrl} target="_blank" rel="external noreferrer">
							Open terms <ArrowUpRight size={12} />
						</a>
					</p>
				</div>
				<label class="check-control">
					<input type="checkbox" checked={licenseAccepted} onchange={updateLicense} />
					<span>I have reviewed the terms</span>
				</label>
			</div>

			{#if progress.status === 'loading'}
				<div class="install-progress" aria-live="polite">
					<div>
						<strong>{progress.message}</strong>
						<span>{Math.round(progress.progress)}%</span>
					</div>
					<progress max="100" value={progress.progress}></progress>
					<small>{progress.file ?? 'Preparing model files'}</small>
				</div>
			{:else if progress.status === 'error'}
				<div class="inline-error" role="alert">
					<AlertTriangle size={15} />
					<span>{friendlyError(progress.message)}</span>
				</div>
			{/if}

			<footer class="section-actions">
				<p>{appState.capabilities.webgpu ? 'Runs on WebGPU' : 'Runs on the WASM fallback'}</p>
				<div>
					{#if busy}
						<button class="button" type="button" onclick={cancelInstall}>
							<Square size={13} fill="currentColor" /> Stop
						</button>
					{:else if installed}
						<span class="installed-mark"><Check size={14} /> Ready to read</span>
						<button class="button danger" type="button" onclick={remove}>
							<Trash2 size={14} /> Remove
						</button>
					{:else}
						<button
							class="button primary"
							type="button"
							disabled={!licenseAccepted}
							onclick={install}
						>
							<Download size={15} />
							{progress.status === 'error' ? 'Retry install' : 'Install locally'}
						</button>
					{/if}
				</div>
			</footer>
		</section>

		{#if providersState.speechEngine === 'elevenlabs'}
			<section class="settings-section voices-section" aria-labelledby="el-voices-title">
				<header class="section-title">
					<div>
						<h2 id="el-voices-title">ElevenLabs voices</h2>
						<p>Preview each voice, then choose the one the reader uses.</p>
					</div>
					<button
						class="button"
						type="button"
						disabled={!providersState.elevenLabsReady}
						onclick={() => void refreshElevenLabs()}
					>
						<RefreshCw size={14} /> Refresh
					</button>
				</header>
				{#if providersState.elevenLabsVoices.length}
					<ul class="voice-list" aria-label="ElevenLabs voices">
						{#each providersState.elevenLabsVoices as voice (voice.id)}
							<li class="voice-row" class:selected={providersState.elevenLabsVoiceId === voice.id}>
								<button
									class="voice-choice"
									type="button"
									aria-label={`Use ${voice.name}`}
									aria-pressed={providersState.elevenLabsVoiceId === voice.id}
									onclick={() => void player.chooseVoice(voice.id)}
								>
									<span class="voice-initial">{voice.name.charAt(0)}</span>
									<span class="voice-copy">
										<strong>{voice.name}</strong>
										<small>{voice.description || 'ElevenLabs voice'}</small>
									</span>
									<span class="voice-check" aria-hidden="true"><Check size={13} /></span>
								</button>
								<button
									class="preview-button"
									class:active={elPreviewVoiceId === voice.id}
									type="button"
									disabled={!voice.previewUrl}
									aria-label={elPreviewVoiceId === voice.id
										? `Stop ${voice.name} preview`
										: `Preview ${voice.name}`}
									onclick={() => previewElevenLabsVoice(voice)}
								>
									{#if elPreviewVoiceId === voice.id}
										<Square size={12} fill="currentColor" />
									{:else}
										<Play size={15} fill="currentColor" />
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{:else}
					<div class="setting-row">
						<div>
							<strong>No voices yet</strong>
							<p>
								{providersState.elevenLabsReady
									? 'Refreshing the voice list from your ElevenLabs account…'
									: 'Save your ElevenLabs API key above to load your voices.'}
							</p>
						</div>
					</div>
				{/if}
			</section>
		{:else}
			<section class="settings-section voices-section" aria-labelledby="voices-title">
				<header class="section-title">
					<div>
						<h2 id="voices-title">Built-in voices</h2>
						<p>Listen here, then choose the voice you want to use in the reader.</p>
					</div>
					<span class="voice-status">
						{#if previewState === 'loading' && previewVoiceId}
							Preparing {model.voices.find((voice) => voice.id === previewVoiceId)?.name} · {Math.round(
								previewProgress
							)}%
						{:else if previewState === 'playing' && previewVoiceId}
							Playing {model.voices.find((voice) => voice.id === previewVoiceId)?.name}
						{:else}
							{model.voices.length} voices
						{/if}
					</span>
				</header>
				<p class="sr-only" aria-live="polite">{previewAnnouncement}</p>
				<ul class="voice-list" aria-label="Available voices">
					{#each model.voices as voice (voice.id)}
						<li class="voice-row" class:selected={appState.selectedVoiceId === voice.id}>
							<button
								class="voice-choice"
								type="button"
								aria-label={`Use ${voice.name}`}
								aria-pressed={appState.selectedVoiceId === voice.id}
								onclick={() => void appState.selectVoice(voice.id)}
							>
								<span class="voice-initial">{voice.name.charAt(0)}</span>
								<span class="voice-copy">
									<strong>{voice.name}</strong>
									<small>{voice.gender ?? 'Voice'} · multilingual</small>
								</span>
								<span class="voice-check" aria-hidden="true"><Check size={13} /></span>
							</button>
							<button
								class="preview-button"
								class:active={voice.id === previewVoiceId}
								type="button"
								disabled={!installed || busy}
								aria-label={previewButtonLabel(voice)}
								title={installed
									? previewButtonLabel(voice)
									: 'Install Supertonic 3 to preview voices'}
								onclick={() => void previewVoice(voice)}
							>
								{#if voice.id === previewVoiceId && previewState === 'loading'}
									<LoaderCircle class="spin" size={15} />
								{:else if voice.id === previewVoiceId && previewState === 'playing'}
									<Square size={12} fill="currentColor" />
								{:else}
									<Play size={15} fill="currentColor" />
								{/if}
							</button>
						</li>
					{/each}
				</ul>
				{#if previewError}
					<div class="inline-error preview-error" role="alert">
						<AlertTriangle size={15} />
						<span>{previewError}</span>
					</div>
				{/if}
			</section>
		{/if}
	{:else if activeSection === 'llm'}
		<section class="settings-section" aria-labelledby="llm-engine-title">
			<header class="section-title">
				<div>
					<h2 id="llm-engine-title">Descriptions engine</h2>
					<p>On-device is free and private. Cloud engines use your own key, sent only there.</p>
				</div>
				<span class="runtime-state" class:ready={narrationState.engineAvailable}>
					<span></span>{narrationState.engineAvailable ? 'Ready' : 'Not configured'}
				</span>
			</header>

			<div class="engine-list" role="radiogroup" aria-label="Descriptions engine">
				<div class="engine-option" class:selected={providersState.descriptionEngine === 'local'}>
					<button
						class="engine-row"
						type="button"
						role="radio"
						aria-checked={providersState.descriptionEngine === 'local'}
						onclick={() => void chooseDescriptionEngine('local')}
					>
						<span class="engine-radio" aria-hidden="true"></span>
						<span class="engine-icon"><BrainCircuit size={16} /></span>
						<span class="engine-copy">
							<strong>On-device</strong>
							<small>Private and free — runs on this computer’s GPU</small>
						</span>
						<span class="engine-state" class:ok={llmState.eligible && llmState.installed}>
							{!llmState.eligible
								? 'Unavailable on this device'
								: llmState.installed
									? 'Ready'
									: 'Not installed'}
						</span>
					</button>
				</div>
				{#each CLOUD_LLM_PROVIDERS as spec (spec.id)}
					{@const active = providersState.descriptionEngine === spec.id}
					<div class="engine-option" class:selected={active}>
						<button
							class="engine-row"
							type="button"
							role="radio"
							aria-checked={active}
							onclick={() => void chooseDescriptionEngine(spec.id)}
						>
							<span class="engine-radio" aria-hidden="true"></span>
							<span class="engine-icon cloud"><Cloud size={16} /></span>
							<span class="engine-copy">
								<strong>{spec.label} <em>· {spec.vendor}</em></strong>
								<small>{spec.tagline}</small>
							</span>
							<span class="engine-state" class:ok={providersState.hasKey(spec.id)}>
								{providersState.hasKey(spec.id) ? 'Key saved' : 'API key required'}
							</span>
						</button>
						{#if active}
							<div class="engine-config">
								<div class="engine-models" role="group" aria-label={`${spec.label} model`}>
									{#each spec.models as model (model.id)}
										<button
											type="button"
											class="engine-model"
											class:selected={providersState.cloudLlmModelFor(spec.id) === model.id}
											aria-pressed={providersState.cloudLlmModelFor(spec.id) === model.id}
											onclick={() => void chooseCloudModel(spec.id, model.id)}
										>
											<strong>{model.label}</strong>
											<small>{model.tagline}</small>
										</button>
									{/each}
								</div>
								<ApiKeyField
									label={`${spec.vendor} API key`}
									placeholder={spec.keyPlaceholder}
									keyUrl={spec.keyUrl}
									hasKey={providersState.hasKey(spec.id)}
									isDevKey={providersState.isDevKey(spec.id)}
									onSave={(value) => saveProviderKey(spec.id, value)}
									onClear={() => saveProviderKey(spec.id, '')}
									onTest={() => verifyCloudLlmKey(spec.id, providersState.keyFor(spec.id) ?? '')}
								/>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<section class="settings-section" aria-labelledby="llm-models-title">
			<header class="section-title">
				<div>
					<h2 id="llm-models-title">On-device models</h2>
					<p>Downloaded once, then everything runs in this browser.</p>
				</div>
				<span class="runtime-state" class:ready={llmState.installed}>
					<span></span>
					{llmState.phase === 'probing'
						? 'Warming up…'
						: llmState.installed
							? 'Installed'
							: 'Not installed'}
				</span>
			</header>

			{#if !llmState.eligible}
				<div class="setting-row">
					<div>
						<strong>Not available on this device</strong>
						<p>
							{llmState.policy.reason ?? 'The language model needs a desktop browser with WebGPU.'}
							A cloud engine above still works here.
						</p>
					</div>
					<span class="capability-label"><Cpu size={15} /> WebGPU required</span>
				</div>
			{:else}
				<div class="llm-grid">
					{#each LLM_CATALOG as spec (spec.id)}
						{@const specInstalled = llmState.installedModels.includes(spec.id)}
						{@const specSelected = llmState.selectedModelId === spec.id}
						{@const specActivating = llmActivating && llmState.activeModelId === spec.id}
						{@const offer = llmState.canOffer(spec)}
						<article
							class="llm-card"
							class:selected={specSelected}
							class:unavailable={!offer.ok}
							aria-label={`${spec.label} language model`}
						>
							<header class="llm-card-head">
								<span class="llm-card-icon"><BrainCircuit size={19} /></span>
								<div class="llm-card-name">
									<h3>{spec.label}</h3>
									<p>{spec.tagline}</p>
								</div>
								{#if specSelected && llmState.ready}
									<span class="llm-card-state active">Active</span>
								{:else if specSelected}
									<span class="llm-card-state">Selected</span>
								{:else if specInstalled}
									<span class="llm-card-state">Installed</span>
								{/if}
							</header>

							<dl class="llm-card-facts">
								<div>
									<dt>Download</dt>
									<dd>{spec.sizeMb} MB</dd>
								</div>
								<div>
									<dt>Precision</dt>
									<dd>{spec.dtype}</dd>
								</div>
								<div>
									<dt>License</dt>
									<dd>
										<a href={spec.licenseUrl} target="_blank" rel="external noreferrer">
											{spec.license}
											<ArrowUpRight size={11} />
										</a>
									</dd>
								</div>
							</dl>

							{#if specActivating}
								<div class="install-progress" aria-live="polite">
									<div>
										<strong>
											{llmState.phase === 'downloading'
												? 'Downloading… keep this tab open.'
												: llmState.phase === 'probing'
													? 'Warming up the model…'
													: 'Loading model files…'}
										</strong>
										<span>{llmState.download ? `${llmState.download.percent}%` : ''}</span>
									</div>
									<progress max="100" value={llmState.download?.percent ?? 0}></progress>
									<small>{llmState.download?.file ?? 'Preparing model files'}</small>
								</div>
							{:else if !specInstalled}
								<label class="check-control llm-card-license">
									<input
										type="checkbox"
										checked={llmState.acceptedLicenses.includes(spec.id)}
										onchange={(event) => updateLlmLicense(spec, event)}
									/>
									<span>I have reviewed the license terms</span>
								</label>
							{/if}

							<footer class="llm-card-actions">
								{#if !offer.ok}
									<p class="llm-card-note">{offer.reason ?? 'Unavailable on this device'}</p>
								{:else if specActivating}
									<button class="button" type="button" onclick={cancelLlmInstall}>
										<Square size={13} fill="currentColor" /> Stop
									</button>
								{:else if specInstalled}
									{#if !specSelected}
										<button class="button primary" type="button" onclick={() => useLlm(spec)}>
											<Check size={14} /> Use this model
										</button>
									{/if}
									<button
										class="button danger"
										type="button"
										disabled={llmBusy}
										onclick={() => removeLlm(spec)}
									>
										<Trash2 size={14} /> Remove
									</button>
								{:else}
									<button
										class="button primary"
										type="button"
										disabled={!llmState.acceptedLicenses.includes(spec.id) || llmBusy}
										onclick={() => installLlm(spec)}
									>
										<Download size={15} /> Download · {spec.sizeMb} MB
									</button>
								{/if}
							</footer>
						</article>
					{/each}
				</div>

				{#if llmError || llmState.error}
					<div class="inline-error" role="alert">
						<AlertTriangle size={15} />
						<span>{llmError || llmState.error}</span>
					</div>
				{/if}
			{/if}
		</section>

		<section class="settings-section" aria-labelledby="llm-behavior-title">
			<header class="section-title">
				<div>
					<h2 id="llm-behavior-title">Behavior</h2>
					<p>How Voicebook uses the language model while you read.</p>
				</div>
			</header>

			<div class="setting-row">
				<div>
					<strong>Describe visuals automatically</strong>
					<p>
						When a document contains equations, tables, or diagrams, rewrite them in the background
						as soon as it opens.
					</p>
				</div>
				<label class="check-control">
					<input
						type="checkbox"
						checked={llmState.narrationEnabled}
						disabled={!narrationState.engineAvailable}
						onchange={toggleNarrationEnabled}
					/>
					<span>{llmState.narrationEnabled ? 'On' : 'Off'}</span>
				</label>
			</div>

			{#if narrationState.error}
				<div class="inline-error" role="alert">
					<AlertTriangle size={15} />
					<span>{narrationState.error}</span>
				</div>
			{/if}

			<footer class="section-actions">
				<p>Descriptions are stored with each document and only change when the source changes.</p>
				<div>
					<button
						class="button"
						type="button"
						disabled={regenerating || !narrationState.engineAvailable}
						onclick={regenerateNarrations}
					>
						{#if regenerating}<LoaderCircle class="spin" size={15} />{:else}<RefreshCw
								size={15}
							/>{/if}
						Regenerate all descriptions
					</button>
				</div>
			</footer>
		</section>

		<section class="settings-section" aria-labelledby="llm-prompts-title">
			<header class="section-title">
				<div>
					<h2 id="llm-prompts-title">Prompts</h2>
					<p>
						Exactly what the model is asked, per element type. Edited prompts rewrite documents the
						next time they open.
					</p>
				</div>
			</header>

			{#each PROMPT_FIELDS as field (field.key)}
				<div class="prompt-editor">
					<div class="prompt-editor-head">
						<div>
							<strong>{field.label}</strong>
							{#if promptCustom(field.key)}<span class="prompt-custom-badge">Custom</span>{/if}
							<p>{field.hint}</p>
						</div>
						<div class="prompt-editor-actions">
							{#if promptSavedKey === field.key}
								<span class="installed-mark"><Check size={13} /> Saved</span>
							{/if}
							<button
								class="button"
								type="button"
								disabled={!promptCustom(field.key) && !promptDirty(field.key)}
								onclick={() => resetPrompt(field.key)}
							>
								Reset
							</button>
							<button
								class="button primary"
								type="button"
								disabled={!promptDirty(field.key)}
								onclick={() => savePrompt(field.key)}
							>
								Save
							</button>
						</div>
					</div>
					<textarea
						rows={field.key === 'system' ? 6 : 4}
						spellcheck="false"
						aria-label={`${field.label} prompt template`}
						bind:value={promptDrafts[field.key]}></textarea>
				</div>
			{/each}
		</section>
	{:else if activeSection === 'storage'}
		<section class="settings-section" aria-labelledby="storage-title">
			<header class="section-title">
				<div>
					<h2 id="storage-title">Browser storage</h2>
					<p>Voicebook’s private storage area on this device.</p>
				</div>
				<span class="runtime-state" class:ready={appState.storage.persisted}>
					<span></span>{appState.storage.persisted ? 'Persistent' : 'Best effort'}
				</span>
			</header>

			<div class="storage-total">
				<div>
					<strong>{bytes(appState.storage.usage)}</strong>
					<span>used of {bytes(appState.storage.quota)} available</span>
				</div>
				<progress max={Math.max(1, appState.storage.quota)} value={appState.storage.usage}
				></progress>
			</div>

			<div class="setting-row">
				<div>
					<strong>Document metadata</strong>
					<p>Titles, semantic blocks, bookmarks, and reading positions.</p>
				</div>
				<Database size={16} />
			</div>
			<div class="setting-row">
				<div>
					<strong>Original source files</strong>
					<p>PDF, DOCX, Markdown, and text files retained for local recovery.</p>
				</div>
				<HardDrive size={16} />
			</div>
			<div class="setting-row">
				<div>
					<strong>Generated speech</strong>
					<p>Audio cached by document, engine revision, voice, and backend.</p>
				</div>
				<Mic2 size={16} />
			</div>
			{#if llmState.installedModels.length}
				<div class="setting-row">
					<div>
						<strong>Language model weights</strong>
						<p>
							{LLM_CATALOG.filter((spec) => llmState.installedModels.includes(spec.id))
								.map((spec) => `${spec.label} · ~${spec.sizeMb} MB`)
								.join(', ')} — cached once from Hugging Face. Remove under LLM.
						</p>
					</div>
					<BrainCircuit size={16} />
				</div>
			{/if}

			<footer class="section-actions">
				<p>Clearing audio does not remove documents, bookmarks, or reading progress.</p>
				<div>
					{#if !appState.storage.persisted}
						<button class="button" type="button" onclick={makePersistent}>
							<ShieldCheck size={15} /> Keep storage
						</button>
					{/if}
					<button class="button danger" type="button" disabled={storageBusy} onclick={clearAudio}>
						<Trash2 size={15} /> Clear audio
					</button>
				</div>
			</footer>
		</section>
	{:else}
		<section class="settings-section" aria-labelledby="capabilities-title">
			<header class="section-title">
				<div>
					<h2 id="capabilities-title">Browser capabilities</h2>
					<p>Detected locally. No device fingerprint is sent anywhere.</p>
				</div>
			</header>

			<div class="capability-list">
				<div>
					<Cpu size={17} />
					<span><strong>WebGPU</strong><small>Hardware-accelerated inference</small></span>
					<b class:available={appState.capabilities.webgpu}>
						{appState.capabilities.webgpu ? 'Available' : 'Unavailable'}
					</b>
				</div>
				<div>
					<Gauge size={17} />
					<span><strong>16-bit shaders</strong><small>Optional GPU feature</small></span>
					<b class:available={appState.capabilities.shaderF16}>
						{appState.capabilities.shaderF16 ? 'Available' : 'Unavailable'}
					</b>
				</div>
				<div>
					<Mic2 size={17} />
					<span><strong>WebCodecs</strong><small>Compact Opus audio cache</small></span>
					<b class:available={appState.capabilities.webCodecs}>
						{appState.capabilities.webCodecs ? 'Available' : 'WAV fallback'}
					</b>
				</div>
				<div>
					<Database size={17} />
					<span
						><strong>Private file storage</strong><small>Origin-private source files</small></span
					>
					<b class:available={appState.capabilities.opfs}>
						{appState.capabilities.opfs ? 'Available' : 'IndexedDB'}
					</b>
				</div>
			</div>
		</section>

		<section class="settings-section diagnostics-section" aria-labelledby="diagnostics-title">
			<header class="section-title">
				<div>
					<h2 id="diagnostics-title"><Bug size={16} /> Local diagnostics</h2>
					<p>
						Records model loading, speech generation, worker errors, and interrupted browser
						sessions on this device. Nothing is transmitted automatically.
					</p>
				</div>
				<button class="button" type="button" onclick={copyDiagnostics}>
					{#if diagnosticsCopied}<Check size={14} /> Copied{:else}<ClipboardCopy size={14} /> Copy report{/if}
				</button>
			</header>
			<details class="diagnostics-report">
				<summary>View recent runtime events</summary>
				<pre>{diagnosticReport || 'No runtime events have been recorded yet.'}</pre>
			</details>
		</section>

		<div class="two-column">
			<section class="settings-section compact" aria-labelledby="privacy-title">
				<header class="section-title">
					<div>
						<h2 id="privacy-title"><LockKeyhole size={16} /> Privacy</h2>
					</div>
				</header>
				<ul class="plain-list">
					<li><ShieldCheck size={14} /> Document content stays in this browser.</li>
					<li><Wifi size={14} /> Model downloads contact Hugging Face.</li>
					<li><Database size={14} /> No account, analytics, or cloud sync.</li>
				</ul>
			</section>
			<section class="settings-section compact" aria-labelledby="shortcuts-title">
				<header class="section-title">
					<div>
						<h2 id="shortcuts-title"><Keyboard size={16} /> Reader shortcuts</h2>
					</div>
				</header>
				<dl class="shortcut-list">
					<div>
						<dt>Play or pause</dt>
						<dd><kbd>Space</kbd></dd>
					</div>
					<div>
						<dt>Back / forward 10s</dt>
						<dd><kbd>J</kbd><kbd>L</kbd></dd>
					</div>
					<div>
						<dt>Bookmark</dt>
						<dd><kbd>B</kbd></dd>
					</div>
					<div>
						<dt>Speed</dt>
						<dd><kbd>[</kbd><kbd>]</kbd></dd>
					</div>
				</dl>
			</section>
		</div>
	{/if}
</div>

<style>
	.page-heading {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		max-width: 980px;
		margin-bottom: 30px;
	}

	.eyebrow {
		margin: 0 0 8px;
		color: var(--primary);
		font-size: 9px;
		font-weight: 720;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}

	.page-heading h1 {
		margin: 0;
		font-size: 2rem;
		font-weight: 660;
		letter-spacing: -0.045em;
	}

	.page-heading > div > p:last-child {
		margin: 6px 0 0;
		color: var(--muted);
		font-size: 11px;
	}

	.settings-section {
		max-width: 980px;
		border-top: 1px solid var(--line-strong);
	}

	.settings-section + .settings-section {
		margin-top: 42px;
	}

	.section-title {
		display: flex;
		min-height: 74px;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		border-bottom: 1px solid var(--line);
	}

	.section-title h2,
	.section-title p {
		margin: 0;
	}

	.section-title h2 {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 650;
	}

	.section-title p {
		margin-top: 5px;
		color: var(--faint);
		font-size: 9px;
	}

	.section-title > span {
		color: var(--faint);
		font-size: 9px;
	}

	.runtime-state {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		color: var(--faint);
		font-size: 9px;
		font-weight: 620;
	}

	.runtime-state > span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--faint);
	}

	.runtime-state.ready {
		color: var(--success);
	}

	.runtime-state.ready > span {
		background: var(--success);
	}

	.engine-hero {
		display: grid;
		min-height: 128px;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 28px;
		border-bottom: 1px solid var(--line);
	}

	.llm-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 14px;
		margin-top: 16px;
	}

	.llm-card {
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface, transparent) 60%, transparent);
		transition:
			border-color 150ms var(--ease),
			box-shadow 150ms var(--ease);
	}

	.llm-card.selected {
		border-color: color-mix(in srgb, var(--primary) 55%, var(--line));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent);
	}

	.llm-card.unavailable {
		opacity: 0.6;
	}

	.llm-card-head {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.llm-card-icon {
		display: grid;
		width: 38px;
		height: 38px;
		flex: 0 0 38px;
		place-items: center;
		border-radius: 9px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.llm-card-name {
		min-width: 0;
		flex: 1;
	}

	.llm-card-name h3 {
		margin: 0;
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.02em;
	}

	.llm-card-name p {
		margin: 2px 0 0;
		color: var(--muted);
		font-size: 10.5px;
	}

	.llm-card-state {
		flex: none;
		padding: 3px 9px;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		color: var(--muted);
		font-size: 9.5px;
		font-weight: 650;
		letter-spacing: 0.02em;
	}

	.llm-card-state.active {
		border-color: transparent;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.llm-card-facts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: 9px;
		margin: 0;
		gap: 8px;
	}

	.llm-card-facts dt {
		color: var(--faint);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.llm-card-facts dd {
		margin: 3px 0 0;
		font-size: 11px;
		font-weight: 620;
		white-space: nowrap;
	}

	.llm-card-facts dd a {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.llm-card-license {
		font-size: 10.5px;
	}

	.llm-card-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		margin-top: auto;
		gap: 8px;
	}

	.llm-card-note {
		margin: 0 auto 0 0;
		color: var(--faint);
		font-size: 10px;
	}

	.engine-list {
		display: grid;
		gap: 10px;
		margin-top: 16px;
	}

	.engine-option {
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: color-mix(in srgb, var(--surface, transparent) 60%, transparent);
		transition:
			border-color 150ms var(--ease),
			box-shadow 150ms var(--ease);
	}

	.engine-option.selected {
		border-color: color-mix(in srgb, var(--primary) 55%, var(--line));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 35%, transparent);
	}

	.engine-row {
		display: flex;
		width: 100%;
		min-height: 62px;
		align-items: center;
		gap: 13px;
		padding: 10px 16px;
		border: 0;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		text-align: left;
	}

	.engine-row:hover {
		background: var(--hover);
	}

	.engine-radio {
		display: grid;
		width: 15px;
		height: 15px;
		flex: none;
		place-items: center;
		border: 1.5px solid var(--line-strong);
		border-radius: 50%;
	}

	.engine-option.selected .engine-radio {
		border-color: var(--primary);
	}

	.engine-option.selected .engine-radio::after {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--primary);
		content: '';
	}

	.engine-icon {
		display: grid;
		width: 32px;
		height: 32px;
		flex: none;
		place-items: center;
		border-radius: 8px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.engine-icon.cloud {
		background: var(--hover-strong, var(--hover));
		color: var(--muted);
	}

	.engine-copy {
		min-width: 0;
		flex: 1;
	}

	.engine-copy strong {
		display: block;
		font-size: 11.5px;
		font-weight: 650;
	}

	.engine-copy strong em {
		color: var(--faint);
		font-size: 10px;
		font-style: normal;
		font-weight: 550;
	}

	.engine-copy small {
		display: block;
		margin-top: 2px;
		color: var(--faint);
		font-size: 9px;
	}

	.engine-state {
		flex: none;
		padding: 3px 9px;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		color: var(--muted);
		font-size: 9px;
		font-weight: 650;
	}

	.engine-state.ok {
		border-color: transparent;
		background: color-mix(in srgb, var(--success) 14%, transparent);
		color: var(--success);
	}

	.engine-config {
		display: grid;
		gap: 14px;
		padding: 14px 16px 16px;
		border-top: 1px solid var(--line);
	}

	.engine-models {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 8px;
	}

	.engine-model {
		padding: 10px 12px;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.engine-model:hover {
		color: var(--text);
	}

	.engine-model.selected {
		border-color: color-mix(in srgb, var(--primary) 60%, var(--line-strong));
		background: color-mix(in srgb, var(--primary) 7%, transparent);
		color: var(--text);
	}

	.engine-model strong {
		display: block;
		font-size: 10.5px;
		font-weight: 650;
	}

	.engine-model small {
		display: block;
		margin-top: 2px;
		color: var(--faint);
		font-size: 8.5px;
	}

	.el-usage {
		display: grid;
		gap: 7px;
		padding: 11px 13px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}

	.el-usage strong {
		font-size: 10px;
		font-weight: 650;
		text-transform: capitalize;
	}

	.el-usage span {
		display: block;
		margin-top: 2px;
		color: var(--faint);
		font-size: 9px;
	}

	.el-usage progress {
		width: 100%;
		height: 5px;
	}

	.prompt-editor {
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
	}

	.prompt-editor:last-child {
		border-bottom: 0;
	}

	.prompt-editor-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 8px;
	}

	.prompt-editor-head strong {
		font-size: 12px;
		font-weight: 650;
	}

	.prompt-editor-head p {
		margin: 3px 0 0;
		color: var(--faint);
		font-size: 10px;
	}

	.prompt-custom-badge {
		display: inline-block;
		padding: 2px 7px;
		border-radius: 999px;
		margin-left: 8px;
		background: var(--primary-soft);
		color: var(--primary);
		font-size: 9px;
		font-weight: 650;
		vertical-align: 1px;
	}

	.prompt-editor-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
	}

	.prompt-editor textarea {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--control-border);
		border-radius: 8px;
		background: var(--control);
		color: var(--text);
		font-family: ui-monospace, 'SF Mono', Menlo, monospace;
		font-size: 11px;
		line-height: 1.55;
		resize: vertical;
	}

	.prompt-editor textarea:focus-visible {
		border-color: var(--primary);
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}

	.engine-name {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.engine-name > span {
		display: grid;
		width: 42px;
		height: 42px;
		place-items: center;
		border-radius: 7px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.engine-name h3 {
		margin: 0;
		font-size: 18px;
		font-weight: 650;
		letter-spacing: -0.03em;
	}

	.engine-name p {
		max-width: 470px;
		margin: 5px 0 0;
		color: var(--muted);
		font-size: 10px;
		line-height: 1.5;
	}

	.engine-facts {
		display: flex;
		gap: 28px;
	}

	.engine-facts span,
	.engine-facts strong,
	.engine-facts small {
		display: block;
	}

	.engine-facts strong {
		font-size: 11px;
		font-weight: 650;
	}

	.engine-facts small {
		margin-top: 4px;
		color: var(--faint);
		font-size: 8px;
	}

	.setting-row {
		display: flex;
		min-height: 78px;
		align-items: center;
		justify-content: space-between;
		gap: 28px;
		border-bottom: 1px solid var(--line);
		color: var(--faint);
	}

	.setting-row strong,
	.setting-row p {
		display: block;
		margin: 0;
	}

	.setting-row strong {
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 630;
	}

	.setting-row p {
		margin-top: 4px;
		color: var(--faint);
		font-size: 9px;
		line-height: 1.45;
	}

	.setting-row a {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin-left: 4px;
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.check-control,
	.capability-label {
		display: flex;
		align-items: center;
		gap: 9px;
		color: var(--text-soft);
		font-size: 9px;
		font-weight: 600;
	}

	.check-control {
		min-height: 44px;
	}

	.check-control input {
		flex: 0 0 auto;
	}

	.install-progress {
		display: grid;
		gap: 8px;
		padding: 16px 0;
		border-bottom: 1px solid var(--line);
	}

	.install-progress > div {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		color: var(--muted);
		font-size: 9px;
	}

	.install-progress progress {
		width: 100%;
		height: 4px;
		accent-color: var(--primary);
	}

	.install-progress small {
		overflow: hidden;
		color: var(--faint);
		font-size: 8px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.inline-error {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
		color: var(--danger);
		font-size: 9px;
		line-height: 1.5;
	}

	.section-actions {
		display: flex;
		min-height: 76px;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
	}

	.section-actions p {
		margin: 0;
		color: var(--faint);
		font-size: 8px;
	}

	.section-actions > div {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.installed-mark {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-right: 5px;
		color: var(--success);
		font-size: 9px;
		font-weight: 640;
	}

	.voice-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.voice-row {
		display: grid;
		min-width: 0;
		grid-template-columns: minmax(0, 1fr) 44px;
		align-items: center;
		border-bottom: 1px solid var(--line);
	}

	.voice-row:nth-child(odd) {
		padding-right: 18px;
	}

	.voice-row:nth-child(even) {
		padding-left: 18px;
	}

	.voice-choice,
	.preview-button {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.voice-choice {
		display: grid;
		min-width: 0;
		min-height: 68px;
		grid-template-columns: auto minmax(0, 1fr) 22px;
		align-items: center;
		gap: 10px;
		padding: 0 6px 0 0;
		text-align: left;
		transition: color 160ms var(--ease);
	}

	.voice-choice:hover {
		color: var(--text);
	}

	.voice-initial {
		display: grid;
		width: 30px;
		height: 30px;
		place-items: center;
		border-radius: 50%;
		background: var(--hover-strong);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		transition:
			background 160ms var(--ease),
			color 160ms var(--ease);
	}

	.voice-copy {
		display: block;
		min-width: 0;
	}

	.voice-copy strong,
	.voice-copy small {
		display: block;
	}

	.voice-copy strong {
		color: var(--text-soft);
		font-size: 9px;
		font-weight: 630;
	}

	.voice-copy small {
		margin-top: 3px;
		color: var(--faint);
		font-size: 8px;
	}

	.voice-check {
		display: grid;
		width: 20px;
		height: 20px;
		place-items: center;
		border-radius: 50%;
		color: transparent;
		transition:
			background 160ms var(--ease),
			color 160ms var(--ease);
	}

	.voice-row.selected .voice-initial,
	.voice-row.selected .voice-check {
		background: var(--primary-soft);
		color: var(--primary);
	}

	.preview-button {
		display: grid;
		width: 44px;
		height: 44px;
		place-items: center;
		border-radius: 50%;
		color: var(--muted);
		transition:
			background 160ms var(--ease),
			color 160ms var(--ease);
	}

	.preview-button:hover:not(:disabled),
	.preview-button.active {
		background: var(--hover-strong);
		color: var(--primary);
	}

	.preview-button:disabled {
		cursor: not-allowed;
		opacity: 0.38;
	}

	.voice-status {
		min-width: 120px;
		text-align: right;
	}

	.preview-error {
		padding-inline: 2px;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.storage-total {
		display: grid;
		min-height: 140px;
		grid-template-columns: minmax(220px, 0.45fr) 1fr;
		align-items: center;
		gap: 36px;
		border-bottom: 1px solid var(--line);
	}

	.storage-total strong,
	.storage-total span {
		display: block;
	}

	.storage-total strong {
		font-size: 2rem;
		font-weight: 660;
		letter-spacing: -0.05em;
	}

	.storage-total span {
		margin-top: 5px;
		color: var(--muted);
		font-size: 9px;
	}

	.storage-total progress {
		width: 100%;
		height: 5px;
		accent-color: var(--primary);
	}

	.capability-list > div {
		display: grid;
		min-height: 70px;
		grid-template-columns: 28px 1fr auto;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--line);
		color: var(--faint);
	}

	.capability-list strong,
	.capability-list small {
		display: block;
	}

	.capability-list strong {
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 630;
	}

	.capability-list small {
		margin-top: 3px;
		font-size: 8px;
	}

	.capability-list b {
		color: var(--faint);
		font-size: 9px;
		font-weight: 620;
	}

	.capability-list b.available {
		color: var(--success);
	}

	.diagnostics-section {
		margin-top: 42px;
	}

	.diagnostics-section .section-title h2 {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.diagnostics-report {
		padding: 14px 0;
		border-bottom: 1px solid var(--line);
	}

	.diagnostics-report summary {
		color: var(--muted);
		font-size: 9px;
		font-weight: 620;
		cursor: pointer;
	}

	.diagnostics-report pre {
		max-height: 280px;
		overflow: auto;
		padding: 14px;
		margin: 12px 0 0;
		border-radius: 6px;
		background: var(--control-strong);
		color: var(--text-soft);
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 8px;
		line-height: 1.6;
		white-space: pre-wrap;
	}

	.two-column {
		display: grid;
		max-width: 980px;
		grid-template-columns: 1fr 1fr;
		gap: 34px;
		margin-top: 42px;
	}

	.settings-section.compact {
		margin-top: 0;
	}

	.plain-list {
		display: grid;
		gap: 0;
		padding: 0;
		margin: 0;
		list-style: none;
	}

	.plain-list li {
		display: flex;
		min-height: 52px;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--line);
		color: var(--muted);
		font-size: 9px;
	}

	.shortcut-list {
		margin: 0;
	}

	.shortcut-list > div {
		display: flex;
		min-height: 52px;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid var(--line);
	}

	.shortcut-list dt {
		color: var(--muted);
		font-size: 9px;
	}

	.shortcut-list dd {
		display: flex;
		gap: 4px;
		margin: 0;
	}

	kbd {
		display: grid;
		min-width: 24px;
		height: 23px;
		place-items: center;
		border-radius: 4px;
		background: var(--hover-strong);
		color: var(--text-soft);
		font-size: 8px;
		font-weight: 650;
	}

	@media (max-width: 900px) {
		.engine-hero {
			grid-template-columns: 1fr;
			padding: 24px 0;
		}

		.engine-facts {
			justify-content: space-between;
		}
	}

	@media (max-width: 680px) {
		.page-heading,
		.section-actions,
		.setting-row {
			align-items: flex-start;
			flex-direction: column;
		}

		.setting-row {
			padding: 18px 0;
		}

		.section-actions {
			padding: 18px 0;
		}

		.engine-facts {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}

		.storage-total,
		.two-column {
			grid-template-columns: 1fr;
		}

		.storage-total {
			padding: 24px 0;
		}

		.voice-list {
			grid-template-columns: 1fr;
		}

		.voice-row:nth-child(odd),
		.voice-row:nth-child(even) {
			padding: 0;
		}

		.voice-status {
			display: none;
		}
	}
</style>
