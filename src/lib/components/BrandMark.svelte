<script lang="ts">
	let { active = false, size = 25 }: { active?: boolean; size?: number } = $props();
</script>

<svg
	class:active
	class="brand-logo"
	width={size}
	height={size * 0.902}
	viewBox="0 0 160 144.27"
	aria-hidden="true"
	focusable="false"
>
	<path
		class="headphones"
		d="M116.87,20.15c-21.16-15.06-50.02-15.44-71.72-1.35-15.19,9.86-25.13,25.82-27.3,43.85l2.46.08c3.73.12,7.86,2.76,7.86,6.91v35.65c0,3.9-3.7,6.91-7.28,6.91h-6.2C6.36,111.76-.07,104.97,0,96.63l.03-18.36c0-5.93,3.81-11.01,9.33-13.22,1.19-20.54,11.85-39.39,28.39-51.51C61.19-3.25,92.75-4.55,117.48,10.33c5.12,3.08,9.65,6.82,13.89,11.04,11.4,12.16,18.22,26.84,19.21,43.6,5.29,2.2,9.12,6.94,9.33,12.71l.08,20.16c-.61,7.99-7.02,14.07-15.01,14.36h-5.76c-3.91-.01-7.37-3.23-7.37-7.34l.02-34.81c0-4.22,3.56-7.21,7.51-7.34l2.7-.09c-1.93-17.19-11.19-32.49-25.23-42.48Z"
	/>
	<path
		class="paper"
		d="M123.72,68.88l.02,62.8c0,6.55-5.76,12.48-12.36,12.49l-62.49.1c-6.36-.52-11.44-5.42-12.24-11.76l.11-82.91c.01-8.03,7.37-13.59,14.99-13.58l37.13.07c3.35,0,6.33.72,8.78,3.16l23.09,23.06c1.58,1.58,2.97,4.13,2.97,6.58ZM116.72,131.59l-.03-61.74c0-2.22-1.99-4.16-4.03-4.17l-10.58-.05c-4.67-.02-8.89-3.36-9.2-8.19l-.1-11.69c-.01-1.36-.98-2.4-2.47-2.4l-39.14-.04c-3.93,0-7.51,2.82-7.52,6.95l-.07,43.87.03,12.62-.03,23.72c0,3.12,2.34,6.46,5.73,6.46l61.62.03c3.02,0,5.35-2.41,5.78-5.38Z"
	/>
	<g class="waveform">
		<path
			class="wave-bar"
			d="M83.31,120.22c0,1.74-1.4,2.73-2.77,2.76-1.28.02-2.85-.92-2.85-2.49v-46.69c0-1.68,1.5-2.66,2.85-2.63,1.65.03,2.78,1.22,2.78,3.02v46.03Z"
		/>
		<path
			class="wave-bar"
			d="M92.44,112.15c0,1.55-1.28,2.48-2.45,2.6s-2.95-.71-2.95-2.21v-30.18c0-1.4,1.67-2.25,2.77-2.19,1.25.06,2.63,1.06,2.63,2.54v29.45Z"
		/>
		<path
			class="wave-bar"
			d="M74.1,112.16c0,1.53-1.31,2.45-2.48,2.58s-2.94-.53-2.94-2.03v-30.45c0-1.46,1.85-2.19,2.94-2.07,1.19.13,2.48,1.08,2.48,2.5v29.47Z"
		/>
		<path
			class="wave-bar"
			d="M101.44,105.81c0,1.85-1.14,3.01-2.75,3s-2.76-1.16-2.76-2.91l-.02-15.86c0-1.76,1.15-2.91,2.77-2.9s2.74,1.18,2.74,2.9v15.76Z"
		/>
		<path
			class="wave-bar"
			d="M65.11,105.6c0,1.68-.77,2.82-2.19,3.14-1.25.28-3.2-.41-3.2-2.05l-.04-17.27c0-1.63,1.78-2.44,3.07-2.25,1.56.22,2.34,1.45,2.34,3.08l.02,15.35Z"
		/>
		<path
			class="wave-bar"
			d="M110.03,100.82c0,1.56-1.17,2.56-2.47,2.65s-2.77-.72-2.78-2.2l-.03-5.6c0-1.53,1.43-2.51,2.78-2.44,1.47.08,2.51,1.25,2.51,2.81l-.02,4.79Z"
		/>
		<path
			class="wave-bar"
			d="M56.28,101.09c0,1.68-1.56,2.51-2.96,2.38s-2.37-1.33-2.34-2.91l.08-5.14c.02-1.35,1.46-2.22,2.66-2.19s2.55.99,2.55,2.37v5.49Z"
		/>
	</g>
</svg>

<style>
	.brand-logo {
		display: block;
		overflow: visible;
	}

	.headphones,
	.paper,
	.wave-bar {
		transition: fill 220ms var(--ease);
	}

	.headphones {
		fill: var(--brand-headphones, var(--primary));
	}

	.paper {
		fill: var(--brand-paper, var(--text-soft));
	}

	.wave-bar {
		fill: var(--brand-wave, var(--primary));
		transform-box: fill-box;
		transform-origin: center;
	}

	.active .wave-bar {
		animation: voice-pulse 720ms var(--ease) infinite alternate;
	}

	.active .wave-bar:nth-child(2),
	.active .wave-bar:nth-child(6) {
		animation-delay: -480ms;
	}

	.active .wave-bar:nth-child(3),
	.active .wave-bar:nth-child(5) {
		animation-delay: -240ms;
	}

	.active .wave-bar:nth-child(4) {
		animation-delay: -600ms;
	}

	@keyframes voice-pulse {
		from {
			transform: scaleY(0.68);
		}
		to {
			transform: scaleY(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.headphones,
		.paper,
		.wave-bar {
			transition: none;
		}

		.active .wave-bar {
			animation: none;
		}
	}
</style>
