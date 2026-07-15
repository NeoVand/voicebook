<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		ArrowRight,
		BookOpenText,
		Clock3,
		FileCode,
		FileScan,
		FileText,
		FileType,
		FileUp,
		Plus,
		Trash2,
		X
	} from '@lucide/svelte';
	import type { DocumentKind, NormalizedDocument } from '$lib/domain/types';
	import { appState } from '$lib/state/app-state.svelte';

	let fileInput: HTMLInputElement | undefined;
	let dragging = $state(false);
	let dragDepth = 0;
	let pasteOpen = $state(false);
	let pasteTitle = $state('');
	let pasteText = $state('');

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
	<header class="page-heading">
		<div>
			<p class="eyebrow">Local library</p>
			<h1>Library</h1>
			<p class="subtitle">Everything you add stays private on this device.</p>
		</div>
		{#if appState.initialized && appState.documents.length}
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
		{/if}
	</header>

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

	{#if !appState.initialized}
		<div class="loading-row">Opening your local library…</div>
	{:else if appState.documents.length}
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
								{#if document.sourceKind === 'pdf'}
									<FileScan size={20} strokeWidth={1.7} />
								{:else if document.sourceKind === 'docx'}
									<FileType size={20} strokeWidth={1.7} />
								{:else if document.sourceKind === 'markdown'}
									<FileCode size={20} strokeWidth={1.7} />
								{:else}
									<FileText size={20} strokeWidth={1.7} />
								{/if}
								<small>{fileKindLabel(document.sourceKind)}</small>
							</span>
							<span class="document-copy">
								<strong>{document.title}</strong>
								<small>{document.segments[0]?.text ?? 'Ready to listen.'}</small>
							</span>
							<span class="document-time"><Clock3 size={13} /> {readingMinutes(document)} min</span>
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
			class="empty-library"
			aria-labelledby="empty-library-title"
			aria-busy={appState.importing}
		>
			<div class="empty-library-content">
				<span class="empty-icon" aria-hidden="true">
					{#if appState.importing}
						<span class="importing-icon"><FileUp size={24} /></span>
					{:else}
						<BookOpenText size={25} />
					{/if}
				</span>
				<h2 id="empty-library-title">
					{appState.importing ? 'Adding your document…' : 'What would you like to listen to?'}
				</h2>
				<p>
					{appState.importing
						? appState.statusMessage
						: 'Drop a PDF, DOCX, Markdown, or text file here to turn it into a calm reading experience.'}
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
					<span>PDF · DOCX · Markdown · TXT</span>
					<span aria-hidden="true">·</span>
					<span>Processed locally</span>
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
					<h2 id="paste-title">Paste text</h2>
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
				<textarea bind:value={pasteText} placeholder="Paste text to read aloud…"></textarea>
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
		<div class="duplicate-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
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
		font-size: 2.25rem;
		font-weight: 660;
		letter-spacing: -0.05em;
		line-height: 1;
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
		font-size: 12px;
		font-weight: 620;
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

	.empty-library {
		display: flex;
		min-height: min(480px, calc(100dvh - 230px));
		align-items: center;
		justify-content: center;
		padding: 56px 32px;
		border: 1px solid var(--line-strong);
		border-radius: 14px;
		background: linear-gradient(145deg, var(--primary-soft), transparent 42%), var(--surface);
		transition:
			border-color 150ms var(--ease),
			background 150ms var(--ease),
			box-shadow 150ms var(--ease);
	}

	.empty-library-content {
		display: flex;
		max-width: 560px;
		align-items: center;
		flex-direction: column;
		text-align: center;
	}

	.empty-icon {
		display: grid;
		width: 52px;
		height: 52px;
		margin-bottom: 22px;
		place-items: center;
		border: 1px solid var(--line-strong);
		border-radius: 14px;
		background: var(--control-strong);
		color: var(--primary);
	}

	.empty-library h2 {
		margin: 0;
		color: var(--text);
		font-size: clamp(1.45rem, 2.2vw, 2rem);
		font-weight: 650;
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

	.importing-icon {
		animation: importing-pulse 1.1s ease-in-out infinite;
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

	@keyframes importing-pulse {
		50% {
			transform: translateY(-2px);
			opacity: 0.55;
		}
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
		font-size: 17px;
		font-weight: 650;
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

		.empty-library {
			min-height: 420px;
			padding: 48px 24px;
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

	@media (prefers-reduced-motion: reduce) {
		.importing-icon {
			animation: none;
		}
	}
</style>
