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
		Code2,
		Cpu,
		Download,
		Ellipsis,
		HardDrive,
		Library,
		List,
		ListMusic,
		PanelLeftClose,
		PanelLeftOpen,
		Settings2,
		ShieldCheck,
		Square,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import { segmentBlocks } from '$lib/domain/segmenter';
	import { appState } from '$lib/state/app-state.svelte';
	import { player } from '$lib/state/player.svelte';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';
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
	let readerDocumentId = $derived(page.url.searchParams.get('document'));
	let readerBook = $derived(
		isReader ? appState.documents.find((document) => document.id === readerDocumentId) : undefined
	);
	let currentBookmarked = $derived(
		Boolean(
			readerBook?.bookmarks.some((bookmark) => bookmark.segmentId === player.currentSegment?.id)
		)
	);
	let readerEngineInstalled = $derived(appState.installedModels.includes('supertonic-3'));

	onMount(() => {
		void appState.initialize();
	});

	function toggleSidebar(): void {
		sidebarCollapsed = !sidebarCollapsed;
		window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed));
	}

	async function toggleReaderCodeSpeech(): Promise<void> {
		if (!readerBook) return;
		readerBook.includeCode = !readerBook.includeCode;
		readerBook.segments = segmentBlocks(readerBook.blocks, readerBook.includeCode);
		player.setDocument(readerBook);
		await appState.saveDocument(readerBook);
		readerChrome.menuOpen = false;
	}

	function toggleWholeDocumentGeneration(): void {
		if (player.isGeneratingAll) player.cancelGeneration();
		else void player.generateAll();
		readerChrome.menuOpen = false;
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Voicebook — local document listening</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<header class="app-header" aria-label="Voicebook header">
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
			<div class="reader-commandbar-left">
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
			</div>

			<div class="reader-commandbar-title">
				<strong>{readerBook.title}</strong>
				<span>{readerBook.sourceKind.toUpperCase()} · {readerBook.segments.length} passages</span>
			</div>

			<div class="reader-commandbar-actions">
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
				<div class="reader-menu-wrap">
					<button
						class="icon-button"
						class:active={readerChrome.menuOpen}
						type="button"
						aria-label="Reading options"
						aria-expanded={readerChrome.menuOpen}
						title="Reading options"
						onclick={() => (readerChrome.menuOpen = !readerChrome.menuOpen)}
					>
						<Ellipsis size={18} />
					</button>
					{#if readerChrome.menuOpen}
						<div class="reader-menu" role="menu">
							{#if readerBook.blocks.some((block) => block.kind === 'code')}
								<button type="button" role="menuitem" onclick={toggleReaderCodeSpeech}>
									<Code2 size={16} />
									<span>
										<strong>{readerBook.includeCode ? 'Skip code' : 'Read code'}</strong>
										<small>Code always remains visible.</small>
									</span>
								</button>
							{/if}
							<button
								type="button"
								role="menuitem"
								disabled={!player.isGeneratingAll && !readerEngineInstalled}
								onclick={toggleWholeDocumentGeneration}
							>
								{#if player.isGeneratingAll}
									<Square size={15} fill="currentColor" />
								{:else}
									<Download size={16} />
								{/if}
								<span>
									<strong
										>{player.isGeneratingAll ? 'Stop preparing' : 'Prepare whole document'}</strong
									>
									<small>
										{player.isGeneratingAll
											? Math.round(player.generationProgress) + '% complete'
											: 'Cache every passage for offline replay.'}
									</small>
								</span>
							</button>
						</div>
					{/if}
				</div>
			</div>
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

		<nav id="primary-navigation" class="primary-nav" aria-label="Primary navigation">
			<a
				class:active={page.url.pathname === homeHref}
				href={homeHref}
				aria-label="Library"
				aria-current={page.url.pathname === homeHref ? 'page' : undefined}
				title={sidebarCollapsed ? 'Library' : undefined}
				onclick={() => readerChrome.closeTransientPanels()}
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
				onclick={() => readerChrome.closeTransientPanels()}
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
				onclick={() => readerChrome.closeTransientPanels()}
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
