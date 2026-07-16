<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		AudioLines,
		BrainCircuit,
		Check,
		Download,
		LoaderCircle,
		Mic2,
		Play,
		ShieldCheck,
		Square
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import ApiKeyField from '$lib/components/ApiKeyField.svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import ProviderLogo from '$lib/components/ProviderLogo.svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { DEFAULT_LLM_ID, getLlmModel } from '$lib/domain/llm-catalog';
	import {
		CLOUD_LLM_PROVIDERS,
		getCloudLlmProvider,
		isCloudLlmProvider,
		type CloudLlmProvider
	} from '$lib/domain/provider-catalog';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { providersState } from '$lib/state/providers.svelte';

	let { compact = false } = $props<{ compact?: boolean }>();

	const model = getModel('supertonic-3');
	const llmSpec = getLlmModel(DEFAULT_LLM_ID)!;

	/* Each engine picks its source; the footer adapts to what that implies. */
	type VoiceChoice = 'local' | 'cloud';
	type DescChoice = 'local' | 'cloud' | 'skip';
	let voiceChoice = $state<VoiceChoice>('local');
	let pickedDescChoice = $state<DescChoice>();
	let descProvider = $state<CloudLlmProvider>('anthropic');

	let busy = $state(false);
	let localError = $state('');
	let llmError = $state('');
	let stage = $state<'idle' | 'speech' | 'llm'>('idle');
	let progress = $derived(appState.modelProgress['supertonic-3']);
	let speechInstalled = $derived(appState.installedModels.includes('supertonic-3'));
	let llmEligible = $derived(llmState.eligible);
	let llmInstalled = $derived(llmState.installedModels.includes(llmSpec.id));
	let installingSpeech = $derived(stage === 'speech' || progress.status === 'loading');
	let installingLlm = $derived(
		stage === 'llm' ||
			(llmState.activeModelId === llmSpec.id &&
				(llmState.phase === 'downloading' ||
					llmState.phase === 'loading' ||
					llmState.phase === 'probing'))
	);
	let installing = $derived(busy || installingSpeech || installingLlm);

	// The reader's compact strip installs the local pair without choices; the
	// full page defaults to on-device where the hardware allows it.
	let descChoice = $derived<DescChoice>(
		compact
			? 'local'
			: (pickedDescChoice ?? (llmEligible || !llmState.initialized ? 'local' : 'skip'))
	);

	let wantsVoiceDownload = $derived(voiceChoice === 'local' && !speechInstalled);
	let wantsLlmDownload = $derived(descChoice === 'local' && llmEligible && !llmInstalled);
	let totalMb = $derived(
		(wantsVoiceDownload ? model.sizeMb : 0) + (wantsLlmDownload ? llmSpec.sizeMb : 0)
	);
	// One consent covers the licenses of everything about to be downloaded.
	let consented = $derived(
		(!wantsVoiceDownload || appState.acceptedLicenses.includes('supertonic-3')) &&
			(!wantsLlmDownload || llmState.acceptedLicenses.includes(llmSpec.id))
	);
	let descSpec = $derived(getCloudLlmProvider(descProvider)!);
	let missingKeyHint = $derived(
		voiceChoice === 'cloud' && !providersState.hasKey('elevenlabs')
			? 'Save your ElevenLabs key to continue.'
			: descChoice === 'cloud' && !providersState.hasKey(descProvider)
				? `Save your ${descSpec.vendor} key to continue.`
				: ''
	);
	let downloadLabel = $derived(
		progress.status === 'error' && wantsVoiceDownload
			? 'Resume installation'
			: `Download · ${totalMb >= 1000 ? `${(totalMb / 1000).toFixed(1)} GB` : `${totalMb} MB`}`
	);

	onMount(() => {
		void llmState.initialize();
		void providersState.initialize().then(() => {
			// A prior partial setup picked engines already — reflect it.
			if (providersState.speechEngine === 'elevenlabs') voiceChoice = 'cloud';
			if (isCloudLlmProvider(providersState.descriptionEngine)) {
				pickedDescChoice = 'cloud';
				descProvider = providersState.descriptionEngine;
			}
		});
	});

	function friendlyError(message?: string): string {
		if (!message) return 'The voice engine could not be installed.';
		if (/out of memory|allocation|memory/i.test(message))
			return 'This browser ran out of working memory. Close other tabs, reopen Voicebook, and resume the installation.';
		return message;
	}

	async function updateConsent(event: Event): Promise<void> {
		const accepted = (event.currentTarget as HTMLInputElement).checked;
		localError = '';
		llmError = '';
		if (wantsVoiceDownload) await appState.setLicenseAcceptance('supertonic-3', accepted);
		if (wantsLlmDownload) await llmState.setLicenseAcceptance(llmSpec.id, accepted);
	}

	/** Persist the chosen engines — the moment the app becomes speech-capable
	 * and setup steps aside. */
	async function applyChoices(): Promise<void> {
		if (compact) return;
		await providersState.setSpeechEngine(voiceChoice === 'cloud' ? 'elevenlabs' : 'local');
		if (descChoice === 'cloud') await providersState.setDescriptionEngine(descProvider);
		else if (isCloudLlmProvider(providersState.descriptionEngine))
			await providersState.setDescriptionEngine('local');
	}

	async function install(): Promise<void> {
		if (installing || !consented || totalMb === 0 || missingKeyHint) return;
		busy = true;
		localError = '';
		llmError = '';
		try {
			if (wantsVoiceDownload) {
				stage = 'speech';
				await appState.installModel('supertonic-3');
			}
			if (wantsLlmDownload) {
				stage = 'llm';
				try {
					await llmState.activate(llmSpec.id, { install: true });
				} catch (error) {
					// The language model is an enhancement — speech stands on its own.
					llmError =
						error instanceof Error
							? error.message
							: 'The language model could not be installed. You can retry from Settings → LLM.';
				}
			}
			await applyChoices();
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			localError = friendlyError(
				error instanceof Error ? error.message : 'The voice engine could not be installed.'
			);
		} finally {
			busy = false;
			stage = 'idle';
		}
	}

	async function startListening(): Promise<void> {
		if (installing || missingKeyHint) return;
		await applyChoices();
	}

	function cancelInstall(): void {
		if (installingLlm) llmState.cancelActivation();
		else appState.cancelModelInstall('supertonic-3');
		busy = false;
		stage = 'idle';
	}
