<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		Check,
		Download,
		LoaderCircle,
		ShieldCheck,
		Square
	} from '@lucide/svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { appState } from '$lib/state/app-state.svelte';

	let { compact = false } = $props<{ compact?: boolean }>();

	const model = getModel('supertonic-3');
	let busy = $state(false);
	let localError = $state('');
	let progress = $derived(appState.modelProgress['supertonic-3']);
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));
	let installing = $derived(busy || progress.status === 'loading');
	let logoActive = $derived(installing);

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
		<div class="setup-brand" aria-hidden="true">
			<BrandMark size={compact ? 36 : 72} active={logoActive} />
		</div>
		<div class="setup-copy">
			<h1 id={compact ? 'reader-model-setup-title' : 'model-setup-title'}>
				{compact ? 'Install the local voice engine' : 'Set up local listening.'}
			</h1>
			<p>
				{compact
					? 'Accept the model terms and finish the one-time download here.'
					: 'Private speech, downloaded once and kept on this device.'}
			</p>
		</div>
	</header>

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
	</footer>

	{#if installing || localError || progress.status === 'error' || appState.runtimeNotice}
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

	.license-step {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 0;
		margin-top: 26px;
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
		min-height: 48px;
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
		margin-top: 20px;
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

	.compact .license-step {
		padding: 0;
		margin-top: 14px;
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
