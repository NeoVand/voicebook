<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		ArrowRight,
		BookOpenText,
		Check,
		Clock3,
		Cpu,
		FileText,
		FileUp,
		Plus,
		ShieldCheck,
		Trash2,
		X
	} from '@lucide/svelte';
	import type { NormalizedDocument } from '$lib/domain/types';
	import { appState } from '$lib/state/app-state.svelte';

	let fileInput: HTMLInputElement | undefined;
	let dragging = $state(false);
	let pasteOpen = $state(false);
	let pasteTitle = $state('');
	let pasteText = $state('');

	let engineProgress = $derived(appState.modelProgress['supertonic-3']);
	let engineInstalled = $derived(appState.installedModels.includes('supertonic-3'));
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));

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
		dragging = false;
		await acceptFiles(Array.from(event.dataTransfer?.files ?? []));
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

	async function installEngine(): Promise<void> {
		try {
			await appState.installModel('supertonic-3');
		} catch (error) {
			appState.errorMessage =
				error instanceof Error ? error.message : 'Supertonic 3 could not be installed.';
		}
	}
</script>

<svelte:head>
	<title>Library — Voicebook</title>
</svelte:head>

<div class="workspace-page library-page">
	<header class="page-heading">
		<div>
			<p class="eyebrow">Your workspace</p>
			<h1>Library</h1>
			<p class="subtitle">Read and listen without sending a document anywhere.</p>
		</div>
		<div class="heading-actions">
			<button class="button" type="button" onclick={() => (pasteOpen = true)}>
				<FileText size={15} /> Paste text
			</button>
			<button class="button primary" type="button" onclick={() => fileInput?.click()}>
				<Plus size={16} /> Add document
			</button>
		</div>
	</header>

	<label
		class="import-strip"
		class:dragging
		class:busy={appState.importing}
		for="document-upload"
		ondragover={(event) => {
			event.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		<span class="import-icon"><FileUp size={20} /></span>
		<span class="import-copy">
			<strong>{appState.importing ? appState.statusMessage : 'Drop a document here'}</strong>
			<small>PDF, DOCX, Markdown, or text · processed in this browser</small>
		</span>
		<span class="button">Choose file</span>
	</label>
	<input
		id="document-upload"
		class="visually-hidden"
		type="file"
		multiple
		accept=".pdf,.docx,.md,.markdown,.txt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		{@attach captureFileInput}
		onchange={onFileChange}
	/>

	<section class="engine-line" aria-labelledby="engine-heading">
		<div class="engine-copy">
			<Cpu size={16} />
			<div>
				<strong id="engine-heading">Supertonic 3</strong>
				<span>
					{engineInstalled
						? 'Ready for local speech'
						: 'Required once · 31 languages · ten voices · 415 MB'}
				</span>
			</div>
		</div>
		{#if engineProgress.status === 'loading'}
			<div class="engine-progress" aria-live="polite">
				<span>{engineProgress.message}</span>
				<progress max="100" value={engineProgress.progress}></progress>
				<strong>{Math.round(engineProgress.progress)}%</strong>
			</div>
		{:else if engineInstalled}
			<span class="ready"><Check size={14} /> Ready</span>
		{:else if !licenseAccepted}
			<a class="text-action" href={resolve('/settings')}>Review license <ArrowRight size={14} /></a>
		{:else}
			<button class="button" type="button" onclick={installEngine}>
				{engineProgress.status === 'error' ? 'Retry install' : 'Install voice'}
			</button>
		{/if}
	</section>

	<div class="library-meta">
		<div>
			<h2>Documents</h2>
			<span>
				{appState.documents.length}
				{appState.documents.length === 1 ? 'item' : 'items'}
			</span>
		</div>
		<div class="privacy-note"><ShieldCheck size={14} /> No uploads or telemetry</div>
	</div>

	<section class="document-table" aria-label="Documents">
		{#if !appState.initialized}
			<div class="loading-row">Opening your local library…</div>
		{:else if appState.documents.length}
			{#each appState.documents as document (document.id)}
				<article class="document-row">
					<a
						class="document-link"
						href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
						aria-label={'Open ' + document.title}
					>
						<span class="file-kind">
							<FileText size={16} />
							<small>{document.sourceKind}</small>
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
		{:else}
			<div class="empty-library">
				<span class="empty-icon"><BookOpenText size={28} /></span>
				<div>
					<h3>Your library is empty</h3>
					<p>
						Drop in a document and Voicebook will turn it into a clean, listenable reading view.
					</p>
				</div>
				<button class="button primary" type="button" onclick={() => fileInput?.click()}>
					Add your first document
				</button>
			</div>
		{/if}
	</section>
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

	.page-heading {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		margin-bottom: 28px;
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

	.subtitle {
		margin: 6px 0 0;
		color: var(--muted);
		font-size: 11px;
	}

	.heading-actions {
		display: flex;
		gap: 8px;
	}

	.import-strip {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 14px;
		min-height: 88px;
		padding: 16px 18px;
		border: 1px dashed var(--line-strong);
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.015);
		transition:
			background 150ms var(--ease),
			border-color 150ms var(--ease);
	}

	.import-strip:hover,
	.import-strip.dragging {
		border-color: rgba(168, 157, 246, 0.5);
		background: var(--primary-soft);
	}

	.import-strip.busy {
		pointer-events: none;
		opacity: 0.65;
	}

	.import-icon {
		display: grid;
		width: 38px;
		height: 38px;
		place-items: center;
		border-radius: 6px;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.import-copy strong,
	.import-copy small {
		display: block;
	}

	.import-copy strong {
		font-size: 12px;
		font-weight: 640;
	}

	.import-copy small {
		margin-top: 5px;
		color: var(--faint);
		font-size: 9px;
	}

	.engine-line {
		display: flex;
		min-height: 58px;
		align-items: center;
		justify-content: space-between;
		gap: 18px;
		margin-top: 14px;
		padding: 0 4px 0 2px;
		border-bottom: 1px solid var(--line);
	}

	.engine-copy {
		display: flex;
		align-items: center;
		gap: 11px;
		color: var(--primary);
	}

	.engine-copy strong,
	.engine-copy span {
		display: block;
	}

	.engine-copy strong {
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 640;
	}

	.engine-copy span {
		margin-top: 3px;
		color: var(--faint);
		font-size: 9px;
	}

	.ready,
	.text-action,
	.privacy-note {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 9px;
		font-weight: 620;
	}

	.ready {
		color: var(--success);
	}

	.text-action {
		color: var(--primary);
	}

	.engine-progress {
		display: grid;
		width: min(390px, 46%);
		grid-template-columns: minmax(0, 1fr) 100px 32px;
		align-items: center;
		gap: 10px;
		color: var(--muted);
		font-size: 9px;
	}

	.engine-progress span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.engine-progress progress {
		width: 100%;
		height: 4px;
		accent-color: var(--primary);
	}

	.library-meta {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-top: 34px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--line-strong);
	}

	.library-meta > div:first-child {
		display: flex;
		align-items: baseline;
		gap: 9px;
	}

	.library-meta h2 {
		margin: 0;
		font-size: 13px;
		font-weight: 650;
	}

	.library-meta span,
	.privacy-note {
		color: var(--faint);
		font-size: 9px;
	}

	.document-table {
		min-height: 300px;
	}

	.document-row {
		position: relative;
		border-bottom: 1px solid var(--line);
	}

	.document-link {
		display: grid;
		min-height: 78px;
		grid-template-columns: 40px minmax(0, 1fr) 76px 112px 24px;
		align-items: center;
		gap: 14px;
		padding: 10px 52px 10px 4px;
		transition: background 150ms var(--ease);
	}

	.document-link:hover {
		background: rgba(255, 255, 255, 0.022);
	}

	.file-kind {
		display: grid;
		width: 36px;
		height: 44px;
		place-items: center;
		border-radius: 5px;
		background: var(--surface);
		color: var(--primary);
	}

	.file-kind small {
		margin-top: -9px;
		color: var(--faint);
		font-size: 6px;
		font-weight: 720;
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
		font-size: 11px;
		font-weight: 620;
	}

	.document-copy small {
		margin-top: 5px;
		color: var(--faint);
		font-size: 9px;
	}

	.document-time {
		display: flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 9px;
	}

	.document-progress {
		display: grid;
		gap: 6px;
		color: var(--faint);
		font-size: 8px;
	}

	.document-progress i {
		display: block;
		height: 2px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.05);
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
		top: 19px;
		right: 4px;
		width: 36px;
		height: 36px;
	}

	.loading-row {
		padding: 48px 4px;
		color: var(--muted);
		font-size: 11px;
	}

	.empty-library {
		display: grid;
		max-width: 620px;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 18px;
		margin: 72px auto 0;
		color: var(--primary);
	}

	.empty-library h3 {
		margin: 0;
		color: var(--text);
		font-size: 13px;
		font-weight: 650;
	}

	.empty-library p {
		margin: 5px 0 0;
		color: var(--muted);
		font-size: 10px;
		line-height: 1.5;
	}

	.modal-scrim {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: grid;
		place-items: center;
		padding: 20px;
		background: rgba(5, 6, 8, 0.78);
	}

	.paste-dialog,
	.duplicate-dialog {
		width: min(540px, 100%);
		padding: 22px;
		border-radius: 8px;
		background: #15171c;
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
			grid-template-columns: 40px minmax(0, 1fr) 90px 24px;
		}

		.document-time {
			display: none;
		}
	}

	@media (max-width: 680px) {
		.page-heading,
		.engine-line {
			align-items: flex-start;
			flex-direction: column;
		}

		.heading-actions {
			width: 100%;
		}

		.heading-actions .button {
			flex: 1;
		}

		.import-strip {
			grid-template-columns: auto 1fr;
		}

		.import-strip > .button {
			display: none;
		}

		.engine-line {
			padding: 12px 2px;
		}

		.engine-progress {
			width: 100%;
		}

		.document-link {
			grid-template-columns: 40px minmax(0, 1fr) 24px;
		}

		.document-progress,
		.privacy-note {
			display: none;
		}

		.empty-library {
			grid-template-columns: 1fr;
			text-align: center;
		}

		.empty-icon {
			margin: auto;
		}
	}
</style>
