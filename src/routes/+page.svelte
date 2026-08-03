<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import {
		BrainCircuit,
		ArrowRight,
		FileText,
		Clock3,
		FileUp,
		Search,
		Trash2,
		Link2,
		Plus
	} from '$lib/icons';
	import { onMount } from 'svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import CompactSelect from '$lib/components/CompactSelect.svelte';
	import DocumentKindIcon from '$lib/components/DocumentKindIcon.svelte';
	import ModelInstallPrompt from '$lib/components/ModelInstallPrompt.svelte';
	import type { DocumentKind, NormalizedDocument } from '$lib/domain/types';
	import { appState } from '$lib/state/app-state.svelte';
	import { libraryAdd } from '$lib/state/library-add.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { providersState } from '$lib/state/providers.svelte';

	let dragging = $state(false);
	let dragDepth = 0;
	let searchQuery = $state('');
	let sortOrder = $state('recent');
	const sortOptions = [
		{ value: 'recent', label: 'Recent' },
		{ value: 'title', label: 'Title' },
		{ value: 'added', label: 'Added' },
		{ value: 'progress', label: 'Progress' }
	];
	let modelInstalled = $derived(appState.installedModels.includes('supertonic-3'));
	// The unified installer downloads the voice engine first; keep it on
	// screen while the narration model stage is still fetching a model that
	// has never been installed, so its progress stays visible.
	let llmFirstDownloadActive = $derived(
		llmState.activeModelId !== null &&
			!llmState.installedModels.includes(llmState.activeModelId) &&
			(llmState.phase === 'downloading' ||
				llmState.phase === 'loading' ||
				llmState.phase === 'probing')
	);
	// Speech-capable means a runnable engine is actually selected: the local
	// model installed, or ElevenLabs chosen with a key. A stored key alone
	// (notably the dev .env seed) must not skip setup after a factory reset.
	let speechCapable = $derived(
		modelInstalled || (providersState.initialized && providersState.cloudSpeechReady)
	);
	let showSetup = $derived(!speechCapable || llmFirstDownloadActive);
	// Existing installs predate the narration model: offer it once, dismissibly.
	let narrationOffer = $derived(
		modelInstalled &&
			!llmFirstDownloadActive &&
			llmState.initialized &&
			llmState.eligible &&
			llmState.installedModels.length === 0 &&
			!llmState.narrationHintDismissed
	);

	onMount(() => {
		void llmState.initialize();
		void providersState.initialize();
	});

	function progressFor(document: NormalizedDocument): number {
		if (!document.playback || !document.segments.length) return 0;
		const index = document.segments.findIndex(
			(segment) => segment.id === document.playback?.segmentId
		);
		return Math.max(0, ((index + 1) / document.segments.length) * 100);
	}

	let visibleDocuments = $derived.by(() => {
		const query = searchQuery.trim().toLocaleLowerCase();
		const filtered = query
			? appState.documents.filter((document) => document.title.toLocaleLowerCase().includes(query))
			: [...appState.documents];
		// appState.documents already arrives most-recently-updated first.
		if (sortOrder === 'title')
			return filtered.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
		if (sortOrder === 'added') return filtered.sort((a, b) => b.createdAt - a.createdAt);
		if (sortOrder === 'progress') return filtered.sort((a, b) => progressFor(b) - progressFor(a));
		return filtered;
	});

	function readingMinutes(document: NormalizedDocument): number {
		return Math.max(
			1,
			Math.round(
				document.segments.reduce((sum, segment) => sum + segment.estimatedDuration, 0) / 60
			)
		);
	}

	function fileKindLabel(kind: DocumentKind): string {
		return {
			pdf: 'PDF',
			docx: 'DOCX',
			markdown: 'MD',
			text: 'TXT',
			web: 'WEB'
		}[kind];
	}

	async function onDrop(event: DragEvent): Promise<void> {
		event.preventDefault();
		dragDepth = 0;
		dragging = false;
		if (!speechCapable) return;
		await libraryAdd.addFiles(Array.from(event.dataTransfer?.files ?? []));
	}

	function onDragEnter(event: DragEvent): void {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		dragDepth += 1;
		dragging = true;
	}

	function onDragOver(event: DragEvent): void {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(event: DragEvent): void {
		event.preventDefault();
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) dragging = false;
	}

	async function removeDocument(document: NormalizedDocument): Promise<void> {
		if (confirm('Remove “' + document.title + '” and its generated audio from this browser?'))
			await appState.deleteDocument(document.id);
	}
</script>

<svelte:head>
	<title>Library — Voicebook</title>
</svelte:head>

