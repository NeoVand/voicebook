<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		BrainCircuit,
		Check,
		Cloud,
		Download,
		LoaderCircle,
		Mic2,
		ShieldCheck,
		Square
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import ApiKeyField from '$lib/components/ApiKeyField.svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { DEFAULT_LLM_ID, getLlmModel } from '$lib/domain/llm-catalog';
	import {
		CLOUD_LLM_PROVIDERS,
		getCloudLlmProvider,
		type CloudLlmProvider
	} from '$lib/domain/provider-catalog';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { providersState } from '$lib/state/providers.svelte';

	let { compact = false } = $props<{ compact?: boolean }>();

	const model = getModel('supertonic-3');
	const llmSpec = getLlmModel(DEFAULT_LLM_ID)!;
	let busy = $state(false);
	let localError = $state('');
	let llmError = $state('');
	let stage = $state<'idle' | 'speech' | 'llm'>('idle');
	/** Whether the optional language model is part of this install. */
	let includeLlm = $state(true);
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
	let llmRelevant = $derived(llmEligible && !llmInstalled && includeLlm);
	// One consent covers the licenses of everything about to be downloaded.
	let consented = $derived(
		(speechInstalled || appState.acceptedLicenses.includes('supertonic-3')) &&
			(!llmRelevant || llmState.acceptedLicenses.includes(llmSpec.id))
	);
	let totalMb = $derived((speechInstalled ? 0 : model.sizeMb) + (llmRelevant ? llmSpec.sizeMb : 0));
	let downloadLabel = $derived(
		progress.status === 'error' && !speechInstalled
			? 'Resume installation'
			: `Download · ${totalMb >= 1000 ? `${(totalMb / 1000).toFixed(1)} GB` : `${totalMb} MB`}`
	);

	onMount(() => {
		void llmState.initialize();
		void providersState.initialize();
	});

	/* ── Optional premium engines (bring your own keys) ─────────────────── */

	let premiumProvider = $state<CloudLlmProvider>('anthropic');
	let cloudLlmProvider = $derived(
		providersState.descriptionEngine !== 'local'
			? getCloudLlmProvider(providersState.descriptionEngine)
			: null
	);
	let premiumSpec = $derived(getCloudLlmProvider(premiumProvider)!);

	async function saveElevenLabsKey(value: string): Promise<void> {
		await providersState.setKey('elevenlabs', value);
		if (value.trim()) {
			await providersState.setSpeechEngine('elevenlabs');
		} else if (providersState.speechEngine === 'elevenlabs' && !providersState.elevenLabsReady) {
			await providersState.setSpeechEngine('local');
		}
	}

	async function saveCloudLlmKey(value: string): Promise<void> {
		await providersState.setKey(premiumProvider, value);
		if (value.trim()) await providersState.setDescriptionEngine(premiumProvider);
		else if (providersState.descriptionEngine === premiumProvider) {
			await providersState.setDescriptionEngine('local');
		}
	}

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
		if (!speechInstalled) await appState.setLicenseAcceptance('supertonic-3', accepted);
		if (llmEligible && !llmInstalled) await llmState.setLicenseAcceptance(llmSpec.id, accepted);
	}

	async function install(): Promise<void> {
		if (installing || !consented || totalMb === 0) return;
		busy = true;
		localError = '';
		llmError = '';
		try {
			if (!speechInstalled) {
				stage = 'speech';
				await appState.installModel('supertonic-3');
			}
			if (llmRelevant) {
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

	function cancelInstall(): void {
		if (installingLlm) llmState.cancelActivation();
		else appState.cancelModelInstall('supertonic-3');
		busy = false;
		stage = 'idle';
	}
</script>

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
				{compact ? 'Finish setting up Voicebook' : 'Set up local listening.'}
			</h1>
			<p>
				{compact
					? 'Accept the model terms and finish the one-time download here.'
					: 'Downloaded once from Hugging Face. Everything runs and stays on this device.'}
			</p>
		</div>
	</header>

	<div class="setup-models" role="list">
		<div class="model-row" class:done={speechInstalled} role="listitem">
			<span class="model-icon" aria-hidden="true"><Mic2 size={17} /></span>
			<div class="model-copy">
				<strong>Voice engine</strong>
				<small>{model.name} · {model.voices.length} studio voices · 31 languages</small>
				<a class="model-license" href={model.licenseUrl} target="_blank" rel="external noreferrer">
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
			<div
				class="model-row"
				class:done={llmInstalled}
				class:excluded={!includeLlm && !llmInstalled}
				role="listitem"
			>
				<span class="model-icon" aria-hidden="true"><BrainCircuit size={17} /></span>
				<div class="model-copy">
					<strong>Language model</strong>
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
						<label class="include-toggle">
							<input type="checkbox" bind:checked={includeLlm} disabled={installing} />
							<span>Include</span>
						</label>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	{#if !compact}
		<details class="premium-setup">
			<summary>
				<Cloud size={14} aria-hidden="true" />
				<span>Have API keys? Add premium engines</span>
				<span class="premium-badges" aria-hidden="true">
					{#if providersState.elevenLabsReady}<i>ElevenLabs</i>{/if}
					{#if cloudLlmProvider}<i>{cloudLlmProvider.label}</i>{/if}
				</span>
			</summary>
			<div class="premium-body">
				<p>
					Optional — keys stay in this browser and are sent only to their provider. With a premium
					voice you can start listening without any download. Change engines anytime in Settings.
				</p>
				<div class="premium-field">
					<span class="premium-field-title">Premium reading voice</span>
					<ApiKeyField
						label="ElevenLabs API key"
						placeholder="sk_…"
						keyUrl="https://elevenlabs.io/app/settings/api-keys"
						hasKey={providersState.hasKey('elevenlabs')}
						isDevKey={providersState.isDevKey('elevenlabs')}
						onSave={saveElevenLabsKey}
						onClear={() => saveElevenLabsKey('')}
					/>
				</div>
				<div class="premium-field">
					<span class="premium-field-title">Premium descriptions</span>
					<div class="premium-providers" role="group" aria-label="Description provider">
						{#each CLOUD_LLM_PROVIDERS as spec (spec.id)}
							<button
								type="button"
								class:selected={premiumProvider === spec.id}
								aria-pressed={premiumProvider === spec.id}
								onclick={() => (premiumProvider = spec.id)}
							>
								{spec.label}
								{#if providersState.hasKey(spec.id)}<Check size={11} strokeWidth={2.6} />{/if}
							</button>
						{/each}
					</div>
					<ApiKeyField
						label={`${premiumSpec.vendor} API key`}
						placeholder={premiumSpec.keyPlaceholder}
						keyUrl={premiumSpec.keyUrl}
						hasKey={providersState.hasKey(premiumProvider)}
						isDevKey={providersState.isDevKey(premiumProvider)}
						onSave={saveCloudLlmKey}
						onClear={() => saveCloudLlmKey('')}
					/>
				</div>
			</div>
		</details>
	{/if}

	{#if !speechInstalled || llmRelevant}
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
				disabled={!consented}
				onclick={install}
			>
				{#if busy}<LoaderCircle class="spin" size={16} />{:else}<Download size={16} />{/if}
				{downloadLabel}
			</button>
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
		width: min(520px, 100%);
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
		max-width: 420px;
		margin: 12px auto 0;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.65;
	}

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
		transition: opacity 150ms var(--ease);
	}

	.model-row + .model-row {
		border-top: 1px solid var(--line);
	}

	.model-row.excluded {
		opacity: 0.45;
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

	.model-license {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-top: 2px;
		color: var(--faint);
		font-size: 9.5px;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.model-license:hover {
		color: var(--primary);
	}

	.model-progress {
		margin-top: 6px;
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

	.model-meta {
		display: flex;
		flex: none;
		align-items: flex-end;
		flex-direction: column;
		gap: 8px;
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

	.include-toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 9.5px;
		font-weight: 600;
		cursor: pointer;
	}

	.include-toggle input {
		width: 13px;
		height: 13px;
		accent-color: var(--primary);
	}

	.premium-setup {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: 13px;
		margin-top: 12px;
		background: color-mix(in srgb, var(--surface, transparent) 40%, transparent);
	}

	.premium-setup summary {
		display: flex;
		min-height: 46px;
		align-items: center;
		gap: 9px;
		padding: 0 16px;
		color: var(--muted);
		cursor: pointer;
		font-size: 10.5px;
		font-weight: 620;
		list-style: none;
	}

	.premium-setup summary::-webkit-details-marker {
		display: none;
	}

	.premium-setup summary:hover {
		color: var(--text);
	}

	.premium-badges {
		display: inline-flex;
		margin-left: auto;
		gap: 5px;
	}

	.premium-badges i {
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--primary-soft);
		color: var(--primary);
		font-size: 8.5px;
		font-style: normal;
		font-weight: 680;
	}

	.premium-body {
		display: grid;
		gap: 14px;
		padding: 2px 16px 16px;
		border-top: 1px solid var(--line);
		text-align: left;
	}

	.premium-body > p {
		margin: 10px 0 0;
		color: var(--faint);
		font-size: 9.5px;
		line-height: 1.55;
	}

	.premium-field {
		display: grid;
		gap: 7px;
	}

	.premium-field-title {
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 660;
	}

	.premium-providers {
		display: flex;
		gap: 5px;
	}

	.premium-providers button {
		display: inline-flex;
		min-height: 28px;
		align-items: center;
		gap: 4px;
		padding: 0 11px;
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

	.premium-providers button:hover {
		color: var(--text);
	}

	.premium-providers button.selected {
		border-color: color-mix(in srgb, var(--primary) 60%, var(--line-strong));
		background: color-mix(in srgb, var(--primary) 8%, transparent);
		color: var(--text);
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
		padding: 0;
		margin-top: 14px;
		flex-direction: column;
	}

	.install-button {
		height: 48px;
		min-width: 220px;
		padding: 0 22px;
		font-size: 11px;
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
		.model-row {
			transition: none;
		}
	}
</style>
