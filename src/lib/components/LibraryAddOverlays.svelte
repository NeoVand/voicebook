<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import { BookOpenText, X } from '$lib/icons';
	import { appState } from '$lib/state/app-state.svelte';
	import { libraryAdd } from '$lib/state/library-add.svelte';

	let fileInput: HTMLInputElement | undefined;
	let pasteTitle = $state('');
	let pasteText = $state('');
	let urlValue = $state('');
	let urlError = $state('');
	let urlBusy = $state(false);

	function captureFileInput(node: HTMLInputElement): () => void {
		fileInput = node;
		libraryAdd.registerFilePicker(() => node.click());
		return () => {
			if (fileInput === node) {
				fileInput = undefined;
				libraryAdd.registerFilePicker(null);
			}
		};
	}

	async function onFileChange(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		await libraryAdd.addFiles(Array.from(target.files ?? []));
		target.value = '';
	}

	async function savePaste(): Promise<void> {
		const document = await appState.addPastedText(pasteTitle, pasteText);
		if (!document) return;
		pasteTitle = '';
		pasteText = '';
		libraryAdd.pasteOpen = false;
		await goto(resolve(`/read?document=${encodeURIComponent(document.id)}`));
	}

	async function saveUrl(): Promise<void> {
		if (!urlValue.trim() || urlBusy) return;
		urlBusy = true;
		urlError = '';
		const document = await appState.addWebArticle(urlValue);
		urlBusy = false;
		if (!document) {
			urlError = appState.errorMessage || 'The page could not be imported.';
			return;
		}
		libraryAdd.urlOpen = false;
		urlValue = '';
		await goto(resolve(`/read?document=${encodeURIComponent(document.id)}`));
	}
</script>

<input
	id="document-upload"
	class="visually-hidden-input"
	type="file"
	multiple
	aria-label="Choose documents to import"
	accept=".pdf,.docx,.md,.markdown,.txt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	{@attach captureFileInput}
	onchange={onFileChange}
/>

{#if libraryAdd.pasteOpen}
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
					onclick={() => (libraryAdd.pasteOpen = false)}
				>
					<Icon icon={X} size={18} />
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
					<button class="button ghost" type="button" onclick={() => (libraryAdd.pasteOpen = false)}
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

{#if libraryAdd.urlOpen}
	<div class="modal-scrim" role="presentation">
		<div
			class="paste-dialog url-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="url-title"
		>
			<header>
				<div>
					<p class="eyebrow">Quick import</p>
					<h2 id="url-title">Read a web page</h2>
				</div>
				<button
					class="icon-button"
					type="button"
					aria-label="Close"
					onclick={() => (libraryAdd.urlOpen = false)}
				>
					<Icon icon={X} size={18} />
				</button>
			</header>
			<label class="form-field">
				<span>Web address</span>
				<input
					type="url"
					bind:value={urlValue}
					placeholder="https://en.wikipedia.org/wiki/…"
					disabled={urlBusy}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							void saveUrl();
						}
					}}
				/>
			</label>
			<p class="url-hint">
				Articles and reference pages work best — equations and pictures come along. Pages that
				refuse direct access are fetched through a public relay.
			</p>
			{#if urlError}
				<p class="url-error" role="alert">{urlError}</p>
			{/if}
			<footer>
				<small aria-live="polite">{urlBusy ? appState.statusMessage : ''}</small>
				<div>
					<button class="button ghost" type="button" onclick={() => (libraryAdd.urlOpen = false)}
						>Cancel</button
					>
					<button
						class="button primary"
						type="button"
						disabled={!urlValue.trim() || urlBusy}
						onclick={saveUrl}
					>
						{urlBusy ? 'Adding…' : 'Add to library'}
					</button>
				</div>
			</footer>
		</div>
	</div>
{/if}

{#if appState.duplicate}
	<div class="modal-scrim" role="presentation">
		<div class="duplicate-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
			<span class="duplicate-icon"><Icon icon={BookOpenText} size={22} /></span>
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

<style>
	.visually-hidden-input {
		position: absolute;
		width: 1px !important;
		height: 1px !important;
		padding: 0 !important;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
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

	.url-dialog .url-hint {
		margin: -8px 0 0;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.5;
	}

	.url-dialog .url-error {
		margin: -6px 0 0;
		color: var(--danger, #e5484d);
		font-size: 11px;
		line-height: 1.5;
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
</style>
