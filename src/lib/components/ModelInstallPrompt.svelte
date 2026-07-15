<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		Check,
		Cpu,
		Download,
		HardDrive,
		LoaderCircle,
		ShieldCheck,
		Sparkles,
		Square
	} from '@lucide/svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { appState } from '$lib/state/app-state.svelte';

	let { compact = false } = $props<{ compact?: boolean }>();

	const model = getModel('supertonic-3');
	let busy = $state(false);
	let localError = $state('');
	let progress = $derived(appState.modelProgress['supertonic-3']);
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));
	let installing = $derived(busy || progress.status === 'loading');

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

	async function install(): Promise<void> {
		if (!licenseAccepted || installing) return;
		busy = true;
		localError = '';
		try {
			await appState.installModel('supertonic-3');
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') return;
			localError = friendlyError(
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
</script>

<section
	class="model-setup"
	class:compact
	aria-labelledby={compact ? 'reader-model-setup-title' : 'model-setup-title'}
	aria-busy={installing}
>
	<header class="setup-heading">
		<span class="setup-mark" aria-hidden="true"><Sparkles size={compact ? 17 : 22} /></span>
		<div>
			{#if !compact}<p class="eyebrow">First, prepare your voice</p>{/if}
			<h1 id={compact ? 'reader-model-setup-title' : 'model-setup-title'}>
				{compact ? 'Install the local voice engine' : 'Listen privately, right in this browser.'}
			</h1>
			<p>
				{compact
					? 'Accept the model terms and finish the one-time download here.'
					: 'Voicebook needs one local speech model before you add a document. Download it once, then your documents and generated audio stay on this device.'}
			</p>
		</div>
	</header>

	<div class="setup-facts" aria-label="Voice engine details">
		<span
			><HardDrive size={15} /><strong>{model.sizeMb} MB</strong><small>one-time download</small
			></span
		>
		<span
			><Cpu size={15} /><strong>{appState.capabilities.webgpu ? 'WebGPU' : 'WASM'}</strong><small
				>{appState.capabilities.webgpu ? 'hardware accelerated' : 'compatibility mode'}</small
			></span
		>
		<span
			><ShieldCheck size={15} /><strong>On device</strong><small>no document uploads</small></span
		>
	</div>

	<div class="license-step">
		<div>
			<strong>Supertonic 3 · OpenRAIL-M</strong>
			<p>
				Review the model’s use restrictions before downloading.
				<a href={model.licenseUrl} target="_blank" rel="external noreferrer">
					Open terms <ArrowUpRight size={12} />
				</a>
			</p>
		</div>
		<label class="license-check">
			<input type="checkbox" checked={licenseAccepted} onchange={updateLicense} />
			<span class="check-box" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span>
			<span>I have reviewed and agree to the model terms</span>
		</label>
	</div>

	<div class="install-state" aria-live="polite">
		{#if installing}
			<div class="progress-copy">
				<span>{progress.message ?? 'Preparing the local voice engine…'}</span>
				<strong>{Math.round(progress.progress)}%</strong>
			</div>
			<progress max="100" value={progress.progress}></progress>
			<small>{progress.file ?? 'Checking saved model files'}</small>
		{:else if localError || progress.status === 'error'}
			<div class="setup-error" role="alert">
				<AlertTriangle size={15} />
				<span>{localError || friendlyError(progress.message)}</span>
			</div>
		{:else if appState.runtimeNotice}
			<div class="recovery-note">
				<ShieldCheck size={15} />
				<span>{appState.runtimeNotice}</span>
			</div>
		{:else}
			<p class="ready-note">The download resumes automatically if the browser is interrupted.</p>
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
				disabled={!licenseAccepted}
				onclick={install}
			>
				{#if busy}<LoaderCircle class="spin" size={16} />{:else}<Download size={16} />{/if}
				{progress.status === 'error' ? 'Resume installation' : 'Download voice engine'}
			</button>
		{/if}
		<small>31 languages · 10 voices · runs locally after download</small>
	</footer>
</section>

<style>
	.model-setup {
		width: min(760px, calc(100% - 40px));
		min-height: calc(100dvh - var(--app-header-height));
		padding: clamp(48px, 9dvh, 96px) 0 72px;
		margin: 0 auto;
	}

	.setup-heading {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr);
		gap: 20px;
		padding-bottom: 32px;
		border-bottom: 1px solid var(--line-strong);
	}

	.setup-mark {
		display: grid;
		width: 48px;
		height: 48px;
		place-items: center;
		border-radius: 14px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.eyebrow {
		margin: 0 0 8px;
		color: var(--primary);
		font-size: 9px;
		font-weight: 720;
		letter-spacing: 0.11em;
		text-transform: uppercase;
	}

	.setup-heading h1 {
		max-width: 640px;
		margin: 0;
		font-family: var(--font-display);
		font-size: clamp(2rem, 5vw, 3.55rem);
		font-variation-settings: 'opsz' 48;
		font-weight: 560;
		letter-spacing: -0.045em;
		line-height: 1;
	}

	.setup-heading p:last-child {
		max-width: 620px;
		margin: 14px 0 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.65;
	}

	.setup-facts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		padding: 24px 0;
		border-bottom: 1px solid var(--line);
	}

	.setup-facts > span {
		display: grid;
		grid-template-columns: 22px 1fr;
		align-items: center;
		padding-right: 20px;
		color: var(--primary);
	}

	.setup-facts strong,
	.setup-facts small {
		grid-column: 2;
	}

	.setup-facts strong {
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 650;
	}

	.setup-facts small {
		margin-top: 2px;
		color: var(--faint);
		font-size: 9px;
	}

	.license-step {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(250px, auto);
		align-items: center;
		gap: 24px;
		padding: 22px 0;
		border-bottom: 1px solid var(--line);
	}

	.license-step strong {
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 650;
	}

	.license-step p {
		margin: 5px 0 0;
		color: var(--faint);
		font-size: 9px;
		line-height: 1.5;
	}

	.license-step a {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin-left: 4px;
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.license-check {
		display: flex;
		min-height: 48px;
		align-items: center;
		gap: 11px;
		padding: 9px 12px;
		border-radius: 9px;
		background: var(--primary-soft);
		color: var(--text-soft);
		font-size: 10px;
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
		min-height: 88px;
		padding: 18px 0 12px;
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

	.ready-note {
		margin: 0;
		color: var(--faint);
		font-size: 10px;
	}

	.setup-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 20px;
		padding-top: 8px;
	}

	.install-button {
		height: 48px;
		padding: 0 20px;
		font-size: 11px;
	}

	.setup-actions > small {
		color: var(--faint);
		font-size: 9px;
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
		grid-template-columns: 36px minmax(0, 1fr);
		gap: 14px;
		padding-bottom: 16px;
	}

	.compact .setup-mark {
		width: 36px;
		height: 36px;
		border-radius: 10px;
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

	.compact .setup-facts {
		display: none;
	}

	.compact .license-step {
		padding: 14px 0;
	}

	.compact .install-state {
		min-height: 58px;
		padding: 12px 0 4px;
	}

	.compact .setup-actions {
		padding-top: 4px;
	}

	.compact .install-button {
		height: 42px;
	}

	@media (max-width: 680px) {
		.model-setup {
			width: min(100% - 32px, 560px);
			padding-top: 44px;
		}

		.setup-heading {
			grid-template-columns: 40px minmax(0, 1fr);
			gap: 14px;
		}

		.setup-mark {
			width: 40px;
			height: 40px;
			border-radius: 11px;
		}

		.setup-heading h1 {
			font-size: clamp(1.85rem, 10vw, 2.65rem);
		}

		.setup-facts {
			grid-template-columns: 1fr;
			gap: 16px;
		}

		.license-step {
			grid-template-columns: 1fr;
			gap: 14px;
		}

		.license-check {
			width: 100%;
		}

		.setup-actions {
			align-items: stretch;
			flex-direction: column;
		}

		.setup-actions .button {
			width: 100%;
		}

		.setup-actions > small {
			text-align: center;
		}

		.model-setup.compact {
			width: auto;
			padding: calc(var(--app-header-height) + 16px) 16px 16px;
		}

		.compact .setup-heading {
			grid-template-columns: 32px minmax(0, 1fr);
		}

		.compact .setup-mark {
			width: 32px;
			height: 32px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.check-box {
			transition: none;
		}
	}
</style>
