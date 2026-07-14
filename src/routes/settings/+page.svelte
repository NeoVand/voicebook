<script lang="ts">
	import { page } from '$app/state';
	import {
		AlertTriangle,
		ArrowUpRight,
		Check,
		Cpu,
		Database,
		Download,
		Gauge,
		HardDrive,
		Keyboard,
		LockKeyhole,
		Mic2,
		RefreshCw,
		ShieldCheck,
		Square,
		Trash2,
		Wifi
	} from '@lucide/svelte';
	import { getModel } from '$lib/domain/model-catalog';
	import { appState } from '$lib/state/app-state.svelte';
	import { requestPersistentStorage } from '$lib/services/repository';

	type SettingsSection = 'models' | 'storage' | 'system';

	const model = getModel('supertonic-3');
	let busy = $state(false);
	let storageBusy = $state(false);
	let activeSection = $derived.by<SettingsSection>(() => {
		const section = page.url.searchParams.get('section');
		return section === 'storage' || section === 'system' ? section : 'models';
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
</script>

<svelte:head>
	<title>Settings — Voicebook</title>
</svelte:head>

<div class="workspace-page settings-page">
	<header class="page-heading">
		<div>
			<p class="eyebrow">Preferences</p>
			<h1>
				{activeSection === 'models' ? 'Voice' : activeSection === 'storage' ? 'Storage' : 'System'}
			</h1>
			<p>
				{activeSection === 'models'
					? 'One fast, local speech engine. No model switching in the reader.'
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
		<section class="settings-section" aria-labelledby="engine-title">
			<header class="section-title">
				<div>
					<h2 id="engine-title">Speech engine</h2>
					<p>Downloaded once from Hugging Face, then run entirely in this browser.</p>
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

			<div class="setting-row">
				<div>
					<strong>Execution</strong>
					<p>
						{appState.capabilities.webgpu
							? 'WebGPU acceleration is available on this device.'
							: 'WebGPU is unavailable. Voicebook will use the slower WASM fallback.'}
					</p>
				</div>
				<span class="capability-label">
					<Cpu size={15} />
					{appState.capabilities.webgpu ? 'WebGPU' : 'WASM'}
				</span>
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
				<p>Apache-2.0 application · OpenRAIL-M model · estimated word timing</p>
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

		<section class="settings-section voices-section" aria-labelledby="voices-title">
			<header class="section-title">
				<div>
					<h2 id="voices-title">Built-in voices</h2>
					<p>Choose a voice from the reader. Switching voices keeps your reading position.</p>
				</div>
				<span>{model.voices.length} voices</span>
			</header>
			<div class="voice-list">
				{#each model.voices as voice (voice.id)}
					<div>
						<span class="voice-initial">{voice.name.charAt(0)}</span>
						<strong>{voice.name}</strong>
						<small>{voice.gender ?? 'Voice'} · multilingual</small>
					</div>
				{/each}
			</div>
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
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}

	.voice-list > div {
		display: grid;
		min-height: 78px;
		grid-template-columns: auto 1fr;
		align-content: center;
		column-gap: 9px;
		border-bottom: 1px solid var(--line);
	}

	.voice-initial {
		display: grid;
		width: 28px;
		height: 28px;
		grid-row: 1 / 3;
		place-items: center;
		border-radius: 50%;
		background: var(--primary-soft);
		color: var(--primary);
		font-size: 10px;
		font-weight: 700;
	}

	.voice-list strong {
		font-size: 9px;
		font-weight: 630;
	}

	.voice-list small {
		color: var(--faint);
		font-size: 8px;
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
		background: rgba(255, 255, 255, 0.06);
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

		.voice-list {
			grid-template-columns: repeat(2, minmax(0, 1fr));
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
	}
</style>
