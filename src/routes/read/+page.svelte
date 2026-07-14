<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		ArrowLeft,
		Bookmark,
		BookOpenText,
		Check,
		ChevronDown,
		ChevronLeft,
		ChevronRight,
		Code2,
		Download,
		Ellipsis,
		List,
		ListMusic,
		LoaderCircle,
		LocateFixed,
		Pause,
		Play,
		RotateCcw,
		RotateCw,
		Sparkles,
		Square,
		Volume2,
		X
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { on } from 'svelte/events';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import InlineText from '$lib/components/InlineText.svelte';
	import MermaidDiagram from '$lib/components/MermaidDiagram.svelte';
	import { segmentBlocks } from '$lib/domain/segmenter';
	import type {
		DocumentBlock,
		InlineRun,
		NormalizedDocument,
		SpeechSegment,
		TableCell
	} from '$lib/domain/types';
	import { appState } from '$lib/state/app-state.svelte';
	import { player } from '$lib/state/player.svelte';

	let book = $state<NormalizedDocument | null>(null);
	let outlineOpen = $state(true);
	let bookmarksOpen = $state(false);
	let readerMenuOpen = $state(false);
	let installing = $state(false);
	let activeOutlineBlockId = $state<string>();
	let outlineAnnouncement = $state('');
	let readingCanvas = $state<HTMLElement>();
	let readerScrollFrame = 0;
	let outlineNavigationBlockId: string | undefined;
	const segmentElements = new SvelteMap<string, HTMLElement>();
	interface NarrationStartAction {
		segmentId: string;
		wordIndex: number;
		excerpt: string;
		left: number;
		top: number;
		placement: 'above' | 'below';
	}
	let narrationStartAction = $state<NarrationStartAction>();
	let narrationAnnouncement = $state('');

	let segmentsByBlock = $derived.by(() => {
		const map = new SvelteMap<string, SpeechSegment[]>();
		for (const segment of book?.segments ?? [])
			map.set(segment.blockId, [...(map.get(segment.blockId) ?? []), segment]);
		return map;
	});

	let segmentIndexes = $derived.by(
		() => new SvelteMap((book?.segments ?? []).map((segment, index) => [segment.id, index]))
	);
	let currentBookmarked = $derived(
		Boolean(book?.bookmarks.some((bookmark) => bookmark.segmentId === player.currentSegment?.id))
	);
	let activeSegmentId = $derived(
		player.isPlaying || player.position > 0 ? player.currentSegment?.id : undefined
	);
	let installed = $derived(appState.installedModels.includes('supertonic-3'));
	let licenseAccepted = $derived(appState.acceptedLicenses.includes('supertonic-3'));
	let selectedVoiceName = $derived(
		appState.selectedModel.voices.find((voice) => voice.id === appState.selectedVoiceId)?.name ??
			'Voice'
	);
	let titleBlock = $derived.by(() => {
		return book?.blocks.find((block) => block.kind === 'heading' && block.level === 1);
	});
	type ReadingNode =
		| { type: 'block'; key: string; block: DocumentBlock }
		| {
				type: 'list';
				key: string;
				ordered: boolean;
				depth: number;
				start: number;
				items: DocumentBlock[];
		  };
	let readingFlow = $derived.by(() => {
		const nodes: ReadingNode[] = [];
		for (const block of book?.blocks ?? []) {
			if (block.id === titleBlock?.id) continue;
			if (block.kind !== 'list-item') {
				nodes.push({ type: 'block', key: block.id, block });
				continue;
			}
			const ordered = block.list?.ordered ?? false;
			const depth = block.list?.depth ?? 0;
			const previous = nodes.at(-1);
			if (previous?.type === 'list' && previous.ordered === ordered && previous.depth === depth) {
				previous.items.push(block);
			} else {
				nodes.push({
					type: 'list',
					key: `list-${block.id}`,
					ordered,
					depth,
					start: block.list?.start ?? 1,
					items: [block]
				});
			}
		}
		return nodes;
	});

	onMount(() => {
		player.onSegmentChange = (segmentId) => {
			if (!player.autoFollow || outlineNavigationBlockId) return;
			requestAnimationFrame(() => {
				const element = segmentElements.get(segmentId);
				if (element) scrollNarrationIntoView(element, false);
			});
		};
		void appState.initialize().then(() => {
			const id = new URL(window.location.href).searchParams.get('document');
			book = appState.documents.find((document) => document.id === id) ?? null;
			if (book) {
				player.setDocument(book);
				activeOutlineBlockId =
					book.outline.find((item) => item.blockId === player.currentSegment?.blockId)?.blockId ??
					book.outline[0]?.blockId;
				void player.warmEngine();
				requestAnimationFrame(scheduleVisibleSectionUpdate);
			}
		});
		return () => {
			cancelAnimationFrame(readerScrollFrame);
			player.onSegmentChange = undefined;
		};
	});

	function trackSegment(id: string) {
		return (node: HTMLElement) => {
			segmentElements.set(id, node);
			return () => segmentElements.delete(id);
		};
	}

	const trackReadingCanvas: Attachment<HTMLElement> = (element) => {
		readingCanvas = element;
		const removeListeners = [
			on(element, 'scroll', handleReaderScroll),
			on(element, 'wheel', () => (player.autoFollow = false)),
			on(element, 'touchmove', () => (player.autoFollow = false)),
			on(element, 'pointerup', scheduleTextSelectionAction),
			on(element, 'keyup', scheduleTextSelectionAction),
			on(element, 'click', startClickedPassage),
			on(element, 'keydown', handlePassageKeydown)
		];
		requestAnimationFrame(scheduleVisibleSectionUpdate);
		return () => {
			for (const removeListener of removeListeners) removeListener();
			if (readingCanvas === element) readingCanvas = undefined;
		};
	};

	interface RenderedRun {
		run: InlineRun;
		pieces: Array<{ text: string; wordIndex?: number }>;
	}

	function tokens(block: DocumentBlock, segment: SpeechSegment): RenderedRun[] {
		const sourceRuns =
			block.inlines?.length && block.inlines.map((run) => run.text).join('') === block.text
				? block.inlines
				: [{ text: block.text }];
		const output: RenderedRun[] = [];
		let runStart = 0;
		for (const run of sourceRuns) {
			const runEnd = runStart + run.text.length;
			const start = Math.max(runStart, segment.start);
			const end = Math.min(runEnd, segment.end);
			if (start < end) {
				const pieces: RenderedRun['pieces'] = [];
				const boundaries = new SvelteSet([start, end]);
				for (const word of segment.words) {
					const wordStart = segment.start + word.start;
					const wordEnd = segment.start + word.end;
					if (wordStart > start && wordStart < end) boundaries.add(wordStart);
					if (wordEnd > start && wordEnd < end) boundaries.add(wordEnd);
				}
				const points = [...boundaries].sort((left, right) => left - right);
				for (let index = 0; index < points.length - 1; index += 1) {
					const tokenStart = points[index];
					const tokenEnd = points[index + 1];
					const wordIndex = segment.words.findIndex(
						(word) =>
							tokenStart >= segment.start + word.start && tokenEnd <= segment.start + word.end
					);
					pieces.push({
						text: run.text.slice(tokenStart - runStart, tokenEnd - runStart),
						wordIndex: wordIndex >= 0 ? wordIndex : undefined
					});
				}
				output.push({
					run: { ...run, text: run.text.slice(start - runStart, end - runStart) },
					pieces
				});
			}
			runStart = runEnd;
		}
		return output;
	}

	function headingTag(block: DocumentBlock): 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
		return `h${Math.max(2, Math.min(6, block.level ?? 2))}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
	}

	function firstSegmentIndex(block: DocumentBlock): number | undefined {
		const segment = segmentsByBlock.get(block.id)?.[0];
		return segment ? segmentIndexes.get(segment.id) : undefined;
	}

	function blockFor(id: string): DocumentBlock | undefined {
		return book?.blocks.find((block) => block.id === id);
	}

	function elementInReader(id: string): HTMLElement | undefined {
		if (!readingCanvas) return;
		const element = document.getElementById(id);
		return element instanceof HTMLElement && readingCanvas.contains(element) ? element : undefined;
	}

	function scrollReaderTo(element: HTMLElement, focusDestination = false): void {
		if (!readingCanvas) return;
		const canvasRect = readingCanvas.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		const top = Math.max(0, readingCanvas.scrollTop + elementRect.top - canvasRect.top - 24);
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const longJump = Math.abs(top - readingCanvas.scrollTop) > readingCanvas.clientHeight * 1.5;
		readingCanvas.scrollTo({ top, behavior: reducedMotion || longJump ? 'auto' : 'smooth' });
		if (focusDestination) {
			requestAnimationFrame(() => element.focus({ preventScroll: true }));
		}
		scheduleVisibleSectionUpdate();
	}

	function scrollNarrationIntoView(element: HTMLElement, userRequested: boolean): void {
		if (!readingCanvas) return;
		const canvasRect = readingCanvas.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		const centeredTop =
			readingCanvas.scrollTop +
			elementRect.top -
			canvasRect.top -
			(readingCanvas.clientHeight - elementRect.height) / 2;
		const maximumTop = Math.max(0, readingCanvas.scrollHeight - readingCanvas.clientHeight);
		const top = Math.max(0, Math.min(maximumTop, centeredTop));
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const longJump = Math.abs(top - readingCanvas.scrollTop) > readingCanvas.clientHeight * 1.5;
		readingCanvas.scrollTo({
			top,
			behavior: userRequested && !reducedMotion && !longJump ? 'smooth' : 'auto'
		});
		scheduleVisibleSectionUpdate();
	}

	function resumeNarrationFollow(): void {
		player.autoFollow = true;
		const segment = player.currentSegment;
		if (!segment) return;
		requestAnimationFrame(() => {
			const element = segmentElements.get(segment.id);
			if (element) scrollNarrationIntoView(element, true);
		});
	}

	function compactOutlineTitle(title: string): string {
		const normalized = title.replace(/\s+/g, ' ').trim();
		if (normalized.length <= 56) return normalized;
		const clipped = normalized.slice(0, 53);
		const lastSpace = clipped.lastIndexOf(' ');
		return `${clipped.slice(0, lastSpace > 32 ? lastSpace : 53).trimEnd()}…`;
	}

	function navigateToOutlineBlock(block: DocumentBlock): void {
		const element = elementInReader(block.id);
		if (!element) return;

		const compactOutline = window.matchMedia('(max-width: 820px)').matches;
		outlineNavigationBlockId = block.id;
		activeOutlineBlockId = block.id;
		outlineAnnouncement = `Moved to ${block.text}`;
		scrollReaderTo(element, compactOutline);
		if (compactOutline) outlineOpen = false;

		const index = firstSegmentIndex(block);
		if (index === undefined) {
			outlineNavigationBlockId = undefined;
			return;
		}
		void player.goToSegment(index).finally(() => {
			if (outlineNavigationBlockId === block.id) outlineNavigationBlockId = undefined;
		});
	}

	function navigateToSegment(segment: SpeechSegment): void {
		const element = segmentElements.get(segment.id);
		if (element) scrollReaderTo(element);
		void player.goToSegment(segmentIndexes.get(segment.id) ?? 0);
	}

	async function startNarrationFrom(
		segment: SpeechSegment,
		wordIndex = 0,
		clearSelection = false
	): Promise<void> {
		const index = segmentIndexes.get(segment.id);
		if (index === undefined) return;
		narrationStartAction = undefined;
		if (clearSelection) window.getSelection()?.removeAllRanges();
		player.autoFollow = true;
		narrationAnnouncement = `Starting from ${segment.text.replace(/\s+/g, ' ').trim()}`;
		await player.playFromSegment(index, wordIndex);
	}

	function segmentForElement(element: Element | null): SpeechSegment | undefined {
		const segmentId = element?.closest<HTMLElement>('.speech-segment')?.dataset.segmentId;
		return segmentId ? book?.segments.find((candidate) => candidate.id === segmentId) : undefined;
	}

	function positionedNarrationAction(
		segment: SpeechSegment,
		wordIndex: number,
		excerpt: string,
		rect: DOMRect
	): NarrationStartAction | undefined {
		if (!readingCanvas) return;
		const canvasRect = readingCanvas.getBoundingClientRect();
		const placement = rect.top - canvasRect.top >= 54 ? 'above' : 'below';
		const unclampedLeft = readingCanvas.scrollLeft + rect.left + rect.width / 2 - canvasRect.left;
		const left = Math.max(86, Math.min(readingCanvas.clientWidth - 86, unclampedLeft));
		const top =
			readingCanvas.scrollTop +
			(placement === 'above' ? rect.top - canvasRect.top - 8 : rect.bottom - canvasRect.top + 8);
		return { segmentId: segment.id, wordIndex, excerpt, left, top, placement };
	}

	function startClickedPassage(event: MouseEvent): void {
		if (!(event.target instanceof Element)) return;
		if (event.target.closest('a, button')) return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		const segment = segmentForElement(event.target);
		if (!segment) return;
		void startNarrationFrom(segment);
	}

	function handlePassageKeydown(event: KeyboardEvent): void {
		if (
			!(event.target instanceof HTMLElement) ||
			!event.target.matches('.speech-segment') ||
			(event.key !== 'Enter' && event.key !== ' ')
		)
			return;
		const segment = segmentForElement(event.target);
		if (!segment) return;
		event.preventDefault();
		void startNarrationFrom(segment);
	}

	function updateTextSelectionAction(): void {
		if (!readingCanvas || !book) return;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			narrationStartAction = undefined;
			return;
		}

		const range = selection.getRangeAt(0);
		if (!readingCanvas.contains(range.commonAncestorContainer)) {
			narrationStartAction = undefined;
			return;
		}
		const startElement =
			range.startContainer instanceof Element
				? range.startContainer
				: range.startContainer.parentElement;
		const segmentElement = startElement?.closest<HTMLElement>('.speech-segment');
		const segmentId = segmentElement?.dataset.segmentId;
		const segment = segmentId
			? book.segments.find((candidate) => candidate.id === segmentId)
			: undefined;
		if (!segmentElement || !segment || !readingCanvas.contains(segmentElement)) {
			narrationStartAction = undefined;
			return;
		}

		const wordElement = startElement?.closest<HTMLElement>('[data-word-index]');
		const parsedWordIndex = Number(wordElement?.dataset.wordIndex ?? 0);
		const wordIndex = Number.isFinite(parsedWordIndex) ? parsedWordIndex : 0;
		const rangeRect = range.getBoundingClientRect();
		narrationStartAction = positionedNarrationAction(
			segment,
			wordIndex,
			selection.toString().replace(/\s+/g, ' ').trim(),
			rangeRect
		);
	}

	function scheduleTextSelectionAction(): void {
		requestAnimationFrame(updateTextSelectionAction);
	}

	function handleReaderScroll(): void {
		narrationStartAction = undefined;
		scheduleVisibleSectionUpdate();
	}

	function updateVisibleSection(): void {
		readerScrollFrame = 0;
		if (!readingCanvas || !book?.outline.length) return;
		const canvasRect = readingCanvas.getBoundingClientRect();
		const threshold = canvasRect.top + Math.min(160, readingCanvas.clientHeight * 0.22);
		let lastBeforeThreshold: string | undefined;
		let firstVisible: string | undefined;
		for (const item of book.outline) {
			const element = elementInReader(item.blockId);
			if (!element) continue;
			const elementRect = element.getBoundingClientRect();
			if (elementRect.top <= threshold) lastBeforeThreshold = item.blockId;
			if (
				!firstVisible &&
				elementRect.bottom >= canvasRect.top &&
				elementRect.top <= canvasRect.bottom
			)
				firstVisible = item.blockId;
		}

		const previous = lastBeforeThreshold ? elementInReader(lastBeforeThreshold) : undefined;
		const previousStillVisible = previous
			? previous.getBoundingClientRect().bottom >= canvasRect.top
			: false;
		activeOutlineBlockId =
			(previousStillVisible ? lastBeforeThreshold : firstVisible) ??
			lastBeforeThreshold ??
			book.outline[0]?.blockId;
	}

	function scheduleVisibleSectionUpdate(): void {
		if (readerScrollFrame) return;
		readerScrollFrame = requestAnimationFrame(updateVisibleSection);
	}

	function formatTime(seconds: number): string {
		if (!Number.isFinite(seconds)) return '0:00';
		const minutes = Math.floor(Math.max(0, seconds) / 60);
		const remainder = Math.floor(Math.max(0, seconds) % 60);
		return minutes + ':' + remainder.toString().padStart(2, '0');
	}

	async function installEngine(): Promise<void> {
		installing = true;
		try {
			await appState.installModel('supertonic-3');
		} catch (error) {
			appState.errorMessage =
				error instanceof Error ? error.message : 'The voice engine could not be installed.';
		} finally {
			installing = false;
		}
	}

	async function changeVoice(event: Event): Promise<void> {
		await player.chooseVoice((event.currentTarget as HTMLSelectElement).value);
	}

	async function toggleCodeSpeech(): Promise<void> {
		if (!book) return;
		book.includeCode = !book.includeCode;
		book.segments = segmentBlocks(book.blocks, book.includeCode);
		player.setDocument(book);
		await appState.saveDocument(book);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.matches('input,textarea,select,button,.speech-segment')) return;
		if (event.code === 'Space') {
			event.preventDefault();
			if (player.isBuffering) player.cancelGeneration();
			else void player.toggle();
		} else if (event.key.toLowerCase() === 'j') void player.seekBy(-10);
		else if (event.key.toLowerCase() === 'l') void player.seekBy(10);
		else if (event.key.toLowerCase() === 'b') void player.toggleBookmark();
		else if (event.key === '[') void player.setRate(player.rate - 0.25);
		else if (event.key === ']') void player.setRate(player.rate + 0.25);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{book ? book.title + ' — Voicebook' : 'Reader — Voicebook'}</title>
</svelte:head>

{#snippet renderSegment(block: DocumentBlock, segment: SpeechSegment)}
	{@const isActive = activeSegmentId === segment.id}
	<span
		class="speech-segment"
		class:active={isActive}
		role="button"
		tabindex="0"
		aria-label={segment.text}
		title="Play narration from this passage"
		data-segment-id={segment.id}
		{@attach trackSegment(segment.id)}
	>
		{#each tokens(block, segment) as inline, inlineIndex (inlineIndex)}
			<InlineText
				run={inline.run}
				pieces={inline.pieces}
				activeWordIndex={isActive ? player.currentWordIndex : undefined}
			/>
		{/each}
	</span>
{/snippet}

{#snippet renderCell(cell: TableCell)}
	{#each cell.inlines as inline, inlineIndex (inlineIndex)}
		<InlineText run={inline} />
	{/each}
{/snippet}

{#if !appState.initialized}
	<div class="reader-loading">
		<LoaderCircle class="spin" size={24} />
		<p>Opening your local library…</p>
	</div>
{:else if !book}
	<section class="missing-book">
		<BookOpenText size={30} />
		<h1>Document unavailable</h1>
		<p>It may have been removed, or this link came from another browser.</p>
		<a class="button primary" href={resolve('/')}><ArrowLeft size={16} /> Library</a>
	</section>
{:else}
	<div
		class="reader-shell"
		class:outline-closed={!outlineOpen}
		class:bookmarks-open={bookmarksOpen}
	>
		<header class="reader-header">
			<div class="header-left">
				<a class="icon-button" href={resolve('/')} aria-label="Back to library">
					<ArrowLeft size={18} />
				</a>
				<button
					class="icon-button"
					class:active={outlineOpen}
					type="button"
					aria-label={outlineOpen ? 'Close document outline' : 'Open document outline'}
					aria-controls="document-outline"
					aria-expanded={outlineOpen}
					onclick={() => (outlineOpen = !outlineOpen)}
				>
					<List size={18} />
				</button>
			</div>

			<div class="reader-title">
				<strong>{book.title}</strong>
				<span>{book.sourceKind.toUpperCase()} · {book.segments.length} passages</span>
			</div>

			<div class="header-actions">
				<button
					class="icon-button"
					class:marked={currentBookmarked}
					type="button"
					aria-label={currentBookmarked ? 'Remove bookmark' : 'Add bookmark'}
					onclick={() => player.toggleBookmark()}
				>
					<Bookmark size={17} fill={currentBookmarked ? 'currentColor' : 'none'} />
				</button>
				<button
					class="icon-button"
					class:active={bookmarksOpen}
					type="button"
					aria-label={bookmarksOpen ? 'Close bookmarks' : 'Open bookmarks'}
					onclick={() => (bookmarksOpen = !bookmarksOpen)}
				>
					<ListMusic size={17} />
				</button>
				<div class="reader-menu-wrap">
					<button
						class="icon-button"
						class:active={readerMenuOpen}
						type="button"
						aria-label="Reading options"
						aria-expanded={readerMenuOpen}
						onclick={() => (readerMenuOpen = !readerMenuOpen)}
					>
						<Ellipsis size={18} />
					</button>
					{#if readerMenuOpen}
						<div class="reader-menu" role="menu">
							{#if book.blocks.some((block) => block.kind === 'code')}
								<button
									type="button"
									role="menuitem"
									onclick={() => {
										void toggleCodeSpeech();
										readerMenuOpen = false;
									}}
								>
									<Code2 size={16} />
									<span>
										<strong>{book.includeCode ? 'Skip code' : 'Read code'}</strong>
										<small>Code always remains visible.</small>
									</span>
								</button>
							{/if}
							<button
								type="button"
								role="menuitem"
								disabled={!player.isGeneratingAll && !installed}
								onclick={() => {
									if (player.isGeneratingAll) player.cancelGeneration();
									else void player.generateAll();
									readerMenuOpen = false;
								}}
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
											: 'Optional. Cache every passage for offline replay.'}
									</small>
								</span>
							</button>
						</div>
					{/if}
				</div>
			</div>
		</header>

		{#if outlineOpen}
			<aside id="document-outline" class="outline-panel" aria-label="Document outline">
				<header>
					<strong>Contents</strong>
					<span>{book.outline.length || book.segments.length} sections</span>
				</header>
				<span class="sr-only" aria-live="polite">{outlineAnnouncement}</span>
				<nav aria-label="Table of contents">
					{#if book.outline.length}
						{#each book.outline as item (item.blockId)}
							{@const outlineBlock = blockFor(item.blockId)}
							<button
								type="button"
								class:active={activeOutlineBlockId === item.blockId}
								aria-current={activeOutlineBlockId === item.blockId ? 'location' : undefined}
								aria-label={item.title}
								title={item.title}
								style={'--outline-level:' + Math.max(0, item.level - 1)}
								onclick={() => outlineBlock && navigateToOutlineBlock(outlineBlock)}
							>
								<span>{compactOutlineTitle(item.title)}</span>
							</button>
						{/each}
					{:else}
						{#each book.segments.filter((_, index) => index % 8 === 0) as segment (segment.id)}
							<button
								type="button"
								class:active={segment.id === player.currentSegment?.id}
								onclick={() => navigateToSegment(segment)}
							>
								{segment.text.slice(0, 54)}{segment.text.length > 54 ? '…' : ''}
							</button>
						{/each}
					{/if}
				</nav>
				<footer>
					<div><span>Progress</span><strong>{Math.round(player.progress * 100)}%</strong></div>
					<progress max="100" value={player.progress * 100}></progress>
				</footer>
			</aside>
		{/if}

		<section class="reader-stage">
			{#if !installed}
				<div class="engine-notice">
					<span class="engine-notice-icon"><Sparkles size={17} /></span>
					<div>
						<strong>Install Supertonic 3 to listen</strong>
						<span>One local download · {appState.selectedModel.sizeMb} MB</span>
					</div>
					{#if !licenseAccepted}
						<a class="button" href={resolve('/settings')}>Review license</a>
					{:else}
						<button
							class="button primary"
							type="button"
							disabled={installing}
							onclick={installEngine}
						>
							{#if installing}<LoaderCircle class="spin" size={15} />{/if}
							{installing ? 'Installing' : 'Install'}
						</button>
					{/if}
				</div>
			{/if}

			{#if book.warnings.length}
				<div class="import-warning" role="status">
					<strong>Import note</strong>
					<span>{book.warnings[0]}</span>
				</div>
			{/if}

			<article class="reading-canvas" aria-label={book.title} {@attach trackReadingCanvas}>
				<header class="document-heading" id={titleBlock?.id} tabindex="-1">
					<span>{book.sourceKind.toUpperCase()} · Local library</span>
					<h1>
						{#if titleBlock}
							{#each segmentsByBlock.get(titleBlock.id) ?? [] as segment (segment.id)}
								{@render renderSegment(titleBlock, segment)}
							{/each}
						{:else}
							{book.title}
						{/if}
					</h1>
					<p>
						{Math.max(1, Math.round(player.totalDuration / 60))} min read · {book.segments.length}
						passages
					</p>
				</header>

				<div class="document-body">
					{#each readingFlow as node (node.key)}
						{#if node.type === 'list'}
							{#if node.ordered}
								<ol class="document-list" style:--list-depth={node.depth} start={node.start}>
									{#each node.items as block (block.id)}
										<li id={block.id}>
											{#each segmentsByBlock.get(block.id) ?? [] as segment (segment.id)}
												{@render renderSegment(block, segment)}
											{/each}
										</li>
									{/each}
								</ol>
							{:else}
								<ul
									class="document-list"
									class:task-list={node.items.some((item) => item.list?.checked !== undefined)}
									style:--list-depth={node.depth}
								>
									{#each node.items as block (block.id)}
										<li id={block.id} class:task-item={block.list?.checked !== undefined}>
											{#if block.list?.checked !== undefined}
												<span class="task-marker" aria-hidden="true">
													{#if block.list.checked}<Check size={11} strokeWidth={2.6} />{/if}
												</span>
												<span class="sr-only"
													>{block.list.checked ? 'Completed: ' : 'Not completed: '}</span
												>
											{/if}
											{#each segmentsByBlock.get(block.id) ?? [] as segment (segment.id)}
												{@render renderSegment(block, segment)}
											{/each}
										</li>
									{/each}
								</ul>
							{/if}
						{:else}
							{@const block = node.block}
							{@const blockSegments = segmentsByBlock.get(block.id) ?? []}
							{@const pageLabel = block.anchor.page ? 'Page ' + block.anchor.page : ''}
							{#if block.kind === 'heading'}
								<section class="document-section" id={block.id} tabindex="-1">
									{#if pageLabel}<span class="page-anchor">{pageLabel}</span>{/if}
									<svelte:element this={headingTag(block)}>
										{#each blockSegments as segment (segment.id)}
											{@render renderSegment(block, segment)}
										{/each}
									</svelte:element>
								</section>
							{:else if block.kind === 'frontmatter'}
								<details class="document-metadata" id={block.id}>
									<summary>Document metadata</summary>
									<pre><code>{block.text}</code></pre>
								</details>
							{:else if block.kind === 'code' && block.codeLanguage?.toLowerCase() === 'mermaid'}
								<MermaidDiagram id={block.id} source={block.text} />
							{:else if block.kind === 'code'}
								<figure class="code-block" id={block.id}>
									{#if block.codeLanguage}<figcaption>{block.codeLanguage}</figcaption>{/if}
									<pre><code>{block.text}</code></pre>
								</figure>
							{:else if block.kind === 'quote'}
								<blockquote id={block.id}>
									{#each blockSegments as segment (segment.id)}
										{@render renderSegment(block, segment)}
									{/each}
								</blockquote>
							{:else if block.kind === 'table' && block.table}
								<div class="table-region" id={block.id} role="region" aria-label="Document table">
									<table>
										<thead>
											<tr>
												{#each block.table.header as cell, index (index)}
													<th scope="col" style:text-align={block.table.align[index] ?? undefined}>
														{@render renderCell(cell)}
													</th>
												{/each}
											</tr>
										</thead>
										<tbody>
											{#each block.table.rows as row, rowIndex (rowIndex)}
												<tr>
													{#each row as cell, index (index)}
														<td style:text-align={block.table.align[index] ?? undefined}>
															{@render renderCell(cell)}
														</td>
													{/each}
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							{:else if block.kind === 'divider'}
								<hr id={block.id} />
							{:else}
								<p id={block.id}>
									{#each blockSegments as segment (segment.id)}
										{@render renderSegment(block, segment)}
									{/each}
								</p>
							{/if}
						{/if}
					{/each}
				</div>

				{#if narrationStartAction}
					{@const selectedSegment = book.segments.find(
						(segment) => segment.id === narrationStartAction?.segmentId
					)}
					{#if selectedSegment}
						<button
							class="selection-start"
							class:below={narrationStartAction.placement === 'below'}
							type="button"
							style:left={`${narrationStartAction.left}px`}
							style:top={`${narrationStartAction.top}px`}
							aria-label={`Play from selected text: ${narrationStartAction.excerpt}`}
							onpointerdown={(event) => event.preventDefault()}
							onclick={() =>
								void startNarrationFrom(selectedSegment, narrationStartAction?.wordIndex, true)}
						>
							<Play size={12} fill="currentColor" />
							Play from here
						</button>
					{/if}
				{/if}
			</article>
			<p class="sr-only" aria-live="polite">{narrationAnnouncement}</p>

			{#if !player.autoFollow}
				<button class="return-follow button" type="button" onclick={resumeNarrationFollow}>
					<LocateFixed size={15} /> Follow narration
				</button>
			{/if}
		</section>

		{#if bookmarksOpen}
			<aside class="bookmarks-panel" aria-label="Bookmarks">
				<header>
					<div><strong>Bookmarks</strong><span>{book.bookmarks.length} saved</span></div>
					<button
						class="icon-button"
						type="button"
						aria-label="Close bookmarks"
						onclick={() => (bookmarksOpen = false)}
					>
						<X size={17} />
					</button>
				</header>
				{#if book.bookmarks.length}
					<div class="bookmark-list">
						{#each book.bookmarks as bookmark (bookmark.id)}
							<button type="button" onclick={() => player.openBookmark(bookmark)}>
								<Bookmark size={14} fill="currentColor" />
								<span>
									<strong>{bookmark.label}</strong>
									<small>{new Date(bookmark.createdAt).toLocaleDateString()}</small>
								</span>
							</button>
						{/each}
					</div>
				{:else}
					<div class="empty-bookmarks">
						<Bookmark size={22} />
						<p>Press B while listening to save your place.</p>
					</div>
				{/if}
			</aside>
		{/if}

		<footer class="player-bar" aria-label="Playback controls">
			<div class="now-playing">
				<BookOpenText size={18} />
				<div>
					<strong>
						{player.currentSegment?.text.slice(0, 38) || book.title}{(player.currentSegment?.text
							.length ?? 0) > 38
							? '…'
							: ''}
					</strong>
					<span title={player.runtimeDetail}>{selectedVoiceName} · {player.runtimeLabel}</span>
				</div>
			</div>

			<div class="transport">
				<div class="transport-buttons">
					<button
						class="mini-button"
						type="button"
						aria-label="Previous passage"
						disabled={player.currentSegmentIndex === 0}
						onclick={() => player.goToSegment(player.currentSegmentIndex - 1)}
					>
						<ChevronLeft size={17} />
					</button>
					<button
						class="seek-button"
						type="button"
						aria-label="Back 10 seconds"
						onclick={() => player.seekBy(-10)}
					>
						<RotateCcw size={17} /><span>10</span>
					</button>
					<button
						class="play-button"
						class:loading={player.isBuffering}
						type="button"
						aria-busy={player.isBuffering}
						aria-label={player.isBuffering
							? 'Stop preparing speech'
							: player.isPlaying
								? 'Pause'
								: 'Play'}
						onclick={() => {
							if (player.isBuffering) player.cancelGeneration();
							else void player.toggle();
						}}
					>
						{#if player.isBuffering}
							<Square size={16} fill="currentColor" />
						{:else if player.isPlaying}
							<Pause size={20} fill="currentColor" />
						{:else}
							<Play size={20} fill="currentColor" />
						{/if}
					</button>
					<button
						class="seek-button"
						type="button"
						aria-label="Forward 10 seconds"
						onclick={() => player.seekBy(10)}
					>
						<RotateCw size={17} /><span>10</span>
					</button>
					<button
						class="mini-button"
						type="button"
						aria-label="Next passage"
						disabled={player.currentSegmentIndex >= book.segments.length - 1}
						onclick={() => player.goToSegment(player.currentSegmentIndex + 1)}
					>
						<ChevronRight size={17} />
					</button>
				</div>

				<div class="timeline">
					<span>{formatTime(player.progress * player.totalDuration)}</span>
					<input
						type="range"
						min="0"
						max="1000"
						value={Math.round(player.progress * 1000)}
						style:--timeline-progress={`${Math.round(player.progress * 100)}%`}
						aria-label="Reading position"
						onchange={(event) =>
							player.seekToProgress(Number((event.currentTarget as HTMLInputElement).value) / 1000)}
					/>
					<span>{formatTime(player.totalDuration)}</span>
				</div>
				<span class="sr-only" aria-live="polite" aria-atomic="true">
					{player.isBuffering
						? 'Preparing this passage. Activate the stop button to cancel.'
						: player.isGeneratingAll
							? `Preparing the document. ${Math.round(player.generationProgress)} percent complete.`
							: ''}
				</span>
			</div>

			<div class="player-options" role="group" aria-label="Playback settings">
				<label class="player-select voice-select">
					<span class="sr-only">Voice</span>
					<select aria-label="Voice" value={appState.selectedVoiceId} onchange={changeVoice}>
						{#each appState.selectedModel.voices as voice (voice.id)}
							<option value={voice.id}>{voice.name}</option>
						{/each}
					</select>
					<span class="select-chevron" aria-hidden="true"><ChevronDown size={13} /></span>
				</label>
				<label class="player-select speed-select">
					<span class="sr-only">Playback speed</span>
					<select
						aria-label="Playback speed"
						value={player.rate}
						onchange={(event) =>
							player.setRate(Number((event.currentTarget as HTMLSelectElement).value))}
					>
						{#each [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as speed (speed)}
							<option value={speed}>{speed}×</option>
						{/each}
					</select>
					<span class="select-chevron" aria-hidden="true"><ChevronDown size={13} /></span>
				</label>
				<label class="player-volume">
					<span class="sr-only">Volume</span>
					<Volume2 size={16} aria-hidden="true" />
					<input
						aria-label="Volume"
						type="range"
						min="0"
						max="1"
						step="0.05"
						value={player.volume}
						style:--volume-progress={`${Math.round(player.volume * 100)}%`}
						oninput={(event) =>
							player.setVolume(Number((event.currentTarget as HTMLInputElement).value))}
					/>
				</label>
			</div>

			{#if player.errorMessage}
				<div class="player-error" role="alert">{player.errorMessage}</div>
			{/if}
		</footer>
	</div>
{/if}

<style>
	.reader-loading,
	.missing-book {
		display: grid;
		width: min(520px, calc(100% - 32px));
		min-height: 340px;
		place-items: center;
		margin: 100px auto;
		text-align: center;
	}

	.reader-loading {
		color: var(--muted);
	}

	.missing-book h1 {
		margin: 16px 0 7px;
		font-size: 22px;
		font-weight: 650;
	}

	.missing-book p {
		margin: 0 0 22px;
		color: var(--muted);
		font-size: 11px;
	}

	.reader-shell {
		--player-height: 104px;
		display: grid;
		height: 100dvh;
		min-height: 0;
		grid-template-columns: 252px minmax(0, 1fr);
		grid-template-rows: 54px minmax(0, 1fr) var(--player-height);
		overflow: hidden;
		background: var(--bg);
	}

	.reader-shell.outline-closed {
		grid-template-columns: minmax(0, 1fr);
	}

	.reader-shell.bookmarks-open {
		grid-template-columns: 252px minmax(0, 1fr) 264px;
	}

	.reader-shell.outline-closed.bookmarks-open {
		grid-template-columns: minmax(0, 1fr) 264px;
	}

	.reader-header {
		position: relative;
		z-index: 30;
		display: grid;
		grid-row: 1;
		grid-column: 1 / -1;
		grid-template-columns: 1fr minmax(0, 1.5fr) 1fr;
		align-items: center;
		padding: 0 10px;
		border-bottom: 1px solid var(--line);
		background: #111216;
	}

	.header-left,
	.header-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.header-actions {
		justify-content: flex-end;
	}

	.reader-header .icon-button {
		width: 36px;
		height: 36px;
		flex-basis: 36px;
	}

	.reader-header .icon-button.active {
		background: rgba(255, 255, 255, 0.055);
		color: var(--text);
	}

	.reader-header .icon-button.marked {
		background: var(--bookmark-soft);
		color: var(--bookmark);
	}

	.reader-title {
		min-width: 0;
		text-align: center;
	}

	.reader-title strong,
	.reader-title span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.reader-title strong {
		font-size: 11px;
		font-weight: 640;
	}

	.reader-title span {
		margin-top: 3px;
		color: var(--faint);
		font-size: 8px;
		letter-spacing: 0.05em;
	}

	.reader-menu-wrap {
		position: relative;
	}

	.reader-menu {
		position: absolute;
		top: calc(100% + 7px);
		right: 0;
		z-index: 50;
		display: grid;
		width: 286px;
		padding: 5px;
		border-radius: 7px;
		background: #1b1d23;
		box-shadow: 0 18px 54px rgba(0, 0, 0, 0.48);
	}

	.reader-menu button {
		display: grid;
		min-height: 58px;
		grid-template-columns: 20px 1fr;
		align-items: start;
		gap: 10px;
		padding: 10px;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--muted);
		text-align: left;
	}

	.reader-menu button:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.055);
		color: var(--text);
	}

	.reader-menu button:disabled {
		cursor: not-allowed;
		opacity: 0.4;
	}

	.reader-menu strong,
	.reader-menu small {
		display: block;
	}

	.reader-menu strong {
		color: var(--text-soft);
		font-size: 10px;
		font-weight: 640;
	}

	.reader-menu small {
		margin-top: 3px;
		color: var(--faint);
		font-size: 8px;
		line-height: 1.4;
	}

	.outline-panel,
	.bookmarks-panel {
		display: flex;
		min-width: 0;
		min-height: 0;
		grid-row: 2;
		background: #101115;
		flex-direction: column;
	}

	.outline-panel {
		grid-column: 1;
		border-right: 1px solid var(--line);
	}

	.bookmarks-panel {
		grid-column: 3;
		border-left: 1px solid var(--line);
	}

	.outline-closed .bookmarks-panel {
		grid-column: 2;
	}

	.outline-panel > header,
	.bookmarks-panel > header {
		display: flex;
		min-height: 62px;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 15px;
		border-bottom: 1px solid var(--line);
	}

	.outline-panel header strong,
	.outline-panel header span,
	.bookmarks-panel header strong,
	.bookmarks-panel header span {
		display: block;
	}

	.outline-panel header strong,
	.bookmarks-panel header strong {
		font-size: 12px;
		font-weight: 650;
	}

	.outline-panel header span,
	.bookmarks-panel header span {
		margin-top: 3px;
		color: var(--faint);
		font-size: 10px;
	}

	.outline-panel nav {
		display: grid;
		align-content: start;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 8px;
	}

	.outline-panel nav button {
		display: flex;
		min-width: 0;
		min-height: 42px;
		align-items: center;
		padding: 8px 11px 8px calc(11px + var(--outline-level, 0) * 10px);
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		line-height: 1.25;
		text-align: left;
	}

	.outline-panel nav button span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.outline-panel nav button:hover,
	.outline-panel nav button.active {
		background: rgba(255, 255, 255, 0.04);
		color: var(--text-soft);
	}

	.outline-panel nav button.active {
		background: var(--primary-soft);
		color: var(--text);
		box-shadow: inset 2px 0 var(--primary);
	}

	.outline-panel > footer {
		margin-top: auto;
		padding: 14px 15px;
		border-top: 1px solid var(--line);
	}

	.outline-panel > footer div {
		display: flex;
		justify-content: space-between;
		margin-bottom: 7px;
		color: var(--faint);
		font-size: 8px;
	}

	.outline-panel progress {
		width: 100%;
		height: 3px;
		accent-color: var(--primary);
	}

	.reader-stage {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 0;
		grid-row: 2;
		grid-column: 2;
		overflow: hidden;
		padding: 14px 18px 0;
		background: #0c0d10;
		flex-direction: column;
	}

	.outline-closed .reader-stage {
		grid-column: 1;
	}

	.engine-notice,
	.import-warning {
		display: flex;
		width: min(820px, 100%);
		min-height: 52px;
		align-items: center;
		gap: 11px;
		margin: 0 auto 10px;
		padding: 6px 8px 6px 12px;
		border-left: 2px solid var(--primary);
		background: #15161b;
		flex: 0 0 auto;
	}

	.engine-notice-icon {
		color: var(--primary);
	}

	.engine-notice > div,
	.import-warning span {
		min-width: 0;
		flex: 1;
	}

	.engine-notice strong,
	.engine-notice span {
		display: block;
	}

	.engine-notice strong,
	.import-warning strong {
		font-size: 9px;
		font-weight: 640;
	}

	.engine-notice span,
	.import-warning span {
		margin-top: 3px;
		color: var(--faint);
		font-size: 8px;
	}

	.import-warning {
		border-left-color: var(--bookmark);
		color: var(--bookmark);
	}

	.reading-canvas {
		--reader-ink: #d8d6d0;
		--reader-ink-strong: #f4f1e9;
		--reader-quiet: #8f919b;
		--reader-link: #aaa0f4;
		--reader-rule: rgba(31, 32, 38, 0.14);
		--reader-code-soft: rgba(31, 32, 38, 0.065);
		position: relative;
		width: min(900px, 100%);
		min-height: 0;
		margin: 0 auto;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		padding: 58px clamp(48px, 7vw, 92px) 92px;
		border-radius: 7px 7px 0 0;
		background: var(--reader);
		color: var(--reader-ink);
		font-family: var(--font-reading);
		font-size: clamp(1.04rem, 1vw, 1.16rem);
		font-variation-settings: 'opsz' 20;
		line-height: 1.72;
		flex: 1 1 auto;
	}

	.document-heading {
		max-width: 70ch;
		margin: 0 auto 50px;
		padding-bottom: 28px;
		border-bottom: 1px solid var(--reader-rule);
	}

	.document-heading > span,
	.document-heading > p {
		color: var(--faint);
		font-family: 'Inter Variable', sans-serif;
		font-size: 8px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
	}

	.document-heading h1 {
		max-width: 24ch;
		margin: 13px 0 15px;
		color: var(--reader-ink-strong);
		font-size: clamp(2.15rem, 3.2vw, 3.15rem);
		font-weight: 540;
		letter-spacing: -0.04em;
		line-height: 1.04;
	}

	.document-heading > p {
		margin: 0;
	}

	.document-body {
		max-width: 70ch;
		margin: 0 auto;
	}

	.document-body > p,
	.document-body blockquote,
	.document-list {
		margin: 0 0 1.22em;
	}

	.document-section {
		position: relative;
		margin: 2.75em 0 0.9em;
		scroll-margin-top: 1.5rem;
	}

	.document-section h2,
	.document-section h3,
	.document-section h4,
	.document-section h5,
	.document-section h6 {
		margin: 0;
		color: var(--reader-ink-strong);
		font-weight: 560;
		letter-spacing: -0.025em;
	}

	.document-section h2 {
		font-size: 1.5em;
		line-height: 1.15;
	}

	.document-section h3 {
		font-size: 1.22em;
		line-height: 1.25;
	}

	.document-section h4,
	.document-section h5,
	.document-section h6 {
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.82em;
		font-weight: 690;
		letter-spacing: 0.035em;
		line-height: 1.35;
		text-transform: uppercase;
	}

	.page-anchor {
		display: block;
		margin-bottom: 7px;
		color: var(--faint);
		font-family: 'Inter Variable', sans-serif;
		font-size: 8px;
		font-weight: 650;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.reading-canvas blockquote {
		padding: 0.1em 0 0.1em 1.25em;
		border-left: 2px solid color-mix(in srgb, var(--primary) 68%, transparent);
		color: color-mix(in srgb, var(--reader-ink) 88%, var(--primary));
		font-style: italic;
	}

	.code-block,
	.document-metadata {
		margin: 1.8em 0;
	}

	.code-block {
		position: relative;
	}

	.code-block figcaption {
		position: absolute;
		top: 10px;
		right: 13px;
		z-index: 1;
		color: var(--reader-quiet);
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.58em;
		font-weight: 680;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.code-block pre,
	.document-metadata pre {
		overflow: auto;
		margin: 0;
		padding: 17px 19px;
		border-radius: 5px;
		background: color-mix(in srgb, var(--reader) 88%, #000);
		color: var(--reader-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.66em;
		line-height: 1.55;
	}

	.document-metadata {
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
	}

	.document-metadata summary {
		padding: 10px 0;
		color: var(--reader-quiet);
		cursor: pointer;
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.68em;
		font-weight: 630;
		letter-spacing: 0.04em;
	}

	.document-metadata pre {
		margin-bottom: 12px;
	}

	.document-list {
		padding-left: calc(1.35em + var(--list-depth, 0) * 1.15em);
	}

	.document-list li {
		padding-left: 0.22em;
		margin-bottom: 0.38em;
	}

	.document-list li::marker {
		color: color-mix(in srgb, var(--primary) 72%, var(--reader-ink));
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.78em;
		font-weight: 680;
	}

	.document-list.task-list {
		padding-left: calc(0.1em + var(--list-depth, 0) * 1.15em);
		list-style: none;
	}

	.task-item {
		position: relative;
		padding-left: 1.55em !important;
	}

	.task-marker {
		position: absolute;
		top: 0.44em;
		left: 0;
		display: grid;
		width: 0.95em;
		height: 0.95em;
		place-items: center;
		border: 1px solid color-mix(in srgb, var(--reader-quiet) 58%, transparent);
		border-radius: 0.2em;
		color: var(--primary);
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.72em;
		font-style: normal;
		line-height: 1;
	}

	.table-region {
		overflow-x: auto;
		margin: 2em 0;
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
	}

	.table-region table {
		width: 100%;
		border-collapse: collapse;
		font-family: 'Inter Variable', sans-serif;
		font-size: 0.73em;
		line-height: 1.55;
	}

	.table-region th,
	.table-region td {
		min-width: 8rem;
		padding: 0.75rem 0.8rem;
		border-bottom: 1px solid var(--reader-rule);
		vertical-align: top;
	}

	.table-region th {
		color: var(--reader-ink-strong);
		font-size: 0.88em;
		font-weight: 680;
		letter-spacing: 0.025em;
	}

	.table-region tbody tr:last-child td {
		border-bottom: 0;
	}

	.document-body hr {
		width: 3.5rem;
		height: 1px;
		margin: 3.2em auto;
		border: 0;
		background: var(--reader-rule);
	}

	.document-body p,
	.document-body li,
	.document-body blockquote,
	.table-region td,
	.table-region th {
		overflow-wrap: anywhere;
	}

	.speech-segment {
		position: relative;
		border-radius: 2px;
		transition:
			background 150ms var(--ease),
			box-shadow 150ms var(--ease);
	}

	.speech-segment:hover {
		background: rgba(168, 157, 246, 0.045);
		box-shadow: 0 0 0 3px rgba(168, 157, 246, 0.045);
	}

	.speech-segment:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 4px;
		background: rgba(168, 157, 246, 0.065);
	}

	.selection-start {
		position: absolute;
		z-index: 20;
		display: inline-flex;
		min-height: 34px;
		align-items: center;
		gap: 7px;
		padding: 0 12px;
		border: 1px solid color-mix(in srgb, var(--reader-ink-strong) 70%, transparent);
		border-radius: 999px;
		background: var(--reader-ink-strong);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
		color: var(--reader);
		cursor: pointer;
		font-family: 'Inter Variable', sans-serif;
		font-size: 10px;
		font-weight: 680;
		letter-spacing: 0.01em;
		line-height: 1;
		transform: translate(-50%, -100%);
		white-space: nowrap;
	}

	.selection-start.below {
		transform: translate(-50%, 0);
	}

	.selection-start:hover {
		background: color-mix(in srgb, var(--reader-ink-strong) 88%, var(--primary));
	}

	.speech-segment + .speech-segment::before {
		content: ' ';
	}

	.speech-segment.active {
		background: rgba(168, 157, 246, 0.08);
		box-shadow: 0 0 0 3px rgba(168, 157, 246, 0.08);
		color: #f3f1fb;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		clip-path: inset(50%);
	}

	.return-follow {
		position: absolute;
		right: 28px;
		bottom: 20px;
		z-index: 15;
		min-height: 38px;
		border-color: color-mix(in srgb, var(--primary) 42%, transparent);
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
		color: var(--text);
		backdrop-filter: blur(14px);
	}

	.bookmark-list {
		display: grid;
		align-content: start;
		overflow-y: auto;
		padding: 8px;
	}

	.bookmark-list button {
		display: grid;
		min-height: 60px;
		grid-template-columns: auto 1fr;
		gap: 9px;
		padding: 10px;
		border: 0;
		border-bottom: 1px solid var(--line);
		background: transparent;
		color: var(--bookmark);
		text-align: left;
	}

	.bookmark-list button:hover {
		background: rgba(255, 255, 255, 0.035);
	}

	.bookmark-list strong,
	.bookmark-list small {
		display: block;
	}

	.bookmark-list strong {
		color: var(--text-soft);
		font-family: var(--font-reading);
		font-size: 11px;
		font-weight: 540;
		line-height: 1.35;
	}

	.bookmark-list small {
		margin-top: 4px;
		color: var(--faint);
		font-size: 8px;
	}

	.empty-bookmarks {
		display: grid;
		place-items: center;
		padding: 50px 22px;
		color: var(--faint);
		text-align: center;
	}

	.empty-bookmarks p {
		margin-top: 12px;
		font-size: 9px;
		line-height: 1.5;
	}

	.player-bar {
		position: relative;
		z-index: 35;
		display: grid;
		height: var(--player-height);
		min-width: 0;
		grid-row: 3;
		grid-column: 1 / -1;
		grid-template-columns: minmax(190px, 0.7fr) minmax(390px, 1.5fr) minmax(290px, 336px);
		align-items: center;
		gap: 24px;
		padding: 12px 20px;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface) 96%, black);
		box-shadow: 0 -12px 36px rgba(0, 0, 0, 0.18);
	}

	.now-playing {
		display: grid;
		min-width: 0;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 12px;
		color: var(--primary);
	}

	.now-playing strong,
	.now-playing span {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.now-playing strong {
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 620;
	}

	.now-playing span {
		margin-top: 5px;
		color: var(--faint);
		font-size: 9px;
	}

	.transport {
		display: grid;
		gap: 8px;
	}

	.transport-buttons {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
	}

	.mini-button,
	.seek-button,
	.play-button {
		display: grid;
		place-items: center;
		border: 0;
		background: transparent;
		color: var(--text-soft);
		transition:
			background 150ms var(--ease),
			color 150ms var(--ease),
			transform 150ms var(--ease);
	}

	.mini-button {
		width: 38px;
		height: 38px;
		border-radius: 50%;
	}

	.mini-button:disabled {
		opacity: 0.3;
	}

	.seek-button {
		position: relative;
		width: 40px;
		height: 40px;
		border-radius: 50%;
	}

	.seek-button span {
		position: absolute;
		font-size: 7px;
		font-weight: 750;
	}

	.mini-button:hover:not(:disabled),
	.seek-button:hover {
		background: var(--control-hover);
		color: var(--text);
	}

	.play-button {
		position: relative;
		width: 48px;
		height: 48px;
		margin: 0 6px;
		border-radius: 50%;
		background: var(--text);
		color: var(--primary-ink);
	}

	.play-button:hover {
		background: var(--primary-hover);
		transform: translateY(-1px);
	}

	.play-button.loading::before {
		position: absolute;
		inset: 5px;
		border: 2px solid color-mix(in srgb, var(--primary-ink) 18%, transparent);
		border-top-color: var(--primary-ink);
		border-right-color: var(--primary-ink);
		border-radius: 50%;
		animation: play-progress-spin 850ms linear infinite;
		content: '';
		pointer-events: none;
	}

	.play-button.loading:hover {
		transform: none;
	}

	@keyframes play-progress-spin {
		to {
			transform: rotate(1turn);
		}
	}

	.timeline {
		display: grid;
		grid-template-columns: 42px 1fr 42px;
		align-items: center;
		gap: 10px;
		color: var(--faint);
		font-size: 9px;
		font-variant-numeric: tabular-nums;
	}

	.timeline span:last-child {
		text-align: right;
	}

	.timeline input {
		appearance: none;
		width: 100%;
		height: 20px;
		margin: 0;
		background: transparent;
	}

	.timeline input::-webkit-slider-runnable-track,
	.player-volume input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			var(--primary) 0 var(--timeline-progress, var(--volume-progress, 0%)),
			var(--track) var(--timeline-progress, var(--volume-progress, 0%)) 100%
		);
	}

	.timeline input::-webkit-slider-thumb,
	.player-volume input::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--control-border);
	}

	.timeline input::-moz-range-track,
	.player-volume input::-moz-range-track {
		height: 4px;
		border: 0;
		border-radius: 999px;
		background: var(--track);
	}

	.timeline input::-moz-range-progress,
	.player-volume input::-moz-range-progress {
		height: 4px;
		border-radius: 999px;
		background: var(--primary);
	}

	.timeline input::-moz-range-thumb,
	.player-volume input::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
	}

	.player-options {
		display: flex;
		width: min(100%, 304px);
		min-width: 0;
		align-items: center;
		justify-self: end;
		justify-content: flex-end;
		gap: 10px;
	}

	.player-select {
		position: relative;
		display: flex;
		height: 44px;
		min-width: 0;
		align-items: center;
	}

	.voice-select {
		width: 112px;
	}

	.speed-select {
		width: 62px;
	}

	.select-chevron {
		position: absolute;
		top: 50%;
		right: 6px;
		pointer-events: none;
		transform: translateY(-50%);
	}

	.player-select select {
		appearance: none;
		width: 100%;
		min-width: 0;
		height: 44px;
		padding: 0 24px 0 7px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-soft);
		font-size: 11px;
		font-weight: 580;
		color-scheme: inherit;
	}

	.player-select select:hover {
		background: rgba(255, 255, 255, 0.04);
		color: var(--text);
	}

	.player-select select option {
		background: var(--control-strong);
		color: var(--text);
	}

	.player-volume {
		display: flex;
		min-width: 0;
		width: 110px;
		height: 44px;
		align-items: center;
		gap: 8px;
		padding: 0 3px 0 5px;
		color: var(--muted);
	}

	.player-volume input {
		appearance: none;
		width: 100%;
		height: 20px;
		margin: 0;
		background: transparent;
	}

	.player-volume input {
		--timeline-progress: var(--volume-progress);
	}

	.player-error {
		position: absolute;
		right: 16px;
		bottom: calc(100% + 8px);
		max-width: 420px;
		padding: 10px 12px;
		border-left: 2px solid var(--danger);
		border-radius: 5px;
		background: #28191c;
		color: #ffd0cf;
		font-size: 9px;
	}

	@media (prefers-reduced-motion: reduce) {
		.play-button.loading::before {
			animation: none;
			transform: rotate(45deg);
		}
	}

	@media (max-width: 1180px) {
		.reader-shell,
		.reader-shell.bookmarks-open {
			grid-template-columns: 210px minmax(0, 1fr);
		}

		.reader-shell.outline-closed,
		.reader-shell.outline-closed.bookmarks-open {
			grid-template-columns: minmax(0, 1fr);
		}

		.bookmarks-panel,
		.outline-closed .bookmarks-panel {
			position: absolute;
			top: 54px;
			right: 0;
			bottom: var(--player-height);
			z-index: 32;
			width: 264px;
			border-left: 1px solid var(--line);
			box-shadow: -18px 0 42px rgba(0, 0, 0, 0.34);
		}

		.player-bar {
			grid-template-columns: minmax(320px, 1fr) minmax(290px, 304px);
			gap: 16px;
		}

		.now-playing {
			display: none;
		}
	}

	@media (max-width: 920px) {
		.player-options {
			display: none;
		}

		.player-bar {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (max-width: 820px) {
		.reader-shell,
		.reader-shell.bookmarks-open,
		.reader-shell.outline-closed,
		.reader-shell.outline-closed.bookmarks-open {
			grid-template-columns: minmax(0, 1fr);
		}

		.outline-panel {
			position: absolute;
			top: 54px;
			bottom: var(--player-height);
			left: 0;
			z-index: 32;
			width: 250px;
			box-shadow: 18px 0 42px rgba(0, 0, 0, 0.34);
		}

		.reader-stage,
		.outline-closed .reader-stage {
			grid-column: 1;
		}

		.reading-canvas {
			padding-right: 36px;
			padding-left: 36px;
		}
	}

	@media (max-width: 560px) {
		.reader-title span {
			display: none;
		}

		.reader-stage {
			padding-right: 8px;
			padding-left: 8px;
		}

		.reading-canvas {
			padding: 38px 24px 60px;
		}

		.document-heading h1 {
			font-size: 2rem;
		}
	}
</style>
