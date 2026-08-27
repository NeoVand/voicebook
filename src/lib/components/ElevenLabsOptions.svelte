<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { RotateCcw } from '$lib/icons';
	import {
		ELEVENLABS_V3_STABILITY,
		isDefaultElevenLabsOptions,
		type ElevenLabsModelSpec,
		type ElevenLabsVoiceOptions
	} from '$lib/domain/provider-catalog';

	interface Props {
		model: ElevenLabsModelSpec;
		options: ElevenLabsVoiceOptions;
		onChange: (patch: Partial<ElevenLabsVoiceOptions>) => void | Promise<void>;
		onReset: () => void | Promise<void>;
	}

	let { model, options, onChange, onReset }: Props = $props();

	let customized = $derived(!isDefaultElevenLabsOptions(options));

	function number(event: Event): number {
		return Number((event.currentTarget as HTMLInputElement).value);
	}
</script>

<div class="el-options">
	<header>
		<div>
			<strong>{model.label} settings</strong>
			<small>
				{customized
					? 'Changing these re-generates audio the next time you play.'
					: "Untouched — each voice's own saved settings apply."}
			</small>
		</div>
		{#if customized}
			<button type="button" class="el-reset" onclick={() => void onReset()}>
				<Icon icon={RotateCcw} size={11} aria-hidden="true" /> Reset
			</button>
		{/if}
	</header>

	{#if model.options.stability === 'discrete'}
		<div class="el-field">
			<span class="el-label">Stability</span>
			<div class="el-choices" role="group" aria-label="Stability">
				{#each ELEVENLABS_V3_STABILITY as point (point.value)}
					<button
						type="button"
						class="el-choice"
						class:selected={options.stability === point.value}
						aria-pressed={options.stability === point.value}
						onclick={() => void onChange({ stability: point.value })}
					>
						<strong>{point.label}</strong>
						<small>{point.tagline}</small>
					</button>
				{/each}
			</div>
		</div>
	{:else}
		<label class="el-field">
			<span class="el-label">
				Stability <em>{options.stability.toFixed(2)}</em>
			</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={options.stability}
				oninput={(event) => void onChange({ stability: number(event) })}
			/>
			<small>Low wanders and emotes; high stays flat and predictable.</small>
		</label>
	{/if}

	{#if model.options.similarity}
		<label class="el-field">
			<span class="el-label">
				Similarity <em>{options.similarity.toFixed(2)}</em>
			</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={options.similarity}
				oninput={(event) => void onChange({ similarity: number(event) })}
			/>
			<small>How closely the read tracks the original voice recording.</small>
		</label>
	{/if}

	{#if model.options.style}
		<label class="el-field">
			<span class="el-label">
				Style exaggeration <em>{options.style.toFixed(2)}</em>
			</span>
			<input
				type="range"
				min="0"
				max="1"
				step="0.05"
				value={options.style}
				oninput={(event) => void onChange({ style: number(event) })}
			/>
			<small>Amplifies the voice's own delivery. Above zero costs latency.</small>
		</label>
	{/if}

	{#if model.options.speed}
		<label class="el-field">
			<span class="el-label">
				Speed <em>{options.speed.toFixed(2)}×</em>
			</span>
			<input
				type="range"
				min="0.7"
				max="1.2"
				step="0.05"
				value={options.speed}
				oninput={(event) => void onChange({ speed: number(event) })}
			/>
			<small>Baked into the audio. The player's own speed control still applies on top.</small>
		</label>
	{/if}

	{#if model.options.speakerBoost}
		<div class="el-field el-row">
			<div>
				<span class="el-label">Speaker boost</span>
				<small>Sharpens resemblance to the voice, at a little latency.</small>
			</div>
			<label class="el-check">
				<input
					type="checkbox"
					checked={options.speakerBoost}
					onchange={(event) =>
						void onChange({ speakerBoost: (event.currentTarget as HTMLInputElement).checked })}
				/>
				<span>{options.speakerBoost ? 'On' : 'Off'}</span>
			</label>
		</div>
	{/if}
</div>

<style>
	.el-options {
		display: grid;
		gap: 12px;
		padding: 12px 13px 13px;
		border: 1px solid var(--line);
		border-radius: 8px;
	}

	.el-options header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}

	.el-options header strong {
		display: block;
		font-size: 10px;
		font-weight: 650;
	}

	.el-options header small {
		display: block;
		margin-top: 2px;
		color: var(--faint);
		font-size: 9px;
	}

	.el-reset {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		font-size: 9px;
	}

	.el-reset:hover {
		color: var(--text);
	}

	.el-field {
		display: grid;
		gap: 5px;
	}

	.el-field small {
		color: var(--faint);
		font-size: 8.5px;
	}

	.el-label {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		color: var(--muted);
		font-size: 9.5px;
		font-weight: 600;
	}

	.el-label em {
		color: var(--text);
		font-style: normal;
		font-variant-numeric: tabular-nums;
	}

	.el-field input[type='range'] {
		width: 100%;
		accent-color: var(--primary);
	}

	.el-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.el-check {
		display: flex;
		flex: none;
		align-items: center;
		gap: 9px;
		min-height: 44px;
		color: var(--text-soft);
		font-size: 9px;
		font-weight: 600;
	}

	.el-check input {
		flex: 0 0 auto;
		accent-color: var(--primary);
	}

	.el-choices {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 6px;
	}

	.el-choice {
		padding: 8px 10px;
		border: 1px solid var(--line-strong);
		border-radius: 7px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		text-align: left;
		transition:
			border-color 150ms var(--ease),
			color 150ms var(--ease);
	}

	.el-choice:hover {
		color: var(--text);
	}

	.el-choice.selected {
		border-color: color-mix(in srgb, var(--primary) 60%, var(--line-strong));
		background: color-mix(in srgb, var(--primary) 7%, transparent);
		color: var(--text);
	}

	.el-choice strong {
		display: block;
		font-size: 10px;
		font-weight: 650;
	}

	.el-choice small {
		display: block;
		margin-top: 2px;
		color: var(--faint);
		font-size: 8.5px;
	}
</style>
