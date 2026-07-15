<script lang="ts">
	import '@fontsource-variable/instrument-sans/index.css';
	import '@fontsource-variable/newsreader/index.css';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { base, resolve } from '$app/paths';
	import {
		Bookmark,
		CloudRain,
		CloudSun,
		Cpu,
		HardDrive,
		Library,
		List,
		ListMusic,
		Maximize2,
		Menu,
		Minimize2,
		Moon,
		PanelLeftClose,
		PanelLeftOpen,
		RefreshCw,
		Settings2,
		Sun,
		ZoomIn,
		ZoomOut,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import DocumentKindIcon from '$lib/components/DocumentKindIcon.svelte';
	import GitHubOutline from '$lib/components/GitHubOutline.svelte';
	import { recordRuntimeEvent } from '$lib/services/runtime-diagnostics';
	import { appState } from '$lib/state/app-state.svelte';
	import { player } from '$lib/state/player.svelte';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';
	import './layout.css';

	let { children } = $props();

	const homeHref = resolve('/');
	const settingsHref = resolve('/settings');
	const repositoryHref = 'https://github.com/NeoVand/voicebook';
	const sidebarStorageKey = 'voicebook:sidebar-collapsed';
	const themeStorageKey = 'voicebook:theme';
	type ThemeId = 'sunny' | 'cloudy' | 'rainy' | 'midnight';
	const themes: readonly ThemeId[] = ['sunny', 'cloudy', 'rainy', 'midnight'];
	const themeLabels: Record<ThemeId, string> = {
		sunny: 'Sunny',
		cloudy: 'Cloudy',
		rainy: 'Rainy',
		midnight: 'Midnight'
	};
	const themeColors: Record<ThemeId, string> = {
		sunny: '#f4efe6',
		cloudy: '#edf1f3',
		rainy: '#101820',
		midnight: '#0b0c0f'
	};
	function normalizeTheme(value: string | undefined): ThemeId {
		if (value === 'light') return 'cloudy';
		if (value === 'dark') return 'midnight';
		return themes.includes(value as ThemeId) ? (value as ThemeId) : 'midnight';
	}
	let sidebarCollapsed = $state(
		browser && window.localStorage.getItem(sidebarStorageKey) === 'true'
	);
	let mobileSidebarOpen = $state(false);
	let theme = $state<ThemeId>(
		normalizeTheme(browser ? document.documentElement.dataset.theme : undefined)
	);
	let fullscreenElement = $state<Element | null>(null);
	let waitingServiceWorker = $state<ServiceWorker | null>(null);
	let updateAvailable = $state(false);
	let updateDismissed = $state(false);
	let applyingUpdate = $state(false);
	let isFullscreen = $derived(Boolean(fullscreenElement));
	let runtimeBusy = $derived(
		Object.values(appState.modelProgress).some((progress) => progress.status === 'loading') ||
			player.isBuffering ||
			player.isPlaying ||
			player.isGeneratingAll
	);
	let nextTheme = $derived(themes[(themes.indexOf(theme) + 1) % themes.length]);
	let isReader = $derived(page.url.pathname.startsWith(resolve('/read')));
	let settingsSection = $derived(page.url.searchParams.get('section') ?? 'models');
	let readerDocumentId = $derived(page.url.searchParams.get('document'));
	let activeReaderDocumentId = $derived(isReader ? readerDocumentId : null);
	let readerBook = $derived(
		isReader ? appState.documents.find((document) => document.id === readerDocumentId) : undefined
	);
	let currentBookmarked = $derived(
		Boolean(
			readerBook?.bookmarks.some((bookmark) => bookmark.segmentId === player.currentSegment?.id)
		)
	);

	onMount(() => {
		readerChrome.hydratePreferences();
		void appState.initialize();
		const onWindowError = (event: ErrorEvent) =>
			recordRuntimeEvent('window-error', event.message || 'unknown window error');
		const onUnhandledRejection = (event: PromiseRejectionEvent) =>
			recordRuntimeEvent(
				'unhandled-rejection',
				event.reason instanceof Error ? event.reason.message : String(event.reason)
			);
		window.addEventListener('error', onWindowError);
		window.addEventListener('unhandledrejection', onUnhandledRejection);

		if (!('serviceWorker' in navigator))
			return () => {
				window.removeEventListener('error', onWindowError);
				window.removeEventListener('unhandledrejection', onUnhandledRejection);
			};
		let registration: ServiceWorkerRegistration | undefined;
		let installingWorker: ServiceWorker | null = null;
		let checkingForUpdate = false;
		const showWaitingUpdate = (worker: ServiceWorker | null | undefined) => {
			if (!worker || !navigator.serviceWorker.controller) return;
			waitingServiceWorker = worker;
			updateAvailable = true;
			updateDismissed = false;
		};
		const onInstallingStateChange = () => {
			if (installingWorker?.state === 'installed')
				showWaitingUpdate(registration?.waiting ?? installingWorker);
		};
		const onUpdateFound = () => {
			installingWorker?.removeEventListener('statechange', onInstallingStateChange);
			installingWorker = registration?.installing ?? null;
			installingWorker?.addEventListener('statechange', onInstallingStateChange);
		};
		const checkForUpdate = () => {
			if (checkingForUpdate || runtimeBusy || document.visibilityState !== 'visible') return;
			checkingForUpdate = true;
			void (async () => {
				registration ??= await navigator.serviceWorker.getRegistration(base || '/');
				if (!registration) {
					registration = await navigator.serviceWorker.register(`${base}/service-worker.js`, {
						scope: `${base}/`
					});
					registration.addEventListener('updatefound', onUpdateFound);
					showWaitingUpdate(registration.waiting);
					return;
				}
				registration.removeEventListener('updatefound', onUpdateFound);
				registration.addEventListener('updatefound', onUpdateFound);
				showWaitingUpdate(registration.waiting);
				await registration.update();
			})()
				.catch((error: unknown) =>
					recordRuntimeEvent(
						'service-worker-update',
						error instanceof Error ? error.message : String(error)
					)
				)
				.finally(() => {
					checkingForUpdate = false;
				});
		};
		const finishManualUpdate = () => {
			if (applyingUpdate) window.location.reload();
		};
		navigator.serviceWorker.addEventListener('controllerchange', finishManualUpdate);
		window.addEventListener('focus', checkForUpdate);
		checkForUpdate();
		return () => {
			window.removeEventListener('error', onWindowError);
			window.removeEventListener('unhandledrejection', onUnhandledRejection);
			navigator.serviceWorker.removeEventListener('controllerchange', finishManualUpdate);
			window.removeEventListener('focus', checkForUpdate);
			registration?.removeEventListener('updatefound', onUpdateFound);
			installingWorker?.removeEventListener('statechange', onInstallingStateChange);
		};
	});

	function applyUpdate(): void {
		if (!waitingServiceWorker || runtimeBusy) return;
		applyingUpdate = true;
		waitingServiceWorker.postMessage({ type: 'SKIP_WAITING' });
	}

	function toggleSidebar(): void {
		sidebarCollapsed = !sidebarCollapsed;
		window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed));
	}

	function closeNavigation(): void {
		mobileSidebarOpen = false;
		readerChrome.closeTransientPanels();
	}

	function toggleTheme(): void {
		theme = nextTheme;
		document.documentElement.dataset.theme = theme;
		window.localStorage.setItem(themeStorageKey, theme);
		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme]);
	}

	async function toggleFullscreen(): Promise<void> {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
		} catch (error) {
			appState.errorMessage =
				error instanceof Error ? error.message : 'Fullscreen mode is unavailable in this browser.';
		}
	}
