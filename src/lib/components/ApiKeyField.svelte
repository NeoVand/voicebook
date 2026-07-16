<script lang="ts">
	import { ArrowUpRight, Check, KeyRound, LoaderCircle, Trash2, X } from '@lucide/svelte';

	interface Props {
		/** "Anthropic API key" */
		label: string;
		placeholder: string;
		/** Console page where the user can create a key. */
		keyUrl: string;
		hasKey: boolean;
		/** True when the effective key was injected from the local dev .env. */
		isDevKey?: boolean;
		onSave: (value: string) => void | Promise<void>;
		onClear: () => void | Promise<void>;
		onTest?: () => Promise<{ ok: boolean; message: string }>;
	}

	let {
		label,
		placeholder,
		keyUrl,
		hasKey,
		isDevKey = false,
		onSave,
		onClear,
		onTest
	}: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let testing = $state(false);
	let status = $state<{ ok: boolean; message: string } | null>(null);

	async function save(): Promise<void> {
		const value = draft.trim();
		if (!value) return;
		await onSave(value);
		draft = '';
		editing = false;
		status = null;
	}

	async function clear(): Promise<void> {
		await onClear();
		draft = '';
		editing = false;
		status = null;
	}

	async function test(): Promise<void> {
		if (!onTest || testing) return;
		testing = true;
		status = null;
		try {
			status = await onTest();
		} finally {
			testing = false;
		}
	}
</script>

<div class="key-field">
	<div class="key-field-head">
		<span class="key-field-label"><KeyRound size={13} /> {label}</span>
		<a href={keyUrl} target="_blank" rel="external noreferrer"
			>Get a key <ArrowUpRight size={11} /></a
		>
	</div>
	{#if hasKey && !editing}
		<div class="key-field-saved">
			<span class="key-field-mask">••••••••••••</span>
			{#if isDevKey}<span class="key-field-dev" title="Loaded from the local .env in dev mode"
					>dev key</span
				>{/if}
			<span class="key-field-actions">
				{#if onTest}
					<button class="key-button" type="button" disabled={testing} onclick={() => void test()}>
						{#if testing}<LoaderCircle class="spin" size={12} />{:else}Test{/if}
					</button>
				{/if}
				<button class="key-button" type="button" onclick={() => (editing = true)}>Replace</button>
				{#if !isDevKey}
					<button
						class="key-button danger"
						type="button"
						aria-label={`Remove ${label}`}
						onclick={() => void clear()}
					>
						<Trash2 size={12} />
					</button>
				{/if}
			</span>
		</div>
	{:else}
		<div class="key-field-entry">
			<input
				type="password"
				autocomplete="off"
				spellcheck="false"
				{placeholder}
				aria-label={label}
				bind:value={draft}
				onkeydown={(event) => {
					if (event.key === 'Enter') void save();
					else if (event.key === 'Escape' && hasKey) editing = false;
				}}
			/>
			<button
				class="key-button primary"
				type="button"
				disabled={!draft.trim()}
				onclick={() => void save()}
			>
				<Check size={12} /> Save
			</button>
			{#if hasKey}
				<button class="key-button" type="button" onclick={() => (editing = false)}>
					<X size={12} />
				</button>
			{/if}
		</div>
	{/if}
	{#if status}
		<p class="key-field-status" class:ok={status.ok} role="status">{status.message}</p>
	{/if}
	<p class="key-field-note">Stored only in this browser and sent only to {label.split(' ')[0]}.</p>
</div>

<style>
	.key-field {
		display: grid;
		gap: 6px;
	}

	.key-field-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.key-field-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 640;
	}

	.key-field-head a {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--primary);
		font-size: 9px;
		font-weight: 600;
		text-decoration: none;
	}

	.key-field-head a:hover {
		text-decoration: underline;
	}

	.key-field-saved {
		display: flex;
		min-height: 34px;
		align-items: center;
		gap: 8px;
		padding: 0 4px 0 10px;
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		background: var(--control);
	}

	.key-field-mask {
		color: var(--muted);
		font-size: 11px;
		letter-spacing: 0.12em;
	}

	.key-field-dev {
		padding: 2px 7px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--bookmark, #c99a3c) 16%, transparent);
		color: var(--bookmark, #c99a3c);
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.key-field-actions {
		display: inline-flex;
		margin-left: auto;
		gap: 3px;
	}

	.key-field-entry {
		display: flex;
		gap: 6px;
	}

	.key-field-entry input {
		min-width: 0;
		height: 34px;
		padding: 0 11px;
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		background: var(--control);
		color: var(--text);
		flex: 1;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10px;
	}

	.key-field-entry input:focus-visible {
		border-color: var(--primary);
		outline: none;
	}

	.key-button {
		display: inline-flex;
		min-height: 28px;
		align-items: center;
		gap: 4px;
		padding: 0 10px;
		border: 1px solid var(--line-strong);
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-size: 9.5px;
		font-weight: 620;
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease);
	}

	.key-button:hover:not(:disabled) {
		background: var(--hover);
		color: var(--text);
	}

	.key-button:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.key-button.primary {
		border-color: transparent;
		background: var(--primary);
		color: var(--primary-ink, #fff);
	}

	.key-button.danger:hover {
		background: var(--danger-surface);
		color: var(--danger-text);
	}

	.key-field-status {
		margin: 0;
		color: var(--danger-text, #d66);
		font-size: 9px;
	}

	.key-field-status.ok {
		color: var(--success, #7dbb8f);
	}

	.key-field-note {
		margin: 0;
		color: var(--faint);
		font-size: 8.5px;
	}

	.key-field :global(.spin) {
		animation: key-spin 800ms linear infinite;
	}

	@keyframes key-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.key-field :global(.spin) {
			animation: none;
		}
	}
</style>
