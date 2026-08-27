<script lang="ts">
	import '@fontsource-variable/instrument-sans/index.css';
	import '@fontsource-variable/newsreader/index.css';
	import { browser } from '$app/environment';
	import { fly } from 'svelte/transition';
	import { page } from '$app/state';
	import { base, resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';
	import {
		PanelLeftClose,
		PanelLeftOpen,
		BookOpenText,
		BrainCircuit,
		CircleHelp,
		Fullscreen,
		RefreshCw,
		Settings2,
		FileText,
		Library,
		Palette,
		FileUp,
		Search,
		Shrink,
		Link2,
		List,
		Menu,
		Plus,
		Cpu,
		X
	} from '$lib/icons';
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import ThemeIcon from '$lib/components/ThemeIcon.svelte';
	import DocumentKindIcon from '$lib/components/DocumentKindIcon.svelte';
	import GitHubOutline from '$lib/components/GitHubOutline.svelte';
	import { recordRuntimeEvent } from '$lib/services/runtime-diagnostics';
	import { startTour, type TourContext } from '$lib/services/tours';
	import LibraryAddOverlays from '$lib/components/LibraryAddOverlays.svelte';
	import { appState } from '$lib/state/app-state.svelte';
	import { appearanceState } from '$lib/state/appearance.svelte';
	import { libraryAdd } from '$lib/state/library-add.svelte';
	import { player } from '$lib/state/player.svelte';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';
	import './layout.css';

	let { children } = $props();

	const homeHref = resolve('/');
	const settingsHref = resolve('/settings');
	const repositoryHref = 'https://github.com/NeoVand/voicebook';
	const sidebarStorageKey = 'voicebook:sidebar-collapsed';
	let sidebarCollapsed = $state(
		browser && window.localStorage.getItem(sidebarStorageKey) === 'true'
	);
	let mobileSidebarOpen = $state(false);
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
	let isReader = $derived(page.url.pathname.startsWith(resolve('/read')));
	let settingsSection = $derived(page.url.searchParams.get('section') ?? 'models');
	let readerDocumentId = $derived(page.url.searchParams.get('document'));
	let activeReaderDocumentId = $derived(isReader ? readerDocumentId : null);
	let readerBook = $derived(
		isReader ? appState.documents.find((document) => document.id === readerDocumentId) : undefined
	);
	/** The page view needs the original file, which only a PDF import keeps —
	 * and only while the bytes are still on this device. */
	let originalPagesAvailable = $derived(
		readerBook?.sourceKind === 'pdf' && Boolean(readerBook.sourcePath || readerBook.sourceBlob)
	);
	const viewLabels = { reading: 'Reading view', page: 'Original pages' } as const;

	let tourContext = $derived<TourContext>(
		isReader
			? 'reader'
			: page.url.pathname.startsWith(resolve('/settings'))
				? settingsSection === 'llm'
					? 'llm'
					: settingsSection === 'appearance'
						? 'appearance'
						: settingsSection === 'system' || settingsSection === 'storage'
							? 'system'
							: 'voice'
				: 'library'
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

	let zoomOpen = $state(false);
	let zoomRoot = $state<HTMLDivElement>();
	let sidebarQuery = $state('');
	let sidebarAddOpen = $state(false);
	let sidebarAddRoot = $state<HTMLDivElement>();

	/** The sidebar list: recents, or every matching title while searching. */
	let sidebarDocuments = $derived.by(() => {
		const query = sidebarQuery.trim().toLocaleLowerCase();
		if (!query) return appState.documents;
		return appState.documents.filter((document) =>
			document.title.toLocaleLowerCase().includes(query)
		);
	});

	function handleZoomPointerDown(event: PointerEvent): void {
		if (zoomOpen && zoomRoot && !zoomRoot.contains(event.target as Node)) zoomOpen = false;
		if (sidebarAddOpen && sidebarAddRoot && !sidebarAddRoot.contains(event.target as Node)) {
			sidebarAddOpen = false;
		}
	}

	function handleZoomKeydown(event: KeyboardEvent): void {
		if (zoomOpen && event.key === 'Escape') zoomOpen = false;
		if (sidebarAddOpen && event.key === 'Escape') sidebarAddOpen = false;
	}

	function sidebarAdd(action: 'files' | 'paste' | 'url'): void {
		sidebarAddOpen = false;
		if (action === 'files') libraryAdd.pickFiles();
		else if (action === 'paste') libraryAdd.openPaste();
		else libraryAdd.openUrl();
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
<svelte:window onpointerdown={handleZoomPointerDown} onkeydown={handleZoomKeydown} />

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
			{#if mobileSidebarOpen}<Icon icon={X} size={17} />{:else}<Icon icon={Menu} size={17} />{/if}
		</button>
	</div>

	{#if isReader && readerBook}
		<div class="reader-commandbar">
			<div class="reader-commandbar-title">
				<strong>{readerBook.title}</strong>
			</div>

			<div class="reader-commandbar-actions">
				<button
					class="icon-button"
					class:active={readerChrome.outlineOpen}
					type="button"
					data-tour="outline"
					aria-label={readerChrome.outlineOpen ? 'Close document outline' : 'Open document outline'}
					aria-controls="document-outline"
					aria-expanded={readerChrome.outlineOpen}
					title={readerChrome.outlineOpen ? 'Close contents' : 'Open contents'}
					onclick={() => (readerChrome.outlineOpen = !readerChrome.outlineOpen)}
				>
					<Icon icon={List} size={16} strokeWidth={1.6} />
				</button>
				{#if originalPagesAvailable}
					<button
						class="icon-button"
						class:active={readerChrome.readerView === 'page'}
						type="button"
						data-tour="reader-view"
						aria-label={`${viewLabels[readerChrome.readerView]}. Switch view`}
						title={`${viewLabels[readerChrome.readerView]} · click to switch`}
						onclick={() => readerChrome.cycleReaderView()}
					>
						{#if readerChrome.readerView === 'page'}
							<Icon icon={FileText} size={16} strokeWidth={1.6} />
						{:else}
							<Icon icon={BookOpenText} size={16} strokeWidth={1.6} />
						{/if}
					</button>
				{/if}
				<div class="document-zoom" role="group" aria-label="Document zoom">
					<div class="zoom-control" bind:this={zoomRoot}>
						<button
							class="zoom-value"
							class:open={zoomOpen}
							type="button"
							data-tour="zoom"
							aria-label={`Document zoom ${readerChrome.zoomPercent} percent`}
							aria-expanded={zoomOpen}
							aria-controls="zoom-popover"
							title="Document zoom · double-click resets"
							onclick={() => (zoomOpen = !zoomOpen)}
							ondblclick={() => {
								readerChrome.resetZoom();
								zoomOpen = false;
							}}
						>
							{readerChrome.zoomPercent}%
						</button>
						{#if zoomOpen}
							<label
								id="zoom-popover"
								class="zoom-popover"
								transition:fly={{ y: -5, duration: 120 }}
							>
								<span class="zoom-readout" aria-hidden="true">{readerChrome.zoomPercent}%</span>
								<input
									aria-label="Document zoom"
									type="range"
									min="80"
									max="160"
									step="1"
									value={readerChrome.zoomPercent}
									style:--zoom-progress={`${Math.round(((readerChrome.zoomPercent - 80) / 80) * 100)}%`}
									oninput={(event) =>
										readerChrome.setDocumentZoom(
											Number((event.currentTarget as HTMLInputElement).value) / 100
										)}
								/>
							</label>
						{/if}
					</div>
					<button
						class="icon-button"
						class:active={isFullscreen}
						type="button"
						data-tour="fullscreen"
						aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
						onclick={() => void toggleFullscreen()}
					>
						{#if isFullscreen}<Icon icon={Shrink} size={16} />{:else}<Icon
								icon={Fullscreen}
								size={16}
							/>{/if}
					</button>
				</div>
				<button
					class="icon-button"
					type="button"
					data-tour="help"
					aria-label="Show me around"
					title="Show me around"
					onclick={() => startTour(tourContext)}
				>
					<Icon icon={CircleHelp} size={16} />
				</button>
				<button
					class="icon-button"
					type="button"
					data-tour="theme"
					aria-label={`Theme: ${appearanceState.themeSpec.label}. Switch to ${appearanceState.nextThemeSpec.label} theme`}
					title={`${appearanceState.themeSpec.label} · next: ${appearanceState.nextThemeSpec.label}`}
					onclick={() => appearanceState.cycleTheme()}
				>
					<ThemeIcon theme={appearanceState.theme} size={16} />
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
				data-tour="help"
				aria-label="Show me around"
				title="Show me around"
				onclick={() => startTour(tourContext)}
			>
				<Icon icon={CircleHelp} size={16} />
			</button>
			<button
				class="icon-button"
				type="button"
				data-tour="theme"
				aria-label={`Theme: ${appearanceState.themeSpec.label}. Switch to ${appearanceState.nextThemeSpec.label} theme`}
				title={`${appearanceState.themeSpec.label} · next: ${appearanceState.nextThemeSpec.label}`}
				onclick={() => appearanceState.cycleTheme()}
			>
				<ThemeIcon theme={appearanceState.theme} size={16} />
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
					<Icon icon={Library} size={17} />
					<span>Library</span>
				</a>

				{#if sidebarCollapsed && !mobileSidebarOpen}
					<div class="library-flyout" aria-label="Library">
						<label class="flyout-search">
							<Icon icon={Search} size={12} aria-hidden="true" />
							<input
								type="search"
								placeholder="Search library…"
								aria-label="Search the library"
								bind:value={sidebarQuery}
							/>
						</label>
						<button class="flyout-action" type="button" onclick={() => sidebarAdd('files')}>
							<Icon icon={FileUp} size={14} />
							<span>Add document</span>
						</button>
						<button class="flyout-action" type="button" onclick={() => sidebarAdd('paste')}>
							<Icon icon={FileText} size={14} />
							<span>Paste text</span>
						</button>
						<button class="flyout-action" type="button" onclick={() => sidebarAdd('url')}>
							<Icon icon={Link2} size={14} />
							<span>From URL</span>
						</button>
						{#if appState.documents.length}
							<strong>{sidebarQuery.trim() ? 'Results' : 'Recent documents'}</strong>
							{#each sidebarDocuments.slice(0, 7) as document (document.id)}
								<a
									class:active={activeReaderDocumentId === document.id}
									href={resolve(`/read?document=${encodeURIComponent(document.id)}`)}
									aria-current={activeReaderDocumentId === document.id ? 'page' : undefined}
									onclick={closeNavigation}
								>
									<DocumentKindIcon kind={document.sourceKind} size={14} />
									<span>{document.title}</span>
								</a>
							{:else}
								<p class="flyout-empty">No matches for “{sidebarQuery.trim()}”.</p>
							{/each}
						{/if}
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
					<Icon icon={PanelLeftOpen} size={17} />
				{:else}
					<Icon icon={PanelLeftClose} size={17} />
				{/if}
			</button>
		</div>

		<div id="primary-navigation" class="sidebar-main">
			{#if !sidebarCollapsed || mobileSidebarOpen}
				<div class="sidebar-quick">
					<label class="sidebar-search">
						<Icon icon={Search} size={12} aria-hidden="true" />
						<input
							type="search"
							placeholder="Search…"
							aria-label="Search the library"
							bind:value={sidebarQuery}
						/>
					</label>
					<div class="sidebar-add" bind:this={sidebarAddRoot}>
						<button
							class="sidebar-add-button"
							type="button"
							aria-label="Quick add"
							aria-haspopup="menu"
							aria-expanded={sidebarAddOpen}
							title="Quick add"
							onclick={() => (sidebarAddOpen = !sidebarAddOpen)}
						>
							<Icon icon={Plus} size={15} />
						</button>
						{#if sidebarAddOpen}
							<div
								class="sidebar-add-menu"
								role="menu"
								aria-label="Add to library"
								in:fly={{ y: 4, duration: 120 }}
							>
								<button role="menuitem" type="button" onclick={() => sidebarAdd('files')}>
									<Icon icon={FileUp} size={14} />
									<span>Add document</span>
								</button>
								<button role="menuitem" type="button" onclick={() => sidebarAdd('paste')}>
									<Icon icon={FileText} size={14} />
									<span>Paste text</span>
								</button>
								<button role="menuitem" type="button" onclick={() => sidebarAdd('url')}>
									<Icon icon={Link2} size={14} />
									<span>From URL</span>
								</button>
							</div>
						{/if}
					</div>
				</div>
				<div class="sidebar-documents">
					<span class="sidebar-section-label">{sidebarQuery.trim() ? 'Results' : 'Recent'}</span>
					{#if appState.documents.length}
						<nav aria-label={sidebarQuery.trim() ? 'Search results' : 'Recent documents'}>
							{#each sidebarDocuments as document (document.id)}
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
							{:else}
								<p>No matches for “{sidebarQuery.trim()}”.</p>
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
				<Icon icon={Cpu} size={17} />
				<span>Voice</span>
			</a>
			<a
				class="nav-link"
				class:active={page.url.pathname.startsWith(settingsHref) && settingsSection === 'llm'}
				href={resolve('/settings?section=llm')}
				aria-label="LLM"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'llm'
					? 'page'
					: undefined}
				data-tooltip="LLM"
				onclick={closeNavigation}
			>
				<Icon icon={BrainCircuit} size={17} />
				<span>LLM</span>
			</a>
			<a
				class="nav-link"
				class:active={page.url.pathname.startsWith(settingsHref) &&
					settingsSection === 'appearance'}
				href={resolve('/settings?section=appearance')}
				aria-label="Appearance"
				aria-current={page.url.pathname.startsWith(settingsHref) && settingsSection === 'appearance'
					? 'page'
					: undefined}
				data-tooltip="Appearance"
				onclick={closeNavigation}
			>
				<Icon icon={Palette} size={17} />
				<span>Appearance</span>
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
				<Icon icon={Settings2} size={17} />
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

<LibraryAddOverlays />

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
				<Icon icon={RefreshCw} class={applyingUpdate ? 'spin' : undefined} size={14} />
				{applyingUpdate ? 'Reloading' : 'Reload'}
			</button>
			<button
				class="icon-button"
				type="button"
				aria-label="Dismiss update notice"
				onclick={() => (updateDismissed = true)}
			>
				<Icon icon={X} size={17} />
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
			<Icon icon={X} size={17} />
		</button>
	</div>
{/if}
