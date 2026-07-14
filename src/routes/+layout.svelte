<script lang="ts">
	import '@fontsource-variable/inter/index.css';
	import '@fontsource-variable/newsreader/index.css';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import {
		ArrowLeft,
		Bookmark,
		BookOpenText,
		Cpu,
		FileText,
		HardDrive,
		Library,
		List,
		ListMusic,
		Moon,
		PanelLeftClose,
		PanelLeftOpen,
		Settings2,
		ShieldCheck,
		Sun,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { appState } from '$lib/state/app-state.svelte';
	import { player } from '$lib/state/player.svelte';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';
	import './layout.css';

	let { children } = $props();

	const homeHref = resolve('/');
	const settingsHref = resolve('/settings');
	const sidebarStorageKey = 'voicebook:sidebar-collapsed';
	const themeStorageKey = 'voicebook:theme';
	let sidebarCollapsed = $state(
		browser && window.localStorage.getItem(sidebarStorageKey) === 'true'
	);
	let theme = $state<'dark' | 'light'>(
		browser && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
	);
	let isReader = $derived(page.url.pathname.startsWith(resolve('/read')));
	let settingsSection = $derived(page.url.searchParams.get('section') ?? 'models');
	let readerDocumentId = $derived(page.url.searchParams.get('document'));
	let readerBook = $derived(
		isReader ? appState.documents.find((document) => document.id === readerDocumentId) : undefined
	);
	let currentBookmarked = $derived(
		Boolean(
			readerBook?.bookmarks.some((bookmark) => bookmark.segmentId === player.currentSegment?.id)
		)
	);

	onMount(() => {
		void appState.initialize();
	});

	function toggleSidebar(): void {
		sidebarCollapsed = !sidebarCollapsed;
		window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed));
	}

	function toggleTheme(): void {
		theme = theme === 'dark' ? 'light' : 'dark';
		document.documentElement.dataset.theme = theme;
		window.localStorage.setItem(themeStorageKey, theme);
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', theme === 'dark' ? '#0b0c0f' : '#f4f3ef');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Voicebook — local document listening</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<header class="app-header" class:sidebar-collapsed={sidebarCollapsed} aria-label="Voicebook header">
	<div class="app-brand-slot">
		<a
			class="brand"
			href={homeHref}
			aria-label="Voicebook library"
			onclick={() => readerChrome.closeTransientPanels()}
		>
			<span class="brand-mark" aria-hidden="true"><BookOpenText size={18} strokeWidth={1.8} /></span
			>
			<span>Voicebook</span>
		</a>
	</div>

	{#if isReader && readerBook}
		<div class="reader-commandbar">
			<div class="reader-commandbar-title">
				<strong>{readerBook.title}</strong>
				<span>{readerBook.sourceKind.toUpperCase()} · {readerBook.segments.length} passages</span>
			</div>

			<div class="reader-commandbar-actions">
				<a
					class="icon-button"
					href={homeHref}
					aria-label="Back to library"
					title="Back to library"
					onclick={() => readerChrome.closeTransientPanels()}
				>
					<ArrowLeft size={17} />
				</a>
				<button
					class="icon-button"
					class:active={readerChrome.outlineOpen}
					type="button"
					aria-label={readerChrome.outlineOpen ? 'Close document outline' : 'Open document outline'}
					aria-controls="document-outline"
					aria-expanded={readerChrome.outlineOpen}
					title={readerChrome.outlineOpen ? 'Close contents' : 'Open contents'}
					onclick={() => (readerChrome.outlineOpen = !readerChrome.outlineOpen)}
				>
					<List size={17} />
				</button>
				<button
					class="icon-button"
					class:marked={currentBookmarked}
					type="button"
					aria-label={currentBookmarked ? 'Remove bookmark' : 'Add bookmark'}
					title={currentBookmarked ? 'Remove bookmark' : 'Add bookmark'}
					onclick={() => player.toggleBookmark()}
				>
					<Bookmark size={16} fill={currentBookmarked ? 'currentColor' : 'none'} />
				</button>
				<button
					class="icon-button"
					class:active={readerChrome.bookmarksOpen}
					type="button"
					aria-label={readerChrome.bookmarksOpen ? 'Close bookmarks' : 'Open bookmarks'}
					title={readerChrome.bookmarksOpen ? 'Close bookmarks' : 'Open bookmarks'}
					onclick={() => (readerChrome.bookmarksOpen = !readerChrome.bookmarksOpen)}
				>
					<ListMusic size={16} />
				</button>
				<span class="commandbar-divider" aria-hidden="true"></span>
				<button
					class="icon-button"
					type="button"
					aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
					title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
					onclick={toggleTheme}
				>
					{#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
				</button>
			</div>
		</div>
	{:else}
		<div class="global-commandbar">
			<button
				class="icon-button"
				type="button"
				aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
				onclick={toggleTheme}
			>
				{#if theme === 'dark'}<Sun size={16} />{:else}<Moon size={16} />{/if}
			</button>
		</div>
	{/if}
</header>

<div class="app-shell" class:sidebar-collapsed={sidebarCollapsed}>
	<aside class="app-sidebar" aria-label="Voicebook navigation">
		<div class="sidebar-head">
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
				{:else}
					<PanelLeftClose size={17} />
				{/if}
			</button>
		</div>

		<div class="sidebar-main">
			<div class="library-nav-group">
				<nav id="primary-navigation" class="primary-nav" aria-label="Primary navigation">
					<a
						class="nav-link"
						class:active={page.url.pathname === homeHref}
						href={homeHref}
						aria-label="Library"
						aria-current={page.url.pathname === homeHref ? 'page' : undefined}
						data-tooltip={appState.documents.length ? undefined : 'Library'}
						onclick={() => readerChrome.closeTransientPanels()}
					>
						<Library size={17} />
						<span>Library</span>
					</a>
				</nav>

				{#if sidebarCollapsed && appState.documents.length}
					<div class="library-flyout" aria-label="Recent documents">
						<strong>Recent documents</strong>
						{#each appState.documents.slice(0, 7) as document (document.id)}
							<a
								class:active={readerDocumentId === document.id}
								href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
								onclick={() => readerChrome.closeTransientPanels()}
							>
								<FileText size={14} />
								<span>{document.title}</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>

			{#if !sidebarCollapsed}
				<div class="sidebar-documents">
					<span class="sidebar-section-label">Recent</span>
					{#if appState.documents.length}
						<nav aria-label="Recent documents">
							{#each appState.documents as document (document.id)}
								<a
									class:active={readerDocumentId === document.id}
									href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
									title={document.title}
									onclick={() => readerChrome.closeTransientPanels()}
								>
									<FileText size={13} />
									<span>{document.title}</span>
								</a>
							{/each}
						</nav>
					{:else}
						<p>No documents yet</p>
					{/if}
				</div>
			{/if}
		</div>

		<nav class="utility-nav" aria-label="Voicebook settings">
			<a
				class="nav-link"
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'models'}
				href={settingsHref}
				aria-label="Voice"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'models'
					? 'page'
					: undefined}
				data-tooltip="Voice"
				onclick={() => readerChrome.closeTransientPanels()}
			>
				<Cpu size={17} />
				<span>Voice</span>
			</a>
			<a
				class="nav-link"
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'storage'}
				href={resolve('/settings?section=storage')}
				aria-label="Storage"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'storage'
					? 'page'
					: undefined}
				data-tooltip="Storage"
				onclick={() => readerChrome.closeTransientPanels()}
			>
				<HardDrive size={17} />
				<span>Storage</span>
			</a>
			<a
				class="nav-link"
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'system'}
				href={resolve('/settings?section=system')}
				aria-label="System"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'system'
					? 'page'
					: undefined}
				data-tooltip="System"
				onclick={() => readerChrome.closeTransientPanels()}
			>
				<Settings2 size={17} />
				<span>System</span>
			</a>
		</nav>

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
