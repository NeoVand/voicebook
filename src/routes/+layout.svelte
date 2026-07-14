<script lang="ts">
	import '@fontsource-variable/inter/index.css';
	import '@fontsource-variable/newsreader/index.css';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		BookOpenText,
		Cpu,
		HardDrive,
		Library,
		PanelLeftClose,
		PanelLeftOpen,
		Settings2,
		ShieldCheck,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { appState } from '$lib/state/app-state.svelte';
	import './layout.css';

	let { children } = $props();

	const homeHref = resolve('/');
	const settingsHref = resolve('/settings');
	const sidebarStorageKey = 'voicebook:sidebar-collapsed';
	let sidebarCollapsed = $state(
		browser && window.localStorage.getItem(sidebarStorageKey) === 'true'
	);
	let isReader = $derived(page.url.pathname.startsWith(resolve('/read')));
	let settingsSection = $derived(page.url.searchParams.get('section') ?? 'models');

	onMount(() => {
		void appState.initialize();
	});

	function toggleSidebar(): void {
		sidebarCollapsed = !sidebarCollapsed;
		window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed));
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Voicebook — local document listening</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<div class="app-shell" class:sidebar-collapsed={sidebarCollapsed}>
	<aside class="app-sidebar" aria-label="Voicebook navigation">
		<a class="brand" href={homeHref} aria-label="Voicebook library">
			<span class="brand-mark" aria-hidden="true"><BookOpenText size={18} strokeWidth={1.8} /></span
			>
			<span>Voicebook</span>
		</a>

		<nav id="primary-navigation" class="primary-nav" aria-label="Primary navigation">
			<a
				class:active={page.url.pathname === homeHref}
				href={homeHref}
				aria-label="Library"
				aria-current={page.url.pathname === homeHref ? 'page' : undefined}
				title={sidebarCollapsed ? 'Library' : undefined}
			>
				<Library size={17} />
				<span>Library</span>
			</a>
			<a
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'models'}
				href={settingsHref}
				aria-label="Voice"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'models'
					? 'page'
					: undefined}
				title={sidebarCollapsed ? 'Voice' : undefined}
			>
				<Cpu size={17} />
				<span>Voice</span>
			</a>
			<a
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'storage'}
				href={resolve('/settings?section=storage')}
				aria-label="Storage"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'storage'
					? 'page'
					: undefined}
				title={sidebarCollapsed ? 'Storage' : undefined}
			>
				<HardDrive size={17} />
				<span>Storage</span>
			</a>
			<a
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'system'}
				href={resolve('/settings?section=system')}
				aria-label="System"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'system'
					? 'page'
					: undefined}
				title={sidebarCollapsed ? 'System' : undefined}
			>
				<Settings2 size={17} />
				<span>System</span>
			</a>
		</nav>

		<button
			class="sidebar-toggle"
			type="button"
			aria-controls="primary-navigation"
			aria-expanded={!sidebarCollapsed}
			aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			onclick={toggleSidebar}
		>
			{#if sidebarCollapsed}
				<PanelLeftOpen size={17} />
				<span>Expand sidebar</span>
			{:else}
				<PanelLeftClose size={17} />
				<span>Collapse sidebar</span>
			{/if}
		</button>

		<div class="sidebar-foot">
			<span class="status-dot" aria-hidden="true"></span>
			<div>
				<strong>Local only</strong>
				<small>{appState.capabilities.webgpu ? 'WebGPU available' : 'Compatibility mode'}</small>
			</div>
			<ShieldCheck size={15} />
		</div>
	</aside>

	<div class="shell-content" class:reader-mode={isReader}>
		<main id="main-content">
			{@render children()}
		</main>
	</div>
</div>

{#if appState.errorMessage}
	<div class="toast error-toast" role="alert">
		<div>
			<strong>Something needs attention</strong>
			<p>{appState.errorMessage}</p>
		</div>
		<button
			class="icon-button"
			type="button"
			aria-label="Dismiss error"
			onclick={() => appState.clearError()}
		>
			<X size={17} />
		</button>
	</div>
{/if}
