<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		ArrowRight,
		BookOpenText,
		BrainCircuit,
		Clock3,
		FileText,
		FileUp,
		Plus,
		Trash2,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import DocumentKindIcon from '$lib/components/DocumentKindIcon.svelte';
	import ModelInstallPrompt from '$lib/components/ModelInstallPrompt.svelte';
	import type { DocumentKind, NormalizedDocument } from '$lib/domain/types';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { providersState } from '$lib/state/providers.svelte';

	let fileInput: HTMLInputElement | undefined;
	let dragging = $state(false);
	let dragDepth = 0;
	let pasteOpen = $state(false);
	let pasteTitle = $state('');
	let pasteText = $state('');
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
	// A saved ElevenLabs key makes the app speech-capable without any local
	// download — setup steps aside the moment either path is ready.
	let speechCapable = $derived(
		modelInstalled || (providersState.initialized && providersState.elevenLabsReady)
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

	function captureFileInput(node: HTMLInputElement): () => void {
		fileInput = node;
		return () => {
			if (fileInput === node) fileInput = undefined;
		};
	}

	function progressFor(document: NormalizedDocument): number {
		if (!document.playback || !document.segments.length) return 0;
		const index = document.segments.findIndex(
			(segment) => segment.id === document.playback?.segmentId
		);
		return Math.max(0, ((index + 1) / document.segments.length) * 100);
	}

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
			text: 'TXT'
		}[kind];
	}

	async function acceptFiles(files: File[]): Promise<void> {
		const imported = await appState.importFiles(files);
		if (files.length === 1 && imported[0])
			await goto(resolve(`/read?document=${encodeURIComponent(imported[0].id)}`));
	}

	async function onFileChange(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		await acceptFiles(Array.from(target.files ?? []));
		target.value = '';
	}

	async function onDrop(event: DragEvent): Promise<void> {
		event.preventDefault();
		dragDepth = 0;
		dragging = false;
		if (!speechCapable) return;
		await acceptFiles(Array.from(event.dataTransfer?.files ?? []));
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

	async function savePaste(): Promise<void> {
		const document = await appState.addPastedText(pasteTitle, pasteText);
		if (!document) return;
		pasteTitle = '';
		pasteText = '';
		pasteOpen = false;
		await goto(resolve(`/read?document=${encodeURIComponent(document.id)}`));
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
					<button class="button library-action" type="button" onclick={() => (pasteOpen = true)}>
						<FileText size={16} /> Paste text
					</button>
					<button
						class="button primary library-action"
						type="button"
						onclick={() => fileInput?.click()}
					>
						<Plus size={16} /> Add document
					</button>
				</div>
			</header>
		{/if}

		<input
			id="document-upload"
			class="visually-hidden"
			type="file"
			multiple
			aria-label="Choose documents to import"
			accept=".pdf,.docx,.md,.markdown,.txt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			{@attach captureFileInput}
			onchange={onFileChange}
		/>

		{#if showSetup}
			<div class="library-welcome setup-welcome">
				<ModelInstallPrompt />
			</div>
		{:else if appState.documents.length}
			{#if narrationOffer}
				<aside class="narration-offer" aria-label="Language model setup suggestion">
					<BrainCircuit size={16} />
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
					<p>Drop files anywhere in the library to add them.</p>
				</header>

				<div class="document-table">
					{#each appState.documents as document (document.id)}
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
									><Clock3 size={13} /> {readingMinutes(document)} min</span
								>
								<span class="document-progress">
									<span>{Math.round(progressFor(document))}%</span>
									<i><b style:width={progressFor(document) + '%'}></b></i>
								</span>
								<span class="row-arrow"><ArrowRight size={16} /></span>
							</a>
							<button
								class="icon-button remove-document"
								type="button"
								aria-label={'Remove ' + document.title}
								onclick={() => removeDocument(document)}
							>
								<Trash2 size={15} />
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
							disabled={appState.importing}
							onclick={() => fileInput?.click()}
						>
							<Plus size={16} /> Add document
						</button>
						<button
							class="button library-action"
							type="button"
							disabled={appState.importing}
							onclick={() => (pasteOpen = true)}
						>
							<FileText size={16} /> Paste text
						</button>
					</div>
					<div class="empty-library-note">
						<span>PDF · DOCX · MD · TXT</span>
						<span aria-hidden="true">·</span>
						<span>Never uploaded</span>
					</div>
				</div>
			</section>
		{/if}

		{#if dragging}
			<div class="library-drop-overlay" aria-hidden="true">
				<span><FileUp size={24} /></span>
				<strong>Drop to add to your library</strong>
				<small>Release the files to import them locally</small>
			</div>
		{/if}
	</div>

	{#if pasteOpen}
		<div class="modal-scrim" role="presentation">
			<div class="paste-dialog" role="dialog" aria-modal="true" aria-labelledby="paste-title">
				<header>
					<div>
						<p class="eyebrow">Quick import</p>
						<h2 id="paste-title">Paste text or Markdown</h2>
					</div>
					<button
						class="icon-button"
						type="button"
						aria-label="Close"
						onclick={() => (pasteOpen = false)}
					>
						<X size={18} />
					</button>
				</header>
				<label class="form-field">
					<span>Title</span>
					<input bind:value={pasteTitle} placeholder="Untitled document" />
				</label>
				<label class="form-field">
					<span>Text</span>
					<textarea bind:value={pasteText} placeholder="Paste text or Markdown to read aloud…"
					></textarea>
				</label>
				<footer>
					<small>{pasteText.trim().split(/\s+/).filter(Boolean).length} words</small>
					<div>
						<button class="button ghost" type="button" onclick={() => (pasteOpen = false)}
							>Cancel</button
						>
						<button
							class="button primary"
							type="button"
							disabled={!pasteText.trim()}
							onclick={savePaste}
						>
							Add to library
						</button>
					</div>
				</footer>
			</div>
		</div>
	{/if}

	{#if appState.duplicate}
		<div class="modal-scrim" role="presentation">
			<div
				class="duplicate-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="duplicate-title"
			>
				<span class="duplicate-icon"><BookOpenText size={22} /></span>
				<h2 id="duplicate-title">Already in your library</h2>
				<p>“{appState.duplicate.existing.title}” matches this file.</p>
				<footer>
					<button class="button ghost" type="button" onclick={() => (appState.duplicate = null)}
						>Cancel</button
					>
					<button class="button" type="button" onclick={() => appState.importDuplicateCopy()}
						>Keep copy</button
					>
					<a
						class="button primary"
						href={resolve(`/read?document=${encodeURIComponent(appState.duplicate.existing.id)}`)}
					>
						Open existing
					</a>
				</footer>
			</div>
		</div>
	{/if}
{/if}

<div class="status-region" aria-live="polite">{appState.statusMessage}</div>

<style>
	.visually-hidden,
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

	.library-meta p {
		margin: 0;
		color: var(--faint);
		font-size: 10px;
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

	.modal-scrim {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 20px;
		background: var(--modal-scrim);
	}

	.paste-dialog,
	.duplicate-dialog {
		width: min(540px, 100%);
		padding: 22px;
		border-radius: 8px;
		background: var(--modal-surface);
		box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
	}

	.paste-dialog {
		display: grid;
		gap: 17px;
	}

	.paste-dialog header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
	}

	.paste-dialog h2,
	.duplicate-dialog h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 21px;
		font-variation-settings: 'opsz' 24;
		font-weight: 560;
		letter-spacing: -0.025em;
	}

	.paste-dialog textarea {
		min-height: 230px;
	}

	.paste-dialog footer,
	.duplicate-dialog footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.paste-dialog footer > div,
	.duplicate-dialog footer {
		display: flex;
		gap: 8px;
	}

	.paste-dialog footer small {
		color: var(--faint);
		font-size: 9px;
	}

	.duplicate-icon {
		color: var(--primary);
	}

	.duplicate-dialog h2 {
		margin-top: 17px;
	}

	.duplicate-dialog p {
		margin: 7px 0 24px;
		color: var(--muted);
		font-size: 11px;
	}

	.duplicate-dialog footer {
		justify-content: flex-end;
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

		.library-meta p {
			display: none;
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