</script>

{#snippet voiceLocalPanel()}
	<div class="choice-panel">
		<div class="panel-model">
			<strong>{model.name}</strong>
			<small>{model.voices.length} studio voices · 31 languages · works offline</small>
		</div>
		<div class="panel-foot">
			{#if speechInstalled}
				<span class="model-state"><Check size={12} strokeWidth={2.6} /> Installed</span>
			{:else}
				<span class="model-size">{model.sizeMb} MB</span>
			{/if}
			<a class="model-license" href={model.licenseUrl} target="_blank" rel="external noreferrer">
				{model.license} license <ArrowUpRight size={10} />
			</a>
		</div>
		{#if installingSpeech}
			<div class="model-progress" aria-live="polite">
				<progress max="100" value={progress.progress}></progress>
				<small>{progress.file ?? progress.message ?? 'Preparing model files'}</small>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet llmLocalPanel()}
	<div class="choice-panel">
		<div class="panel-model">
			<strong>{llmSpec.label}</strong>
			<small>Speaks equations, tables, and diagrams · runs on this computer's GPU</small>
		</div>
		<div class="panel-foot">
			{#if llmInstalled}
				<span class="model-state"><Check size={12} strokeWidth={2.6} /> Installed</span>
			{:else}
				<span class="model-size">{llmSpec.sizeMb} MB</span>
			{/if}
			<a class="model-license" href={llmSpec.licenseUrl} target="_blank" rel="external noreferrer">
				{llmSpec.license}
				<ArrowUpRight size={10} />
			</a>
		</div>
		{#if installingLlm}
			<div class="model-progress" aria-live="polite">
				<progress max="100" value={llmState.download?.percent ?? 0}></progress>
				<small>
					{llmState.phase === 'probing'
						? 'Warming up the model…'
						: (llmState.download?.file ?? 'Preparing model files')}
				</small>
			</div>
		{/if}
	</div>
{/snippet}

<section
	class="model-setup"
	class:compact
	aria-labelledby={compact ? 'reader-model-setup-title' : 'model-setup-title'}
	aria-busy={installing}
>
	<header class="setup-heading">
		<div class="setup-brand" aria-hidden="true">
			<BrandMark size={compact ? 36 : 72} active={installing} />
		</div>
		<div class="setup-copy">
			<h1 id={compact ? 'reader-model-setup-title' : 'model-setup-title'}>
				{compact ? 'Finish setting up Voicebook' : 'Choose how Voicebook reads.'}
			</h1>
			<p>
				{compact
					? 'Accept the model terms and finish the one-time download here.'
					: 'A voice engine reads the words; a language model speaks the equations, tables, and diagrams. Keep everything on this device, or bring your own API keys — mix freely, change anytime in Settings.'}
			</p>
		</div>
	</header>

	{#if compact}
		<div class="setup-models" role="list">
			<div class="model-row" class:done={speechInstalled} role="listitem">
				<span class="model-icon" aria-hidden="true"><Mic2 size={17} /></span>
				<div class="model-copy">
					<strong>Reading voice</strong>
					<small>{model.name} · {model.voices.length} studio voices · 31 languages</small>
					<a
						class="model-license"
						href={model.licenseUrl}
						target="_blank"
						rel="external noreferrer"
					>
						{model.license} license <ArrowUpRight size={10} />
					</a>
					{#if installingSpeech}
						<div class="model-progress" aria-live="polite">
							<progress max="100" value={progress.progress}></progress>
							<small>{progress.file ?? progress.message ?? 'Preparing model files'}</small>
						</div>
					{/if}
				</div>
				<div class="model-meta">
					{#if speechInstalled}
						<span class="model-state"><Check size={12} strokeWidth={2.6} /> Installed</span>
					{:else if installingSpeech}
						<span class="model-size">{Math.round(progress.progress)}%</span>
					{:else}
						<span class="model-size">{model.sizeMb} MB</span>
					{/if}
				</div>
			</div>
			{#if llmEligible}
				<div class="model-row" class:done={llmInstalled} role="listitem">
					<span class="model-icon" aria-hidden="true"><BrainCircuit size={17} /></span>
					<div class="model-copy">
						<strong>Visual descriptions</strong>
						<small>{llmSpec.label} · speaks equations, tables, and diagrams</small>
						<a
							class="model-license"
							href={llmSpec.licenseUrl}
							target="_blank"
							rel="external noreferrer"
						>
							{llmSpec.license}
							<ArrowUpRight size={10} />
						</a>
						{#if installingLlm}
							<div class="model-progress" aria-live="polite">
								<progress max="100" value={llmState.download?.percent ?? 0}></progress>
								<small>
									{llmState.phase === 'probing'
										? 'Warming up the model…'
										: (llmState.download?.file ?? 'Preparing model files')}
								</small>
							</div>
						{/if}
					</div>
					<div class="model-meta">
						{#if llmInstalled}
							<span class="model-state"><Check size={12} strokeWidth={2.6} /> Installed</span>
						{:else if installingLlm}
							<span class="model-size">{llmState.download?.percent ?? 0}%</span>
						{:else}
							<span class="model-size">{llmSpec.sizeMb} MB</span>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{:else}
		<div class="engine-cards">
			<article class="engine-card" aria-label="Reading voice">
				<header class="card-head">
					<span class="card-icon" aria-hidden="true"><Mic2 size={15} /></span>
					<strong>Reading voice</strong>
				</header>
				<div class="choice-seg" role="radiogroup" aria-label="Reading voice source">
					<button
						type="button"
						role="radio"
						aria-checked={voiceChoice === 'local'}
						disabled={installing}
						onclick={() => (voiceChoice = 'local')}
					>
						On this device
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={voiceChoice === 'cloud'}
						disabled={installing}
						onclick={() => (voiceChoice = 'cloud')}
					>
						API key
					</button>
				</div>
				{#if voiceChoice === 'local'}
					{@render voiceLocalPanel()}
				{:else}
					<div class="choice-panel">
						<div class="panel-model">
							<strong><AudioLines size={13} aria-hidden="true" /> ElevenLabs</strong>
							<small>Studio voices, no download · usage billed to your key</small>
						</div>
						<ApiKeyField
							label="ElevenLabs API key"
							placeholder="sk_…"
							keyUrl="https://elevenlabs.io/app/settings/api-keys"
							hasKey={providersState.hasKey('elevenlabs')}
							isDevKey={providersState.isDevKey('elevenlabs')}
							onSave={(value) => providersState.setKey('elevenlabs', value)}
							onClear={() => providersState.setKey('elevenlabs', '')}
						/>
					</div>
				{/if}
			</article>

			<article class="engine-card" aria-label="Visual descriptions">
				<header class="card-head">
					<span class="card-icon" aria-hidden="true"><BrainCircuit size={15} /></span>
					<strong>Visual descriptions</strong>
				</header>
				<div class="choice-seg" role="radiogroup" aria-label="Visual descriptions source">
					{#if llmEligible}
						<button
							type="button"
							role="radio"
							aria-checked={descChoice === 'local'}
							disabled={installing}
							onclick={() => (pickedDescChoice = 'local')}
						>
							On this device
						</button>
					{/if}
					<button
						type="button"
						role="radio"
						aria-checked={descChoice === 'cloud'}
						disabled={installing}
						onclick={() => (pickedDescChoice = 'cloud')}
					>
						API key
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={descChoice === 'skip'}
						disabled={installing}
						onclick={() => (pickedDescChoice = 'skip')}
					>
						Skip
					</button>
				</div>
				{#if descChoice === 'local'}
					{@render llmLocalPanel()}
				{:else if descChoice === 'cloud'}
					<div class="choice-panel">
						<div class="provider-pick" role="radiogroup" aria-label="Description provider">
							{#each CLOUD_LLM_PROVIDERS as spec (spec.id)}
								<button
									type="button"
									role="radio"
									aria-checked={descProvider === spec.id}
									disabled={installing}
									onclick={() => (descProvider = spec.id)}
								>
									<ProviderLogo provider={spec.id} size={14} />
									<span>{spec.label}</span>
									{#if providersState.hasKey(spec.id)}<Check size={11} strokeWidth={2.6} />{/if}
								</button>
							{/each}
						</div>
						<ApiKeyField
							label={`${descSpec.vendor} API key`}
							placeholder={descSpec.keyPlaceholder}
							keyUrl={descSpec.keyUrl}
							hasKey={providersState.hasKey(descProvider)}
							isDevKey={providersState.isDevKey(descProvider)}
							onSave={(value) => providersState.setKey(descProvider, value)}
							onClear={() => providersState.setKey(descProvider, '')}
						/>
					</div>
				{:else}
					<div class="choice-panel">
						<p class="skip-note">
							{#if llmEligible}
								Equations and tables get short built-in phrasing. Add a description model anytime in
								Settings → LLM.
							{:else}
								The on-device model needs WebGPU, which this browser doesn't offer. Equations and
								tables get short built-in phrasing — or plug in an API key.
							{/if}
						</p>
					</div>
				{/if}
			</article>
		</div>
	{/if}

	{#if totalMb > 0}
		<label class="license-check">
			<input type="checkbox" checked={consented} disabled={installing} onchange={updateConsent} />
			<span class="check-box" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
			<span>I accept the model licenses linked above</span>
		</label>
	{/if}

	<footer class="setup-actions">
		{#if installing}
			<button class="button" type="button" onclick={cancelInstall}>
				<Square size={12} fill="currentColor" /> Stop for now
			</button>
		{:else if totalMb > 0}
			<button
				class="button primary install-button"
				type="button"
				disabled={!consented || Boolean(missingKeyHint)}
				onclick={install}
			>
				{#if busy}<LoaderCircle class="spin" size={16} />{:else}<Download size={16} />{/if}
				{downloadLabel}
			</button>
		{:else if !compact}
			<button
				class="button primary install-button"
				type="button"
				disabled={Boolean(missingKeyHint)}
				onclick={startListening}
			>
				<Play size={15} /> Start listening
			</button>
		{/if}
		{#if missingKeyHint && !installing}
			<small class="cta-hint">{missingKeyHint}</small>
		{/if}
	</footer>

	{#if localError || llmError || progress.status === 'error' || appState.runtimeNotice}
		<div class="install-state" aria-live="polite">
			{#if localError || progress.status === 'error'}
				<div class="setup-error" role="alert">
					<AlertTriangle size={15} />
					<span>{localError || friendlyError(progress.message)}</span>
				</div>
			{:else if llmError}
				<div class="setup-error" role="alert">
					<AlertTriangle size={15} />
					<span>{llmError}</span>
				</div>
			{:else if appState.runtimeNotice}
				<div class="recovery-note">
					<ShieldCheck size={15} />
					<span>{appState.runtimeNotice}</span>
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.model-setup {
		display: flex;
		width: min(720px, 100%);
		align-items: center;
		padding: 0;
		margin: 0 auto;
		flex-direction: column;
	}

	.setup-heading {
		display: flex;
		align-items: center;
		flex-direction: column;
		text-align: center;
	}

	.setup-brand {
		display: grid;
		margin-bottom: 22px;
		place-items: center;
	}

	.setup-heading h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(2rem, 3.8vw, 2.8rem);
		font-variation-settings: 'opsz' 48;
		font-weight: 560;
		letter-spacing: -0.045em;
		line-height: 1.03;
	}

	.setup-heading p:last-child {
		max-width: 520px;
		margin: 12px auto 0;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.65;
	}

	/* ── Side-by-side engine cards ─────────────────────────────────────── */

	.engine-cards {
		display: grid;
		width: 100%;
		gap: 12px;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		margin-top: 28px;
	}

	.engine-card {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
		border: 1px solid var(--line-strong);
		border-radius: 13px;
		background: color-mix(in srgb, var(--surface, transparent) 55%, transparent);
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.card-icon {
		display: grid;
		width: 26px;
		height: 26px;
		flex: none;
		place-items: center;
		border-radius: 8px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.card-head strong {
		font-size: 11.5px;
		font-weight: 680;
		letter-spacing: -0.01em;
	}

	.choice-seg {
		display: flex;
		padding: 3px;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		gap: 3px;
		background: color-mix(in srgb, var(--control) 55%, transparent);
	}

	.choice-seg button {
		display: inline-flex;
		min-height: 28px;
		flex: 1;
		align-items: center;
		justify-content: center;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-size: 10px;
		font-weight: 640;
		white-space: nowrap;
		transition:
			background 140ms var(--ease),
			color 140ms var(--ease),
			box-shadow 140ms var(--ease);
	}

	.choice-seg button:hover {
		color: var(--text);
	}

	.choice-seg button[aria-checked='true'] {
		background: var(--control-strong);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent),
			0 1px 4px rgba(0, 0, 0, 0.14);
		color: var(--text);
	}

	.choice-seg button:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.choice-panel {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 10px;
		text-align: left;
	}

	.panel-model {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.panel-model strong {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 660;
		letter-spacing: -0.01em;
	}

	.panel-model small {
		color: var(--muted);
		font-size: 10px;
		line-height: 1.45;
	}

	.panel-foot {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.skip-note {
		margin: 2px 0 0;
		color: var(--faint);
		font-size: 10px;
		line-height: 1.55;
	}

	.provider-pick {
		display: flex;
		gap: 5px;
	}

	.provider-pick button {
		display: inline-flex;
		min-height: 30px;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 0 8px;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-size: 9.5px;
		font-weight: 640;
		transition:
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.provider-pick button:hover {
		color: var(--text);
	}

	.provider-pick button[aria-checked='true'] {
		border-color: color-mix(in srgb, var(--primary) 60%, var(--line-strong));
		background: color-mix(in srgb, var(--primary) 8%, transparent);
		color: var(--text);
	}

	/* ── Compact reader strip (rows, no choices) ───────────────────────── */

	.setup-models {
		width: 100%;
		border: 1px solid var(--line-strong);
		border-radius: 13px;
		margin-top: 28px;
		background: color-mix(in srgb, var(--surface, transparent) 55%, transparent);
	}

	.model-row {
		display: flex;
		align-items: flex-start;
		gap: 13px;
		padding: 15px 16px;
	}

	.model-row + .model-row {
		border-top: 1px solid var(--line);
	}

	.model-icon {
		display: grid;
		width: 34px;
		height: 34px;
		flex: 0 0 34px;
		place-items: center;
		border-radius: 9px;
		margin-top: 1px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.model-copy {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		gap: 3px;
		text-align: left;
	}

	.model-copy strong {
		font-size: 12px;
		font-weight: 660;
		letter-spacing: -0.01em;
	}

	.model-copy small {
		color: var(--muted);
		font-size: 10px;
		line-height: 1.45;
	}

	.model-meta {
		display: flex;
		flex: none;
		align-items: flex-end;
		flex-direction: column;
		gap: 8px;
	}

	/* ── Shared bits ───────────────────────────────────────────────────── */

	.model-license {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--faint);
		font-size: 9.5px;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.model-license:hover {
		color: var(--primary);
	}

	.model-progress {
		margin-top: 2px;
	}

	.model-progress progress {
		width: 100%;
		height: 4px;
		accent-color: var(--primary);
	}

	.model-progress small {
		display: block;
		overflow: hidden;
		margin-top: 4px;
		color: var(--faint);
		font-size: 9px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.model-size {
		padding: 3px 9px;
		border: 1px solid var(--line-strong);
		border-radius: 999px;
		color: var(--muted);
		font-size: 9.5px;
		font-weight: 650;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.model-state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 9px;
		border-radius: 999px;
		background: var(--primary-soft);
		color: var(--primary);
		font-size: 9.5px;
		font-weight: 650;
		white-space: nowrap;
	}

	.license-check {
		display: flex;
		min-height: 44px;
		align-items: center;
		gap: 11px;
		padding: 0;
		margin-top: 16px;
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 600;
		line-height: 1.35;
		cursor: pointer;
		touch-action: manipulation;
	}

	.license-check input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		opacity: 0;
	}

	.check-box {
		display: grid;
		width: 20px;
		height: 20px;
		flex: 0 0 20px;
		place-items: center;
		border: 1px solid var(--control-border);
		border-radius: 5px;
		background: var(--control-strong);
		color: transparent;
		transition:
			background 150ms var(--ease),
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.license-check input:checked + .check-box {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--primary-ink);
	}

	.license-check:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 3px;
	}

	.install-state {
		width: min(420px, 100%);
		padding: 0;
		margin: 12px auto 0;
		text-align: center;
	}

	.setup-error,
	.recovery-note {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		font-size: 10px;
		line-height: 1.5;
	}

	.setup-error {
		color: var(--danger);
	}

	.recovery-note {
		color: var(--bookmark);
	}

	.setup-actions {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 0;
		margin-top: 14px;
		flex-direction: column;
	}

	.setup-actions:empty {
		display: none;
	}

	.install-button {
		height: 48px;
		min-width: 220px;
		padding: 0 22px;
		font-size: 11px;
	}

	.cta-hint {
		color: var(--faint);
		font-size: 9.5px;
	}

	.model-setup.compact {
		width: auto;
		min-height: 0;
		padding: calc(var(--app-header-height) + 18px) 28px 18px;
		margin: 0;
		border-bottom: 1px solid var(--line-strong);
		background: color-mix(in srgb, var(--reader) 92%, var(--primary) 8%);
	}

	.compact .setup-heading {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr);
		gap: 14px;
		text-align: left;
	}

	.compact .setup-brand {
		margin: 0;
	}

	.compact .setup-heading h1 {
		font-family: var(--font-ui);
		font-size: 14px;
		font-weight: 650;
		letter-spacing: -0.015em;
		line-height: 1.25;
	}

	.compact .setup-heading p:last-child {
		margin-top: 4px;
		font-size: 10px;
	}

	.compact .setup-models {
		margin-top: 14px;
	}

	.compact .model-row {
		padding: 11px 13px;
	}

	.compact .license-check {
		min-height: 38px;
		margin-top: 10px;
	}

	.compact .setup-actions {
		align-items: center;
		justify-content: flex-start;
		margin-top: 10px;
		flex-direction: row;
	}

	.compact .install-button {
		height: 42px;
	}

	@media (max-width: 680px) {
		.model-setup {
			width: 100%;
		}

		.setup-brand {
			margin-bottom: 20px;
		}

		.setup-heading h1 {
			font-size: clamp(1.85rem, 10vw, 2.65rem);
		}

		.engine-cards {
			grid-template-columns: minmax(0, 1fr);
			margin-top: 22px;
		}

		.license-check {
			width: 100%;
		}

		.setup-actions {
			align-items: stretch;
			align-self: stretch;
		}

		.setup-actions .button {
			width: 100%;
		}

		.model-setup.compact {
			width: auto;
			padding: calc(var(--app-header-height) + 16px) 16px 16px;
		}

		.compact .setup-heading {
			grid-template-columns: 32px minmax(0, 1fr);
		}

		.compact .setup-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.check-box,
		.choice-seg button {
			transition: none;
		}
	}
</style>
