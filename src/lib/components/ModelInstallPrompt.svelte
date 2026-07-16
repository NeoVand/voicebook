<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		Check,
		Download,
		LoaderCircle,
		ShieldCheck,
		Sparkles,
		Square
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { DEFAULT_LLM_ID, getLlmModel } from '$lib/domain/llm-catalog';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';

	let { compact = false } = $props<{ compact?: boolean }>();

	const model = getModel('supertonic-3');
	const llmSpec = getLlmModel(DEFAULT_LLM_ID)!;
	let busy = $state(false);
	let localError = $state('');
	let llmError = $state('');
	let stage = $state<'idle' | 'speech' | 'narration'>('idle');
	let progress = $derived(appState.modelProgress['supertonic-3']);
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));
	let speechInstalled = $derived(appState.installedModels.includes('supertonic-3'));
	let llmEligible = $derived(llmState.eligible);
	let llmInstalled = $derived(llmState.installedModels.includes(llmSpec.id));
	let llmLicenseAccepted = $derived(llmState.acceptedLicenses.includes(llmSpec.id));
	let installingSpeech = $derived(stage === 'speech' || progress.status === 'loading');
	let installingLlm = $derived(
		stage === 'narration' ||
			(llmState.activeModelId === llmSpec.id &&
				(llmState.phase === 'downloading' ||
					llmState.phase === 'loading' ||
					llmState.phase === 'probing'))
	);
	let installing = $derived(busy || installingSpeech || installingLlm);
	let logoActive = $derived(installing);
	let wantsSpeech = $derived(!speechInstalled);
	let wantsLlm = $derived(llmEligible && !llmInstalled && llmLicenseAccepted);
	let downloadLabel = $derived(
		wantsSpeech && wantsLlm
			? 'Download voice + narration models'
			: wantsSpeech
				? progress.status === 'error'
					? 'Resume installation'
					: 'Download voice engine'
				: 'Download narration model'
	);
	let downloadDisabled = $derived(wantsSpeech ? !licenseAccepted : !wantsLlm);

	onMount(() => {
		void llmState.initialize();
	});

	function friendlyError(message?: string): string {
		if (!message) return 'The voice engine could not be installed.';
		if (/out of memory|allocation|memory/i.test(message))
			return 'This browser ran out of working memory. Close other tabs, reopen Voicebook, and resume the installation.';
		return message;
	}

	async function updateLicense(event: Event): Promise<void> {
		localError = '';
		await appState.setLicenseAcceptance(
			'supertonic-3',
			(event.currentTarget as HTMLInputElement).checked
		);
	}

	async function updateLlmLicense(event: Event): Promise<void> {
		llmError = '';
		await llmState.setLicenseAcceptance(
			llmSpec.id,
			(event.currentTarget as HTMLInputElement).checked
		);
	}

	async function install(): Promise<void> {
		if (installing || downloadDisabled) return;
		busy = true;
		localError = '';
		llmError = '';
		try {
			if (wantsSpeech) {
				stage = 'speech';
				await appState.installModel('supertonic-3');
			}
			if (llmEligible && !llmInstalled && llmLicenseAccepted) {
				stage = 'narration';
				try {
					await llmState.activate(llmSpec.id, { install: true });
				} catch (error) {
					// The narration model is an enhancement — speech stands on its own.
					llmError =
						error instanceof Error
							? error.message
							: 'The narration model could not be installed. You can retry from Settings → Narration.';
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
			<BrandMark size={compact ? 36 : 72} active={logoActive} />
		</div>
		<div class="setup-copy">
			<h1 id={compact ? 'reader-model-setup-title' : 'model-setup-title'}>
				{compact ? 'Install the local models' : 'Set up local listening.'}
			</h1>
			<p>
				{compact
					? 'Accept the model terms and finish the one-time download here.'
					: 'Private speech, downloaded once and kept on this device.'}
			</p>
		</div>
	</header>

	<ul class="setup-items">
		<li class:done={speechInstalled}>
			<span class="item-mark" aria-hidden="true">
				{#if speechInstalled}<Check size={13} strokeWidth={2.6} />{/if}
			</span>
			<span class="item-copy">
				<strong>Voice engine · {model.name}</strong>
				<small>{model.sizeMb} MB · {model.voices.length} studio voices, 31 languages</small>
			</span>
		</li>
		{#if llmEligible}
			<li class:done={llmInstalled}>
				<span class="item-mark" aria-hidden="true">
					{#if llmInstalled}<Check size={13} strokeWidth={2.6} />{:else}<Sparkles size={12} />{/if}
				</span>
				<span class="item-copy">
					<strong>Narration model · {llmSpec.label}</strong>
					<small>{llmSpec.sizeMb} MB · describes equations, tables, and diagrams aloud</small>
				</span>
			</li>
		{/if}
	</ul>

	<div class="license-steps">
		{#if !speechInstalled}
			<div class="license-step">
				<label class="license-check">
					<input type="checkbox" checked={licenseAccepted} onchange={updateLicense} />
					<span class="check-box" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
					<span>I agree to the Supertonic model terms</span>
				</label>
				<a class="terms-link" href={model.licenseUrl} target="_blank" rel="external noreferrer">
					Review terms <ArrowUpRight size={12} />
				</a>
			</div>
		{/if}
		{#if llmEligible && !llmInstalled}
			<div class="license-step">
				<label class="license-check">
					<input type="checkbox" checked={llmLicenseAccepted} onchange={updateLlmLicense} />
					<span class="check-box" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
					<span>I agree to the {llmSpec.license} terms</span>
				</label>
				<a class="terms-link" href={llmSpec.licenseUrl} target="_blank" rel="external noreferrer">
					Review terms <ArrowUpRight size={12} />
				</a>
			</div>
		{/if}
	</div>

	<footer class="setup-actions">
		{#if installing}
			<button class="button" type="button" onclick={cancelInstall}>
				<Square size={12} fill="currentColor" /> Stop for now
			</button>
		{:else}
			<button
				class="button primary install-button"
				type="button"
				disabled={downloadDisabled}
				onclick={install}
			>
				{#if busy}<LoaderCircle class="spin" size={16} />{:else}<Download size={16} />{/if}
				{downloadLabel}
			</button>
		{/if}
	</footer>

	{#if installing || localError || llmError || progress.status === 'error' || appState.runtimeNotice}
		<div class="install-state" aria-live="polite">
			{#if installingSpeech}
				<div class="progress-copy">
					<span>{progress.message ?? 'Preparing the local voice engine…'}</span>
					<strong>{Math.round(progress.progress)}%</strong>
				</div>
				<progress max="100" value={progress.progress}></progress>
				<small>{progress.file ?? 'Checking saved model files'}</small>
			{:else if installingLlm}
				<div class="progress-copy">
					<span>
						{llmState.phase === 'probing'
							? 'Warming up the narration model…'
							: 'Downloading the narration model… keep this tab open.'}
					</span>
					<strong>{llmState.download ? `${llmState.download.percent}%` : ''}</strong>
				</div>
				<progress max="100" value={llmState.download?.percent ?? 0}></progress>
				<small>{llmState.download?.file ?? 'Preparing model files'}</small>
			{:else if localError || progress.status === 'error'}
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
		width: min(560px, 100%);
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

	.setup-items {
		display: flex;
		width: min(420px, 100%);
		padding: 0;
		margin: 24px auto 0;
		flex-direction: column;
		gap: 10px;
		list-style: none;
	}

	.setup-items li {
		display: flex;
		align-items: center;
		gap: 11px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: 9px;
		text-align: left;
	}

	.setup-items li.done {
		border-color: color-mix(in srgb, var(--primary) 32%, var(--line));
	}

	.item-mark {
		display: grid;
		width: 22px;
		height: 22px;
		flex: 0 0 22px;
		place-items: center;
		border-radius: 999px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.item-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 2px;
	}

	.item-copy strong {
		font-size: 11px;
		font-weight: 650;
		letter-spacing: -0.005em;
	}

	.item-copy small {
		color: var(--muted);
		font-size: 9.5px;
		line-height: 1.4;
	}

	.license-steps {
		display: flex;
		width: min(420px, 100%);
		margin: 14px auto 0;
		flex-direction: column;
	}

	.license-step {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 0;
		flex-wrap: wrap;
	}

	.terms-link {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--primary);
		font-size: 10px;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.license-check {
		display: flex;
		min-height: 42px;
		align-items: center;
		gap: 11px;
		padding: 0;
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

	.progress-copy {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		color: var(--muted);
		font-size: 10px;
	}

	.progress-copy strong {
		color: var(--text-soft);
		font-variant-numeric: tabular-nums;
	}

	.install-state progress {
		width: 100%;
		height: 5px;
		margin-top: 10px;
		accent-color: var(--primary);
	}

	.install-state small {
		display: block;
		overflow: hidden;
		margin-top: 7px;
		color: var(--faint);
		font-size: 9px;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		margin-top: 18px;
		flex-direction: column;
	}

	.install-button {
		height: 48px;
		min-width: 220px;
		padding: 0 20px;
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
		padding-bottom: 16px;
		border-bottom: 1px solid var(--line-strong);
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

	.compact .setup-items {
		margin-top: 14px;
		gap: 8px;
	}

	.compact .setup-items li {
		padding: 8px 10px;
	}

	.compact .license-steps {
		margin-top: 8px;
	}

	.compact .license-step {
		justify-content: flex-start;
		padding: 0;
	}

	.compact .install-state {
		padding: 0;
		margin-top: 10px;
	}

	.compact .setup-actions {
		align-items: center;
		justify-content: flex-start;
		padding: 0;
		margin-top: 12px;
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

		.license-step {
			gap: 10px;
		}

		.license-check {
			width: 100%;
		}

		.setup-actions {
			align-items: stretch;
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

		.compact .setup-brand {
			margin: 0;
		}

		.compact .setup-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.check-box {
			transition: none;
		}
	}
</style>