</script>

<svelte:document bind:fullscreenElement />

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Voicebook — local document listening</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>

<header class="app-header" class:sidebar-collapsed={sidebarCollapsed} aria-label="Voicebook header">
	<div class="app-brand-slot">
		<a class="brand" href={homeHref} aria-label="Voicebook library" onclick={closeNavigation}>
			<span class="brand-mark" aria-hidden="true">
				<BrandMark active={player.isPlaying || player.isBuffering} />
			</span>
			<span class="brand-name">Voicebook</span>
		</a>
		<button
			class="mobile-nav-toggle icon-button"
			type="button"
			aria-label={mobileSidebarOpen ? 'Close navigation' : 'Open navigation'}
			aria-controls="voicebook-navigation"
			aria-expanded={mobileSidebarOpen}
			title={mobileSidebarOpen ? 'Close navigation' : 'Open navigation'}
			onclick={() => (mobileSidebarOpen = !mobileSidebarOpen)}
		>
			{#if mobileSidebarOpen}<X size={17} />{:else}<Menu size={17} />{/if}
		</button>
	</div>

	{#if isReader && readerBook}
		<div class="reader-commandbar">
			<div class="reader-commandbar-title">
				<strong>{readerBook.title}</strong>
			</div>

			<div class="reader-commandbar-actions">
				<button
					class="icon-button mobile-reader-hidden"
					class:active={readerChrome.outlineOpen}
					type="button"
					aria-label={readerChrome.outlineOpen ? 'Close document outline' : 'Open document outline'}
					aria-controls="document-outline"
					aria-expanded={readerChrome.outlineOpen}
					title={readerChrome.outlineOpen ? 'Close contents' : 'Open contents'}
					onclick={() => (readerChrome.outlineOpen = !readerChrome.outlineOpen)}
				>
					<List size={16} strokeWidth={1.6} />
				</button>
				<div class="document-zoom" role="group" aria-label="Document zoom">
					<button
						class="icon-button"
						type="button"
						disabled={readerChrome.documentZoom <= 0.8}
						aria-label="Zoom document out"
						title="Zoom document out"
						onclick={() => readerChrome.zoomOut()}
					>
						<ZoomOut size={16} />
					</button>
					<button
						class="zoom-value"
						type="button"
						aria-label={`Reset document zoom, currently ${readerChrome.zoomPercent}%`}
						title="Reset document zoom"
						onclick={() => readerChrome.resetZoom()}
					>
						{readerChrome.zoomPercent}%
					</button>
					<button
						class="icon-button"
						type="button"
						disabled={readerChrome.documentZoom >= 1.6}
						aria-label="Zoom document in"
						title="Zoom document in"
						onclick={() => readerChrome.zoomIn()}
					>
						<ZoomIn size={16} />
					</button>
					<button
						class="icon-button"
						class:active={isFullscreen}
						type="button"
						aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						onclick={() => void toggleFullscreen()}
					>
						{#if isFullscreen}<Minimize2 size={16} />{:else}<Maximize2 size={16} />{/if}
					</button>
				</div>
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
				<button
					class="icon-button"
					type="button"
					aria-label={`Theme: ${themeLabels[theme]}. Switch to ${themeLabels[nextTheme]} theme`}
					title={`${themeLabels[theme]} · next ${themeLabels[nextTheme]}`}
					onclick={toggleTheme}
				>
					{#if theme === 'sunny'}
						<Sun size={16} />
					{:else if theme === 'cloudy'}
						<CloudSun size={16} />
					{:else if theme === 'rainy'}
						<CloudRain size={16} />
					{:else}
						<Moon size={16} />
					{/if}
				</button>
				<a
					class="icon-button github-link"
					href={repositoryHref}
					target="_blank"
					rel="noreferrer"
					aria-label="Open Voicebook on GitHub"
					title="Open Voicebook on GitHub"
				>
					<GitHubOutline size={16} />
				</a>
			</div>
		</div>
	{:else}
		<div class="global-commandbar">
			<button
				class="icon-button"
				type="button"
				aria-label={`Theme: ${themeLabels[theme]}. Switch to ${themeLabels[nextTheme]} theme`}
				title={`${themeLabels[theme]} · next ${themeLabels[nextTheme]}`}
				onclick={toggleTheme}
			>
				{#if theme === 'sunny'}
					<Sun size={16} />
				{:else if theme === 'cloudy'}
					<CloudSun size={16} />
				{:else if theme === 'rainy'}
					<CloudRain size={16} />
				{:else}
					<Moon size={16} />
				{/if}
			</button>
			<a
				class="icon-button github-link"
				href={repositoryHref}
				target="_blank"
				rel="noreferrer"
				aria-label="Open Voicebook on GitHub"
				title="Open Voicebook on GitHub"
			>
				<GitHubOutline size={16} />
			</a>
		</div>
	{/if}
</header>

{#if mobileSidebarOpen}
	<button
		class="mobile-nav-scrim"
		type="button"
		aria-label="Close navigation"
		onclick={() => (mobileSidebarOpen = false)}
	></button>
{/if}

<div class="app-shell" class:sidebar-collapsed={sidebarCollapsed} class:reader-mode={isReader}>
	<aside
		id="voicebook-navigation"
		class="app-sidebar"
		class:mobile-open={mobileSidebarOpen}
		aria-label="Voicebook navigation"
	>
		<div class="sidebar-head">
			<div class="library-nav-group">
				<a
					class="sidebar-library-link"
					class:active={page.url.pathname === homeHref}
					href={homeHref}
					aria-label="Library"
					aria-current={page.url.pathname === homeHref ? 'page' : undefined}
					data-tooltip="Library"
					onclick={closeNavigation}
				>
					<Library size={17} />
					<span>Library</span>
				</a>

				{#if sidebarCollapsed && !mobileSidebarOpen && appState.documents.length}
					<div class="library-flyout" aria-label="Recent documents">
						<strong>Recent documents</strong>
						{#each appState.documents.slice(0, 7) as document (document.id)}
							<a
								class:active={activeReaderDocumentId === document.id}
								href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
								aria-current={activeReaderDocumentId === document.id ? 'page' : undefined}
								onclick={closeNavigation}
							>
								<DocumentKindIcon kind={document.sourceKind} size={14} />
								<span>{document.title}</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>
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

		<div id="primary-navigation" class="sidebar-main">
			{#if !sidebarCollapsed || mobileSidebarOpen}
				<div class="sidebar-documents">
					<span class="sidebar-section-label">Recent</span>
					{#if appState.documents.length}
						<nav aria-label="Recent documents">
							{#each appState.documents as document (document.id)}
								<a
									class:active={activeReaderDocumentId === document.id}
									href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
									aria-current={activeReaderDocumentId === document.id ? 'page' : undefined}
									title={document.title}
									onclick={closeNavigation}
								>
									<DocumentKindIcon kind={document.sourceKind} size={14} />
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
				onclick={closeNavigation}
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
				onclick={closeNavigation}
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
				onclick={closeNavigation}
			>
				<Settings2 size={17} />
				<span>System</span>
			</a>
		</nav>
	</aside>

	<div class="shell-content" class:reader-mode={isReader}>
		<main id="main-content">
			{@render children()}
		</main>
	</div>
</div>

{#if updateAvailable && !updateDismissed}
	<div class="toast update-toast" class:stacked={Boolean(appState.errorMessage)} role="status">
		<div>
			<strong>A Voicebook update is ready</strong>
			<p>
				{runtimeBusy
					? 'Finish or pause the current voice work before reloading.'
					: 'Reload when you are ready. Voicebook will never refresh itself.'}
			</p>
		</div>
		<div class="update-actions">
			<button
				class="button"
				type="button"
				disabled={runtimeBusy || applyingUpdate}
				onclick={applyUpdate}
			>
				<RefreshCw class={applyingUpdate ? 'spin' : undefined} size={14} />
				{applyingUpdate ? 'Reloading' : 'Reload'}
			</button>
			<button
				class="icon-button"
				type="button"
				aria-label="Dismiss update notice"
				onclick={() => (updateDismissed = true)}
			>
				<X size={17} />
			</button>
		</div>
	</div>
{/if}

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