{#if !appState.initialized}
	<div class="workspace-page library-page" aria-busy="true">
		<div class="loading-row">Opening your private library…</div>
	</div>
{:else}
	<div
		class="workspace-page library-page"
		class:dragging
		role="region"
		aria-label="Document library workspace"
		ondragenter={onDragEnter}
		ondragover={onDragOver}
		ondragleave={onDragLeave}
		ondrop={onDrop}
	>
		{#if !showSetup && appState.documents.length}
			<header class="page-heading">
				<div>
					<p class="eyebrow">Local library</p>
					<h1>Library</h1>
					<p class="subtitle">Everything you add stays private on this device.</p>
				</div>
				<div class="library-actions heading-actions">
					<button
						class="button library-action"
						type="button"
						data-tour="paste-text"
						onclick={() => libraryAdd.openPaste()}
					>
						<Icon icon={FileText} size={16} /> Paste text
					</button>
					<button
						class="button library-action"
						type="button"
						data-tour="from-url"
						onclick={() => libraryAdd.openUrl()}
					>
						<Icon icon={Link2} size={16} /> From URL
					</button>
					<button
						class="button primary library-action"
						type="button"
						data-tour="add-document"
						onclick={() => libraryAdd.pickFiles()}
					>
						<Icon icon={Plus} size={16} /> Add document
					</button>
				</div>
			</header>
		{/if}

		{#if showSetup}
			<div class="library-welcome setup-welcome">
				<ModelInstallPrompt />
			</div>
		{:else if appState.documents.length}
			{#if narrationOffer}
				<aside class="narration-offer" aria-label="Language model setup suggestion">
					<Icon icon={BrainCircuit} size={16} />
					<p>
						<strong>New: spoken equations, tables, and diagrams.</strong>
						An on-device language model can rewrite them into words the reader voice can speak.
					</p>
					<div class="narration-offer-actions">
						<a class="button primary" href={resolve('/settings?section=llm')}> Set up the LLM </a>
						<button class="button" type="button" onclick={() => void llmState.dismissHint()}>
							Not now
						</button>
					</div>
				</aside>
			{/if}
			<section class="library-collection" aria-labelledby="documents-heading">
				<header class="library-meta">
					<div>
						<h2 id="documents-heading">Documents</h2>
						<span>
							{appState.documents.length}
							{appState.documents.length === 1 ? 'item' : 'items'}
						</span>
					</div>
					<div class="library-controls">
						<label class="library-search">
							<Icon icon={Search} size={14} aria-hidden="true" />
							<input
								type="search"
								placeholder="Search titles…"
								aria-label="Search the library"
								bind:value={searchQuery}
							/>
						</label>
						<CompactSelect
							label="Sort documents"
							value={sortOrder}
							options={sortOptions}
							onChange={(value) => {
								sortOrder = value;
							}}
							triggerWidth="86px"
							menuWidth="110px"
							align="end"
						/>
					</div>
				</header>

				<div class="document-table">
					{#if !visibleDocuments.length}
						<p class="library-no-matches" role="status">
							No documents match “{searchQuery.trim()}”.
						</p>
					{/if}
					{#each visibleDocuments as document (document.id)}
						<article class="document-row">
							<a
								class="document-link"
								href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
								aria-label={'Open ' + document.title}
							>
								<span class="file-kind" aria-hidden="true">
									<DocumentKindIcon kind={document.sourceKind} />
									<small>{fileKindLabel(document.sourceKind)}</small>
								</span>
								<span class="document-copy">
									<strong>{document.title}</strong>
									<small>{document.segments[0]?.text ?? 'Ready to listen.'}</small>
								</span>
								<span class="document-time"
									><Icon icon={Clock3} size={13} /> {readingMinutes(document)} min</span
								>
								<span class="document-progress">
									<span>{Math.round(progressFor(document))}%</span>
									<i><b style:width={progressFor(document) + '%'}></b></i>
								</span>
								<span class="row-arrow"><Icon icon={ArrowRight} size={16} /></span>
							</a>
							<button
								class="icon-button remove-document"
								type="button"
								aria-label={'Remove ' + document.title}
								onclick={() => removeDocument(document)}
							>
								<Icon icon={Trash2} size={15} />
							</button>
						</article>
					{/each}
				</div>
			</section>
		{:else}
			<section
				class="library-welcome empty-library"
				aria-labelledby="empty-library-title"
				aria-busy={appState.importing}
			>
				<div class="empty-library-content">
					<div class="empty-mark" aria-hidden="true">
						<BrandMark size={72} active={appState.importing} />
					</div>
					<h2 id="empty-library-title">
						{appState.importing ? 'Adding your document…' : 'What would you like to listen to?'}
					</h2>
					<p>
						{appState.importing
							? appState.statusMessage
							: 'Add a document or paste text. Voicebook prepares everything here on this device.'}
					</p>
					<div class="library-actions empty-actions">
						<button
							class="button primary library-action"
							type="button"
							data-tour="add-document"
							disabled={appState.importing}
							onclick={() => libraryAdd.pickFiles()}
						>
							<Icon icon={Plus} size={16} /> Add document
						</button>
						<button
							class="button library-action"
							type="button"
							data-tour="paste-text"
							disabled={appState.importing}
							onclick={() => libraryAdd.openPaste()}
						>
							<Icon icon={FileText} size={16} /> Paste text
						</button>
						<button
							class="button library-action"
							type="button"
							data-tour="from-url"
							disabled={appState.importing}
							onclick={() => libraryAdd.openUrl()}
						>
							<Icon icon={Link2} size={16} /> From URL
						</button>
					</div>
					<div class="empty-library-note">
						<span>PDF · DOCX · MD · TXT · URL</span>
						<span aria-hidden="true">·</span>
						<span>Never uploaded</span>
					</div>
				</div>
			</section>
		{/if}

		{#if dragging}
			<div class="library-drop-overlay" aria-hidden="true">
				<span><Icon icon={FileUp} size={24} /></span>
				<strong>Drop to add to your library</strong>
				<small>Release the files to import them locally</small>
			</div>
		{/if}
	</div>
{/if}

<div class="status-region" aria-live="polite">{appState.statusMessage}</div>

<style>
	.status-region {
		position: absolute;
		width: 1px !important;
		height: 1px !important;
		padding: 0 !important;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	.library-page {
		position: relative;
		min-height: calc(100dvh - var(--app-header-height));
	}

	.library-welcome {
		display: flex;
		min-height: min(590px, calc(100dvh - var(--app-header-height) - 56px));
		align-items: flex-start;
		justify-content: center;
		padding: clamp(64px, 10dvh, 96px) 32px 64px;
	}

	.page-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 32px;
		margin-bottom: 44px;
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
		font-family: var(--font-display);
		font-size: 2.55rem;
		font-variation-settings: 'opsz' 40;
		font-weight: 560;
		letter-spacing: -0.04em;
		line-height: 0.98;
	}

	.subtitle {
		margin: 10px 0 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.5;
	}

	.library-actions {
		display: flex;
		gap: 8px;
	}

	.library-action {
		width: 148px;
		height: 44px;
		padding: 0 16px;
		font-size: 11px;
		white-space: nowrap;
	}

	.narration-offer {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		border: 1px solid color-mix(in srgb, var(--primary) 26%, var(--line));
		border-radius: 10px;
		margin-bottom: 16px;
		background: color-mix(in srgb, var(--primary-soft) 58%, transparent);
		color: var(--text-soft);
	}

	.narration-offer > :global(svg) {
		flex: none;
		color: var(--primary);
	}

	.narration-offer p {
		min-width: 0;
		margin: 0;
		flex: 1;
		font-size: 11px;
		line-height: 1.5;
	}

	.narration-offer p strong {
		display: block;
		color: var(--text);
		font-weight: 650;
	}

	.narration-offer-actions {
		display: flex;
		flex: none;
		gap: 8px;
	}

	@media (max-width: 680px) {
		.narration-offer {
			flex-direction: column;
			align-items: flex-start;
		}
	}

	.library-collection {
		margin-top: 8px;
	}

	.library-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		padding-bottom: 14px;
		border-bottom: 1px solid var(--line-strong);
	}

	.library-meta > div:first-child {
		display: flex;
		align-items: baseline;
		gap: 9px;
	}

	.library-meta h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 650;
	}

	.library-meta span {
		color: var(--faint);
		font-size: 10px;
	}

	.library-controls {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.library-search {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px;
		border: 1px solid var(--control-border);
		border-radius: 999px;
		background: var(--control);
		color: var(--faint);
	}

	.library-search:focus-within {
		border-color: var(--line-strong);
		color: var(--muted);
	}

	.library-search input {
		width: 148px;
		height: 28px;
		/* The pill is the only visible container: strip the browser's boxed
		 * search field and @tailwindcss/forms' base input chrome, which both
		 * paint their own background, border, and padding here. */
		padding: 0 !important;
		border: 0 !important;
		appearance: none;
		-webkit-appearance: none;
		border-radius: 0;
		background: transparent !important;
		box-shadow: none !important;
		color: var(--text);
		font-size: 11px;
		outline: none;
	}

	.library-search input::-webkit-search-decoration,
	.library-search input::-webkit-search-cancel-button,
	.library-search input::-webkit-search-results-button {
		display: none;
	}

	.library-search input::placeholder {
		color: var(--faint);
	}

	.library-no-matches {
		margin: 0;
		padding: 22px 0;
		color: var(--faint);
		font-size: 11px;
		text-align: center;
	}

	@media (max-width: 640px) {
		.library-meta {
			flex-wrap: wrap;
		}

		.library-search input {
			width: 110px;
		}
	}

	.document-table {
		min-height: 240px;
	}

	.document-row {
		position: relative;
		border-bottom: 1px solid var(--line);
	}

	.document-link {
		display: grid;
		min-height: 86px;
		grid-template-columns: 30px minmax(0, 1fr) 84px 120px 24px;
		align-items: center;
		gap: 16px;
		padding: 12px 52px 12px 8px;
		border-radius: 8px;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.document-link:hover {
		background: var(--hover);
	}

	.file-kind {
		display: flex;
		width: 30px;
		align-items: center;
		flex-direction: column;
		gap: 4px;
		color: var(--primary);
	}

	.file-kind small {
		color: var(--faint);
		font-size: 7px;
		font-weight: 720;
		letter-spacing: 0.03em;
		line-height: 1;
		text-transform: uppercase;
	}

	.document-copy,
	.document-copy strong,
	.document-copy small {
		display: block;
		min-width: 0;
	}

	.document-copy strong,
	.document-copy small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.document-copy strong {
		font-family: var(--font-display);
		font-size: 14px;
		font-variation-settings: 'opsz' 18;
		font-weight: 560;
		letter-spacing: -0.012em;
	}

	.document-copy small {
		margin-top: 6px;
		color: var(--faint);
		font-size: 10px;
	}

	.document-time {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 10px;
	}

	.document-progress {
		display: grid;
		gap: 6px;
		color: var(--faint);
		font-size: 9px;
	}

	.document-progress i {
		display: block;
		height: 2px;
		overflow: hidden;
		background: var(--line-strong);
	}

	.document-progress b {
		display: block;
		height: 100%;
		background: var(--primary);
	}

	.row-arrow {
		color: var(--faint);
	}

	.remove-document {
		position: absolute;
		top: 25px;
		right: 4px;
		width: 36px;
		height: 36px;
	}

	.loading-row {
		padding: 72px 4px;
		color: var(--muted);
		font-size: 12px;
	}

	.empty-library-content {
		display: flex;
		max-width: 560px;
		align-items: center;
		flex-direction: column;
		text-align: center;
	}

	.empty-mark {
		margin-bottom: 26px;
	}

	.empty-library h2 {
		margin: 0;
		color: var(--text);
		font-family: var(--font-display);
		font-size: clamp(1.7rem, 2.4vw, 2.2rem);
		font-variation-settings: 'opsz' 36;
		font-weight: 560;
		letter-spacing: -0.035em;
		line-height: 1.15;
	}

	.empty-library p {
		max-width: 480px;
		margin: 12px 0 0;
		color: var(--muted);
		font-size: 12px;
		line-height: 1.65;
	}

	.empty-actions {
		margin-top: 28px;
	}

	.empty-library-note {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 9px;
		margin-top: 24px;
		color: var(--faint);
		font-size: 9px;
		letter-spacing: 0.01em;
	}

	.library-drop-overlay {
		position: absolute;
		inset: 20px 0 52px;
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--primary);
		border-radius: 16px;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		box-shadow: inset 0 0 0 4px var(--primary-soft);
		backdrop-filter: blur(18px) saturate(1.2);
		-webkit-backdrop-filter: blur(18px) saturate(1.2);
		color: var(--primary);
		flex-direction: column;
		pointer-events: none;
	}

	.library-drop-overlay span {
		display: grid;
		width: 52px;
		height: 52px;
		margin-bottom: 18px;
		place-items: center;
		border-radius: 14px;
		background: var(--primary-soft);
	}

	.library-drop-overlay strong {
		color: var(--text);
		font-size: 16px;
		font-weight: 650;
	}

	.library-drop-overlay small {
		margin-top: 7px;
		color: var(--muted);
		font-size: 10px;
	}

	@media (max-width: 900px) {
		.document-link {
			grid-template-columns: 30px minmax(0, 1fr) 100px 24px;
		}

		.document-time {
			display: none;
		}
	}

	@media (max-width: 680px) {
		.page-heading {
			align-items: flex-start;
			flex-direction: column;
			margin-bottom: 32px;
		}

		.heading-actions {
			width: 100%;
		}

		.library-action {
			width: auto;
			flex: 1;
		}

		.library-welcome {
			min-height: calc(100dvh - var(--app-header-height) - 32px);
			padding: 44px 20px;
		}

		.document-link {
			grid-template-columns: 30px minmax(0, 1fr) 24px;
		}

		.document-progress {
			display: none;
		}

		.empty-actions {
			width: min(100%, 280px);
			flex-direction: column;
		}

		.empty-actions .library-action {
			width: 100%;
			flex: none;
		}

		.empty-library-note {
			flex-wrap: wrap;
		}

		.library-drop-overlay {
			inset: 12px 0 36px;
		}
	}
</style>
