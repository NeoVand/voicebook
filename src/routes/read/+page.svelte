<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		ArrowLeft,
		BookOpenText,
		Check,
		ChevronLeft,
		ChevronRight,
		LoaderCircle,
		LocateFixed,
		Pause,
		Play,
		RotateCcw,
		RotateCw,
		Square,
		Volume2
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { on } from 'svelte/events';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import AudioActionsMenu from '$lib/components/AudioActionsMenu.svelte';
	import CompactSelect from '$lib/components/CompactSelect.svelte';
	import CodeBlock from '$lib/components/CodeBlock.svelte';
	import ConstructPanel, { type ConstructPanelItem } from '$lib/components/ConstructPanel.svelte';
	import InlineText from '$lib/components/InlineText.svelte';
	import LlmChip from '$lib/components/LlmChip.svelte';
	import MathFormula from '$lib/components/MathFormula.svelte';
	import MermaidDiagram from '$lib/components/MermaidDiagram.svelte';
	import ModelInstallPrompt from '$lib/components/ModelInstallPrompt.svelte';
	import SafeHtml from '$lib/components/SafeHtml.svelte';
	import VolumeControl from '$lib/components/VolumeControl.svelte';
	import type {
		DocumentBlock,
		InlineRun,
		NormalizedDocument,
		SpeechSegment,
		TableCell
	} from '$lib/domain/types';
	import { tableMarkdown } from '$lib/domain/narration';
	import { appState } from '$lib/state/app-state.svelte';
	import { llmState } from '$lib/state/llm.svelte';
	import { narrationState } from '$lib/state/narrations.svelte';
	import { player } from '$lib/state/player.svelte';
	import { providersState } from '$lib/state/providers.svelte';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';

	let book = $state<NormalizedDocument | null>(null);
	let activeOutlineBlockId = $state<string>();
	let outlineAnnouncement = $state('');
	let readingCanvas = $state<HTMLElement>();
	let scrollbarActive = $state(false);
	let scrollbarTimer: ReturnType<typeof setTimeout> | undefined;
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
	let appReady = $state(false);
	let openDocumentId: string | null = null;
	const playbackSpeedOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((speed) => ({
		value: String(speed),
		label: `${speed}×`
	}));

	let segmentsByBlock = $derived.by(() => {
		const map = new SvelteMap<string, SpeechSegment[]>();
		for (const segment of book?.segments ?? [])
			map.set(segment.blockId, [...(map.get(segment.blockId) ?? []), segment]);
		return map;
	});

	let segmentIndexes = $derived.by(
		() => new SvelteMap((book?.segments ?? []).map((segment, index) => [segment.id, index]))
	);
	let blockIndexes = $derived.by(
		() => new SvelteMap((book?.blocks ?? []).map((block, index) => [block.id, index]))
	);
	let narrationOutlineBlockId = $derived.by(() => {
		const currentBlockId = player.currentSegment?.blockId;
		if (!currentBlockId || !book?.outline.length) return undefined;
		const currentBlockIndex = blockIndexes.get(currentBlockId);
		if (currentBlockIndex === undefined) return undefined;
		let nearestOutlineBlockId: string | undefined;
		for (const item of book.outline) {
			const outlineBlockIndex = blockIndexes.get(item.blockId);
			if (outlineBlockIndex === undefined || outlineBlockIndex > currentBlockIndex) continue;
			nearestOutlineBlockId = item.blockId;
		}
		return nearestOutlineBlockId ?? book.outline[0]?.blockId;
	});
	let activeSegmentId = $derived(
		player.isPlaying || player.position > 0 ? player.currentSegment?.id : undefined
	);
	let activeConstructIds = $derived(
		(activeSegmentId
			? book?.segments.find((segment) => segment.id === activeSegmentId)?.narration?.constructIds
			: undefined) ?? []
	);
	let installed = $derived(appState.installedModels.includes('supertonic-3'));
	let titleBlock = $derived.by(() => {
		return book?.blocks.find((block) => block.kind === 'heading' && block.level === 1);
	});
	let blocksById = $derived.by(
		() => new SvelteMap((book?.blocks ?? []).map((block) => [block.id, block]))
	);
	let rootBlocks = $derived.by(() =>
		(book?.blocks ?? []).filter((block) => !block.parentId && block.id !== titleBlock?.id)
	);

	function childBlocks(block: DocumentBlock): DocumentBlock[] {
		return (block.children ?? [])
			.map((id) => blocksById.get(id))
			.filter((child): child is DocumentBlock => Boolean(child));
	}

	function alertTitle(kind: DocumentBlock['alertKind']): string {
		return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Note';
	}

	onMount(() => {
		player.onSegmentChange = (segmentId) => {
			narrationState.notifyPlayhead(segmentId);
			if (!player.autoFollow || outlineNavigationBlockId) return;
			requestAnimationFrame(() => {
				const element = segmentElements.get(segmentId);
				if (element) scrollNarrationIntoView(element, false);
			});
		};
		void providersState.initialize().then(() => {
			if (providersState.speechEngine === 'elevenlabs')
				void providersState.refreshElevenLabsVoices();
		});
		void appState.initialize().then(() => {
			appReady = true;
		});
		return () => {
			cancelAnimationFrame(readerScrollFrame);
			if (scrollbarTimer) clearTimeout(scrollbarTimer);
			player.onSegmentChange = undefined;
			narrationState.stop();
		};
	});

	// Sidebar links stay on this route and only change ?document, so the open
	// book must follow the URL — a one-shot read on mount misses every switch.
	$effect(() => {
		const id = page.url.searchParams.get('document');
		if (!appReady || id === openDocumentId) return;
		openDocumentId = id;
		openBook(appState.documents.find((document) => document.id === id) ?? null);
	});

	function openBook(next: NormalizedDocument | null): void {
		narrationState.stop();
		narrationStartAction = undefined;
		outlineNavigationBlockId = undefined;
		activeOutlineBlockId = undefined;
		book = next;
		if (!next) return;
		player.setDocument(next);
		activeOutlineBlockId =
			next.outline.find((item) => item.blockId === player.currentSegment?.blockId)?.blockId ??
			next.outline[0]?.blockId;
		void player.warmEngine();
		void narrationState.open(next);
		requestAnimationFrame(() => {
			const element = player.currentSegment
				? segmentElements.get(player.currentSegment.id)
				: undefined;
			if (element) scrollNarrationIntoView(element, false);
			else readingCanvas?.scrollTo({ top: 0 });
			scheduleVisibleSectionUpdate();
		});
	}

	function trackSegment(id: string) {
		return (node: HTMLElement) => {
			segmentElements.set(id, node);
			return () => segmentElements.delete(id);
		};
	}

	// A construct (equation, diagram, table row) registers one element under
	// every narration-chunk id so autoscroll finds it from any chunk.
	function trackConstruct(ids: string[]) {
		return (node: HTMLElement) => {
			for (const id of ids) segmentElements.set(id, node);
			return () => {
				for (const id of ids) {
					if (segmentElements.get(id) === node) segmentElements.delete(id);
				}
			};
		};
	}

	function constructSegments(blockId: string, constructId: string): SpeechSegment[] {
		return (segmentsByBlock.get(blockId) ?? []).filter(
			(segment) => segment.narration?.constructIds[0] === constructId
		);
	}

	/** Rendered pieces reference the FIRST word sharing a display range — a
	 * construct's replacement maps several spoken words onto one span. Route
	 * the live word index to that representative so the whole expression
	 * stays lit for every word of its reading. */
	function displayWordIndex(segment: SpeechSegment, wordIndex: number): number | undefined {
		const active = segment.words[wordIndex];
		if (!active) return undefined;
		const first = segment.words.findIndex(
			(word) => word.start === active.start && word.end === active.end
		);
		return first >= 0 ? first : wordIndex;
	}

	/* ── Construct description panels ─────────────────────────────────────── */

	let llmAvailable = $derived(narrationState.engineAvailable);

	function panelItem(
		blockId: string,
		constructId: string,
		label?: string,
		canRegenerate = true
	): ConstructPanelItem {
		return {
			constructId,
			label,
			spoken:
				constructSegments(blockId, constructId)
					.map((segment) => segment.normalizedText)
					.join(' ') || '—',
			entry: book?.narrations?.[constructId],
			canRegenerate: canRegenerate && llmAvailable && llmState.narrationEnabled,
			regenerating: narrationState.regenerating.has(constructId)
		};
	}

	function tablePanelItems(block: DocumentBlock): ConstructPanelItem[] {
		if (!block.table) return [];
		const rowLabel = (cells: TableCell[], index: number) => {
			const first = cells[0]?.text.replace(/\s+/g, ' ').trim();
			return first ? `Row ${index + 1} — ${first}` : `Row ${index + 1}`;
		};
		return [
			panelItem(block.id, `${block.id}:rh`, 'Header', false),
			...block.table.rows.map((row, index) =>
				panelItem(block.id, `${block.id}:r${index}`, rowLabel(row, index))
			)
		];
	}

	function editConstruct(constructId: string, text: string): void {
		void narrationState.setManualText(constructId, text);
	}

	function regenerateConstruct(constructId: string): void {
		void narrationState.regenerateConstruct(constructId);
	}

	let llmChipVisible = $derived(
		Boolean(player.narrationStage) ||
			narrationState.working ||
			(llmAvailable && Boolean(book && Object.keys(book.narrations ?? {}).length))
	);

	async function toggleDescriptions(value: boolean): Promise<void> {
		await llmState.setNarrationEnabled(value);
		if (book) await narrationState.open(book);
	}

	async function regenerateDocumentDescriptions(): Promise<void> {
		await narrationState.regenerateDocument();
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
		if (compactOutline) readerChrome.outlineOpen = false;

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
		const segmentId = element?.closest<HTMLElement>('[data-segment-id]')?.dataset.segmentId;
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
		// Interactive content inside a construct (the source-and-description
		// panel, expander summaries, edit fields) must not start playback.
		if (
			event.target.closest('a, button, summary, textarea, input, select, label, .construct-panel')
		)
			return;
		const selection = window.getSelection();
		if (selection && !selection.isCollapsed) return;
		const segment = segmentForElement(event.target);
		if (!segment) return;
		void startNarrationFrom(segment);
	}

	function handlePassageKeydown(event: KeyboardEvent): void {
		if (
			!(event.target instanceof HTMLElement) ||
			!event.target.matches('[data-segment-id]') ||
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
		scrollbarActive = true;
		if (scrollbarTimer) clearTimeout(scrollbarTimer);
		scrollbarTimer = setTimeout(() => {
			scrollbarActive = false;
		}, 700);
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

	function handleKeydown(event: KeyboardEvent): void {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.matches('input,textarea,select,button,[data-segment-id]')) return;
		if (event.code === 'Space') {
			event.preventDefault();
			if (player.isBuffering) player.cancelGeneration();
			else void player.toggle();
		} else if (event.key.toLowerCase() === 'j') void player.seekBy(-10);
		else if (event.key.toLowerCase() === 'l') void player.seekBy(10);
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
		title="Play from here"
		data-segment-id={segment.id}
		{@attach trackSegment(segment.id)}
	>
		{#each tokens(block, segment) as inline, inlineIndex (inlineIndex)}
			<InlineText
				run={inline.run}
				pieces={inline.pieces}
				activeWordIndex={isActive ? displayWordIndex(segment, player.currentWordIndex) : undefined}
			/>
		{/each}
	</span>
{/snippet}

{#snippet renderCell(cell: TableCell)}
	{#each cell.inlines as inline, inlineIndex (inlineIndex)}
		<InlineText run={inline} />
	{/each}
{/snippet}

{#snippet renderBlockContent(block: DocumentBlock)}
	{@const blockSegments = segmentsByBlock.get(block.id) ?? []}
	{#if blockSegments.length}
		{#each blockSegments as segment (segment.id)}
			{@render renderSegment(block, segment)}
		{/each}
	{:else}
		{#each block.inlines ?? [] as inline, inlineIndex (inlineIndex)}
			<InlineText run={inline} />
		{/each}
	{/if}
{/snippet}

{#snippet renderBlock(block: DocumentBlock)}
	{@const children = childBlocks(block)}
	{@const pageLabel = block.anchor.page ? `Page ${block.anchor.page}` : ''}
	{#if block.kind === 'list'}
		{#if block.list?.ordered}
			<ol
				class="document-list"
				class:loose={block.list.spread}
				id={block.id}
				start={block.list.start ?? 1}
			>
				{#each children as child (child.id)}
					{@render renderBlock(child)}
				{/each}
			</ol>
		{:else}
			<ul
				class="document-list"
				class:loose={block.list?.spread}
				class:task-list={children.some((child) => child.list?.checked !== undefined)}
				id={block.id}
			>
				{#each children as child (child.id)}
					{@render renderBlock(child)}
				{/each}
			</ul>
		{/if}
	{:else if block.kind === 'list-item'}
		<li id={block.id} class:task-item={block.list?.checked !== undefined}>
			{#if block.list?.checked !== undefined}
				<span class="task-marker" aria-hidden="true">
					{#if block.list.checked}<Check size={11} strokeWidth={2.6} />{/if}
				</span>
				<span class="sr-only">{block.list.checked ? 'Completed: ' : 'Not completed: '}</span>
			{/if}
			{@render renderBlockContent(block)}
			{#each children as child (child.id)}
				{@render renderBlock(child)}
			{/each}
		</li>
	{:else if block.kind === 'heading'}
		<section class="document-section" id={block.id} tabindex="-1">
			{#if pageLabel}<span class="page-anchor">{pageLabel}</span>{/if}
			<svelte:element this={headingTag(block)}>{@render renderBlockContent(block)}</svelte:element>
		</section>
	{:else if block.kind === 'frontmatter'}
		<details class="document-metadata" id={block.id}>
			<summary>Document metadata</summary>
			<pre><code>{block.text}</code></pre>
		</details>
	{:else if block.kind === 'mermaid' || (block.kind === 'code' && block.codeLanguage?.toLowerCase() === 'mermaid')}
		{@const segs = segmentsByBlock.get(block.id) ?? []}
		<div
			class="construct-segment diagram-construct"
			class:active={activeConstructIds.includes(block.id)}
			class:narration-pending={segs[0]?.narration?.pending}
			role="button"
			tabindex="0"
			aria-label={segs.map((segment) => segment.text).join(' ') || 'Diagram'}
			title="Play from here"
			data-segment-id={segs[0]?.id}
			{@attach trackConstruct(segs.map((segment) => segment.id))}
		>
			<MermaidDiagram id={block.id} source={block.text}>
				{#snippet panel()}
					<ConstructPanel
						noun="Diagram"
						sourceLabel="Diagram source"
						sourceLanguage="mermaid"
						source={block.text}
						items={[panelItem(block.id, block.id)]}
						onEdit={editConstruct}
						onRegenerate={regenerateConstruct}
					/>
				{/snippet}
			</MermaidDiagram>
		</div>
	{:else if block.kind === 'code'}
		<CodeBlock id={block.id} source={block.text} language={block.codeLanguage} />
	{:else if block.kind === 'math'}
		{@const segs = segmentsByBlock.get(block.id) ?? []}
		<div
			class="construct-segment math-construct"
			class:active={activeConstructIds.includes(block.id)}
			class:narration-pending={segs[0]?.narration?.pending}
			role="button"
			tabindex="0"
			aria-label={segs.map((segment) => segment.text).join(' ') || 'Equation'}
			title="Play from here"
			data-segment-id={segs[0]?.id}
			{@attach trackConstruct(segs.map((segment) => segment.id))}
		>
			<MathFormula id={block.id} formula={block.text} displayMode>
				{#snippet panel()}
					<ConstructPanel
						noun="Equation"
						sourceLabel="LaTeX source"
						sourceLanguage="latex"
						source={block.text}
						items={[panelItem(block.id, block.id)]}
						onEdit={editConstruct}
						onRegenerate={regenerateConstruct}
					/>
				{/snippet}
			</MathFormula>
		</div>
	{:else if block.kind === 'footnote'}
		<aside
			class="document-footnote"
			id={block.footnoteId ?? block.id}
			aria-label={`Footnote ${block.footnoteLabel}`}
		>
			<span aria-hidden="true">{block.footnoteLabel}</span>
			<div>
				{@render renderBlockContent(block)}
				{#each children as child (child.id)}
					{@render renderBlock(child)}
				{/each}
			</div>
		</aside>
	{:else if block.kind === 'quote'}
		<blockquote id={block.id}>
			{@render renderBlockContent(block)}
			{#each children as child (child.id)}
				{@render renderBlock(child)}
			{/each}
		</blockquote>
	{:else if block.kind === 'alert'}
		<aside
			class={`document-alert ${block.alertKind ?? 'note'}`}
			id={block.id}
			aria-label={`${alertTitle(block.alertKind)} alert`}
		>
			<header>
				<span aria-hidden="true"></span><strong>{alertTitle(block.alertKind)}</strong>
			</header>
			<div>
				{#each children as child (child.id)}
					{@render renderBlock(child)}
				{/each}
			</div>
		</aside>
	{:else if block.kind === 'details'}
		<details class="document-details" id={block.id}>
			<summary>{block.detailsSummary ?? 'Details'}</summary>
			<div>
				{#each children as child (child.id)}
					{@render renderBlock(child)}
				{/each}
			</div>
		</details>
	{:else if block.kind === 'definition-list'}
		<dl class="document-definition-list" id={block.id}>
			{#each children as child (child.id)}
				{@render renderBlock(child)}
			{/each}
		</dl>
	{:else if block.kind === 'definition-term'}
		<dt id={block.id}>{@render renderBlockContent(block)}</dt>
	{:else if block.kind === 'definition-description'}
		<dd id={block.id}>
			{@render renderBlockContent(block)}
			{#each children as child (child.id)}
				{@render renderBlock(child)}
			{/each}
		</dd>
	{:else if block.kind === 'table' && block.table}
		{@const headerSegs = constructSegments(block.id, `${block.id}:rh`)}
		<div class="table-region" id={block.id} role="region" aria-label="Document table">
			<table>
				<thead>
					<tr
						class="construct-row"
						class:active={activeConstructIds.includes(`${block.id}:rh`)}
						tabindex="0"
						title="Play from here"
						data-segment-id={headerSegs[0]?.id}
						{@attach trackConstruct(headerSegs.map((segment) => segment.id))}
					>
						{#each block.table.header as cell, index (index)}
							<th scope="col" style:text-align={block.table.align[index] ?? undefined}>
								{@render renderCell(cell)}
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each block.table.rows as row, rowIndex (rowIndex)}
						{@const rowSegs = constructSegments(block.id, `${block.id}:r${rowIndex}`)}
						<tr
							class="construct-row"
							class:active={activeConstructIds.includes(`${block.id}:r${rowIndex}`)}
							class:narration-pending={rowSegs[0]?.narration?.pending}
							tabindex="0"
							title="Play from here"
							data-segment-id={rowSegs[0]?.id}
							{@attach trackConstruct(rowSegs.map((segment) => segment.id))}
						>
							{#each row as cell, index (index)}
								<td style:text-align={block.table.align[index] ?? undefined}>
									{@render renderCell(cell)}
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
			<ConstructPanel
				noun="Table"
				sourceLabel="Markdown source"
				sourceLanguage="markdown"
				source={tableMarkdown(block.table)}
				items={tablePanelItems(block)}
				onEdit={editConstruct}
				onRegenerate={regenerateConstruct}
			/>
		</div>
	{:else if block.kind === 'divider'}
		<hr id={block.id} />
	{:else if block.kind === 'html'}
		<div class="html-fragment" id={block.id}><SafeHtml nodes={block.html ?? []} /></div>
	{:else}
		<p id={block.id}>{@render renderBlockContent(block)}</p>
	{/if}
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
	<div class="reader-shell" class:outline-closed={!readerChrome.outlineOpen}>
		{#if readerChrome.outlineOpen}
			<aside id="document-outline" class="outline-panel" aria-label="Document outline">
				<header>
					<div class="outline-heading">
						<strong>Contents</strong>
					</div>
					<div class="outline-legend" aria-label="Contents indicators">
						<span><i class="view-key"></i>View</span>
						<span><i class="voice-key"></i>Voice</span>
					</div>
				</header>
				<span class="sr-only" aria-live="polite">{outlineAnnouncement}</span>
				<nav aria-label="Table of contents">
					{#if book.outline.length}
						{#each book.outline as item (item.blockId)}
							{@const outlineBlock = blockFor(item.blockId)}
							<button
								type="button"
								class:scroll-current={activeOutlineBlockId === item.blockId}
								class:narration-current={narrationOutlineBlockId === item.blockId}
								aria-current={activeOutlineBlockId === item.blockId ? 'location' : undefined}
								aria-label={item.title}
								title={item.title}
								data-narration-current={narrationOutlineBlockId === item.blockId
									? 'true'
									: undefined}
								data-level={Math.min(3, item.level)}
								style={'--outline-level:' + Math.max(0, item.level - 1)}
								onclick={() => outlineBlock && navigateToOutlineBlock(outlineBlock)}
							>
								<span class="outline-label">{compactOutlineTitle(item.title)}</span>
								<span class="outline-state" aria-hidden="true">
									{#if narrationOutlineBlockId === item.blockId}
										<span class="narration-indicator"><Volume2 size={12} strokeWidth={2.2} /></span>
									{/if}
								</span>
							</button>
						{/each}
					{:else}
						{#each book.segments.filter((_, index) => index % 8 === 0) as segment (segment.id)}
							<button
								type="button"
								class:narration-current={segment.id === player.currentSegment?.id}
								data-narration-current={segment.id === player.currentSegment?.id
									? 'true'
									: undefined}
								onclick={() => navigateToSegment(segment)}
							>
								<span class="outline-label"
									>{segment.text.slice(0, 54)}{segment.text.length > 54 ? '…' : ''}</span
								>
								<span class="outline-state" aria-hidden="true">
									{#if segment.id === player.currentSegment?.id}
										<span class="narration-indicator"><Volume2 size={12} strokeWidth={2.2} /></span>
									{/if}
								</span>
							</button>
						{/each}
					{/if}
				</nav>
			</aside>
		{/if}

		<section class="reader-stage">
			{#if !installed && !providersState.elevenLabsReady}
				<ModelInstallPrompt compact />
			{/if}

			{#if book.warnings.length}
				<div class="import-warning" role="status">
					<strong>Import note</strong>
					<span>{book.warnings[0]}</span>
				</div>
			{/if}

			<article
				class="reading-canvas"
				class:scrollbar-active={scrollbarActive}
				style:--document-zoom={readerChrome.documentZoom}
				style:--document-canvas-width={`${readerChrome.documentCanvasWidth}px`}
				aria-label={book.title}
				{@attach trackReadingCanvas}
			>
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
					{#each rootBlocks as block (block.id)}
						{#if block.kind === 'list-item'}
							<ul class="document-list legacy-list">{@render renderBlock(block)}</ul>
						{:else}
							{@render renderBlock(block)}
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

		<footer class="player-bar" aria-label="Playback controls">
			<div class="generation-options" role="group" aria-label="Speech generation settings">
				<AudioActionsMenu />
				{#if llmChipVisible}
					<LlmChip
						working={narrationState.working || Boolean(player.narrationStage)}
						paused={narrationState.phase === 'paused-gpu'}
						progress={narrationState.total ? narrationState.done / narrationState.total : 0}
						stageLabel={player.narrationStage}
						enabled={llmState.narrationEnabled}
						onToggleEnabled={toggleDescriptions}
						onRegenerate={regenerateDocumentDescriptions}
					/>
				{/if}
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
							<Square size={14} fill="currentColor" />
						{:else if player.isPlaying}
							<Pause size={18} fill="currentColor" />
						{:else}
							<Play size={18} fill="currentColor" />
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
					<span class="timeline-time">{formatTime(player.progress * player.totalDuration)}</span>
					<div class="timeline-scrubber">
						<div class="timeline-key" aria-hidden="true">
							<span class="cached-key">Cached {Math.round(player.cachedProgress * 100)}%</span>
							<span class="listened-key">Listened {Math.round(player.listenedProgress * 100)}%</span
							>
							{#if player.isGeneratingAll}
								<span class="generating-key">Preparing</span>
							{/if}
							{#if player.hasPendingNarrations}
								<span class="rewriting-key">Rewriting</span>
							{/if}
						</div>
						<div class="timeline-rail" aria-hidden="true">
							{#each player.timelineSegments as segment (segment.id)}
								{#if segment.narrationPending}
									<i
										class="timeline-band narration-pending"
										style:left={`${segment.left * 100}%`}
										style:width={`${segment.width * 100}%`}
									></i>
								{/if}
								{#if segment.cached}
									<i
										class="timeline-band cached"
										style:left={`${segment.left * 100}%`}
										style:width={`${segment.width * 100}%`}
									></i>
								{/if}
								{#if segment.generating}
									<i
										class="timeline-band generating"
										style:left={`${segment.left * 100}%`}
										style:width={`${segment.width * segment.generating * 100}%`}
									></i>
								{/if}
								{#each segment.listened as range (`${range.left}:${range.width}`)}
									<i
										class="timeline-band listened"
										style:left={`${(segment.left + segment.width * range.left) * 100}%`}
										style:width={`${segment.width * range.width * 100}%`}
									></i>
								{/each}
							{/each}
						</div>
						<input
							type="range"
							min="0"
							max="1000"
							value={Math.round(player.progress * 1000)}
							aria-label="Reading position"
							aria-describedby="timeline-coverage-summary"
							onchange={(event) =>
								player.seekToProgress(
									Number((event.currentTarget as HTMLInputElement).value) / 1000
								)}
						/>
					</div>
					<span class="timeline-time end">{formatTime(player.totalDuration)}</span>
					<span id="timeline-coverage-summary" class="sr-only">{player.timelineSummary}</span>
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
				<div class="speed-control">
					<CompactSelect
						label="Playback speed"
						value={String(player.rate)}
						options={playbackSpeedOptions}
						onChange={(value) => player.setRate(Number(value))}
						triggerWidth="58px"
						menuWidth="86px"
						align="end"
					/>
				</div>
				<VolumeControl volume={player.volume} onChange={(volume) => player.setVolume(volume)} />
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
		--player-height: var(--chrome-size);
		position: relative;
		display: grid;
		height: 100%;
		min-height: 0;
		grid-template-columns: 252px minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
		overflow: hidden;
		background: var(--bg);
	}

	.reader-shell.outline-closed {
		grid-template-columns: minmax(0, 1fr);
	}

	.outline-panel {
		display: flex;
		min-width: 0;
		min-height: 0;
		grid-row: 1;
		grid-column: 1;
		background: var(--chrome-surface);
		-webkit-backdrop-filter: var(--chrome-backdrop);
		backdrop-filter: var(--chrome-backdrop);
		flex-direction: column;
		padding-top: var(--app-header-height);
		border-right: 1px solid var(--line);
	}

	.outline-panel > header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 14px;
		min-height: 50px;
	}

	.outline-heading strong {
		display: block;
		font-family: var(--font-display);
		font-size: 15px;
		font-variation-settings: 'opsz' 18;
		font-weight: 680;
		letter-spacing: -0.015em;
	}

	.outline-legend {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--faint);
		font-size: 9px;
	}

	.outline-legend span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		white-space: nowrap;
	}

	.outline-legend i {
		display: block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.outline-legend .view-key {
		border: 1px solid color-mix(in srgb, var(--text) 32%, transparent);
		background: color-mix(in srgb, var(--text) 10%, transparent);
	}

	.outline-legend .voice-key {
		background: var(--primary);
		box-shadow: 0 0 0 2px var(--primary-soft);
	}

	.outline-panel nav {
		display: grid;
		min-height: 0;
		align-content: start;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 7px 0 calc(var(--player-height) + 16px);
		scroll-padding-bottom: calc(var(--player-height) + 16px);
		flex: 1;
	}

	.outline-panel nav button {
		display: grid;
		min-width: 0;
		min-height: 44px;
		grid-template-columns: minmax(0, 1fr) 22px;
		align-items: center;
		gap: 8px;
		padding: 8px 12px 8px calc(13px + var(--outline-level, 0) * 7px);
		border: 0;
		border-radius: 0;
		background: transparent;
		color: var(--muted);
		font-family: var(--font-display);
		font-variation-settings: 'opsz' 18;
		font-size: 13px;
		font-weight: 500;
		line-height: 1.32;
		text-align: left;
		transition:
			background 140ms var(--ease),
			color 140ms var(--ease);
	}

	.outline-panel nav button[data-level='1'] {
		font-size: 13.5px;
		font-weight: 650;
	}

	.outline-panel nav button[data-level='2'] {
		font-size: 12.5px;
		font-weight: 550;
	}

	.outline-panel nav button[data-level='3'] {
		font-size: 12px;
		font-weight: 490;
	}

	.outline-panel .outline-label {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.outline-panel nav button:hover {
		background: var(--hover);
		color: var(--text-soft);
	}

	.outline-panel nav button.scroll-current {
		background: var(--hover-strong);
		color: var(--text);
	}

	.outline-panel nav button.narration-current .outline-label {
		color: var(--primary);
		font-weight: 620;
	}

	.outline-state {
		display: grid;
		width: 22px;
		height: 22px;
		place-items: center;
	}

	.narration-indicator {
		display: grid;
		width: 20px;
		height: 20px;
		place-items: center;
		border-radius: 50%;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.reader-stage {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 0;
		grid-row: 1;
		grid-column: 2;
		overflow: hidden;
		padding: 0;
		background: var(--reader);
		flex-direction: column;
	}

	.outline-closed .reader-stage {
		grid-column: 1;
	}

	.import-warning {
		position: absolute;
		top: calc(var(--app-header-height) + 14px);
		left: 50%;
		z-index: 5;
		display: flex;
		width: min(820px, calc(100% - 36px));
		min-height: 52px;
		align-items: center;
		gap: 11px;
		margin: 0;
		padding: 6px 8px 6px 12px;
		border-left: 2px solid var(--primary);
		background: var(--notice);
		flex: 0 0 auto;
		transform: translateX(-50%);
	}

	.reader-stage:has(> .import-warning) .reading-canvas {
		padding-top: calc(var(--app-header-height) + 112px);
	}

	.import-warning span {
		min-width: 0;
		flex: 1;
	}

	.import-warning strong {
		font-size: 9px;
		font-weight: 640;
	}

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
		position: relative;
		width: 100%;
		min-height: 0;
		margin: 0 auto;
		overflow-y: auto;
		overflow-x: hidden;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		scrollbar-color: transparent transparent;
		padding: calc(var(--app-header-height) + 58px) clamp(48px, 7vw, 92px)
			calc(var(--player-height) + 40px);
		scroll-padding-block: calc(var(--app-header-height) + 70px) calc(var(--player-height) + 32px);
		border-radius: 0;
		background: var(--reader);
		color: var(--reader-ink);
		font-family: var(--font-reading);
		font-size: calc(clamp(1.04rem, 1vw, 1.16rem) * var(--document-zoom, 1));
		font-variation-settings: 'opsz' 20;
		line-height: 1.72;
		flex: 1 1 auto;
	}

	.reading-canvas::-webkit-scrollbar {
		width: 8px;
	}

	.reading-canvas::-webkit-scrollbar-track {
		background: transparent;
	}

	.reading-canvas::-webkit-scrollbar-thumb {
		border: 2px solid transparent;
		border-radius: 999px;
		background: transparent;
		background-clip: padding-box;
	}

	.reading-canvas.scrollbar-active {
		scrollbar-color: var(--reader-scroll-thumb) transparent;
	}

	.reading-canvas.scrollbar-active::-webkit-scrollbar-thumb {
		background: var(--reader-scroll-thumb);
		background-clip: padding-box;
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
		font-family: var(--font-ui);
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
	.document-body > blockquote,
	.document-body > .document-alert,
	.document-body > .document-details,
	.document-body > .document-definition-list,
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
		font-family: var(--font-ui);
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
		font-family: var(--font-ui);
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

	.reading-canvas blockquote > :first-child,
	.document-alert > div > :first-child,
	.document-details > div > :first-child {
		margin-top: 0;
	}

	.reading-canvas blockquote > :last-child,
	.document-alert > div > :last-child,
	.document-details > div > :last-child {
		margin-bottom: 0;
	}

	.document-alert {
		--alert-color: var(--primary);
		margin: 1.6em 0;
		padding: 0.9em 1em 0.95em;
		border-left: 3px solid var(--alert-color);
		background: color-mix(in srgb, var(--alert-color) 7%, transparent);
		font-style: normal;
	}

	.document-alert.tip,
	.document-alert.important {
		--alert-color: var(--success);
	}

	.document-alert.warning {
		--alert-color: var(--bookmark);
	}

	.document-alert.caution {
		--alert-color: var(--danger);
	}

	.document-alert > header {
		display: flex;
		align-items: center;
		gap: 0.55em;
		margin-bottom: 0.55em;
		color: var(--alert-color);
		font-family: var(--font-ui);
		font-size: 0.68em;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.document-alert > header > span {
		width: 0.48em;
		height: 0.48em;
		border-radius: 50%;
		background: currentColor;
	}

	.document-details {
		margin: 1.5em 0;
		border-top: 1px solid var(--reader-rule);
		border-bottom: 1px solid var(--reader-rule);
	}

	.document-details > summary {
		padding: 0.7em 0;
		color: var(--reader-ink-strong);
		cursor: pointer;
		font-family: var(--font-ui);
		font-size: 0.78em;
		font-weight: 650;
	}

	.document-details > div {
		padding: 0.2em 0 1em 1.35em;
	}

	.document-definition-list {
		margin: 1.5em 0;
	}

	.document-definition-list dt {
		margin-top: 1em;
		color: var(--reader-ink-strong);
		font-weight: 650;
	}

	.document-definition-list dd {
		margin: 0.25em 0 0 1.25em;
		padding-left: 1em;
		border-left: 1px solid var(--reader-rule);
		color: var(--reader-quiet);
	}

	.document-footnote {
		display: grid;
		grid-template-columns: 2.2em minmax(0, 1fr);
		gap: 0.7em;
		margin: 1em 0;
		padding-top: 0.85em;
		border-top: 1px solid var(--reader-rule);
		color: var(--reader-quiet);
		font-size: 0.82em;
		scroll-margin-top: calc(var(--app-header-height) + 1rem);
	}

	.document-footnote > span {
		font-family: var(--font-ui);
		font-size: 0.72em;
		font-weight: 700;
	}

	.document-footnote p {
		margin: 0;
	}

	.document-metadata {
		margin: 1.8em 0;
	}

	.document-metadata pre {
		overflow: auto;
		margin: 0;
		padding: 17px 19px;
		border-radius: 5px;
		background: color-mix(in srgb, var(--reader) 94%, var(--text));
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
		font-family: var(--font-ui);
		font-size: 0.68em;
		font-weight: 630;
		letter-spacing: 0.04em;
	}

	.document-metadata pre {
		margin-bottom: 12px;
	}

	.document-list {
		padding-left: 1.35em;
	}

	.document-list li {
		padding-left: 0.22em;
		margin-bottom: 0.38em;
	}

	.document-list .document-list {
		margin: 0.45em 0 0.65em;
	}

	.document-list.loose > li {
		margin-bottom: 0.85em;
	}

	.document-list.loose > li > p {
		margin: 0.35em 0;
	}

	.document-list li::marker {
		color: color-mix(in srgb, var(--primary) 72%, var(--reader-ink));
		font-family: var(--font-ui);
		font-size: 0.78em;
		font-weight: 680;
	}

	.document-list.task-list {
		padding-left: 0.1em;
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
		font-family: var(--font-ui);
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
		font-family: var(--font-ui);
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
		width: 100%;
		height: 1px;
		margin: 3em 0;
		border: 0;
		background: var(--reader-rule);
	}

	.html-fragment {
		margin: 1.35em 0;
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
		background: color-mix(in srgb, var(--primary) 5%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 5%, transparent);
	}

	.speech-segment:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 4px;
		background: color-mix(in srgb, var(--primary) 7%, transparent);
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
		font-family: var(--font-ui);
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
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 9%, transparent);
		color: var(--reader-ink-strong);
	}

	/* Narrated constructs (equations, diagrams) highlight as whole blocks in
	   the same visual language as the sentence highlight. */
	.construct-segment {
		position: relative;
		border-radius: 6px;
		cursor: pointer;
		transition:
			background 150ms var(--ease),
			box-shadow 150ms var(--ease);
	}

	.construct-segment:hover {
		background: color-mix(in srgb, var(--primary) 5%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 5%, transparent);
	}

	.construct-segment:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 4px;
	}

	.construct-segment.active {
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 9%, transparent);
	}

	/* Diagrams get the subtler treatment — a large highlighted area reads
	   louder than an inline sentence. */
	.construct-segment.diagram-construct.active {
		background: color-mix(in srgb, var(--primary) 4%, transparent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 4%, transparent);
	}

	/* Small pulsing dot while an LLM rewrite for the construct is pending. */
	.construct-segment.narration-pending::after,
	tr.construct-row.narration-pending td:last-child::after {
		position: absolute;
		top: 6px;
		right: 6px;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		animation: narration-pending-pulse 2.2s ease-in-out infinite;
		background: var(--primary);
		content: '';
		opacity: 0.4;
	}

	tr.construct-row.narration-pending td:last-child {
		position: relative;
	}

	@keyframes narration-pending-pulse {
		0%,
		100% {
			opacity: 0.18;
		}
		50% {
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.construct-segment.narration-pending::after,
		tr.construct-row.narration-pending td:last-child::after {
			animation: none;
		}
	}

	tr.construct-row {
		cursor: pointer;
		transition: background 150ms var(--ease);
	}

	tr.construct-row:hover {
		background: color-mix(in srgb, var(--primary) 5%, transparent);
	}

	tr.construct-row:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: -2px;
	}

	tr.construct-row.active {
		background: color-mix(in srgb, var(--primary) 9%, transparent);
		box-shadow: inset 2px 0 0 var(--primary);
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
		bottom: calc(var(--player-height) + 16px);
		z-index: 15;
		min-height: 38px;
		border-color: color-mix(in srgb, var(--primary) 42%, transparent);
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		box-shadow: 0 10px 30px rgba(0, 0, 0, 0.38);
		color: var(--text);
		backdrop-filter: blur(14px);
	}

	.player-bar {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 35;
		display: grid;
		height: var(--player-height);
		min-width: 0;
		grid-template-columns: 96px minmax(260px, 1fr) 132px;
		align-items: center;
		gap: 10px;
		padding: 1px 16px 0;
		border-top: 1px solid var(--line);
		background: var(--chrome-surface);
		box-shadow: none;
		-webkit-backdrop-filter: var(--chrome-backdrop);
		backdrop-filter: var(--chrome-backdrop);
		isolation: isolate;
	}

	.generation-options {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 4px;
	}

	.generation-control,
	.speed-control {
		display: contents;
	}

	.transport {
		display: grid;
		min-width: 0;
		grid-template-columns: auto minmax(100px, 1fr);
		align-content: center;
		align-items: center;
		gap: 10px;
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
		width: 32px;
		height: 32px;
		border-radius: 50%;
	}

	.mini-button:disabled {
		opacity: 0.3;
	}

	.seek-button {
		position: relative;
		width: 34px;
		height: 34px;
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
		width: 44px;
		height: 44px;
		margin: 0 4px;
		border-radius: 50%;
		background: transparent;
		color: var(--primary-ink);
	}

	.play-button::after {
		position: absolute;
		inset: 4px;
		z-index: 0;
		border-radius: 50%;
		background: var(--text);
		content: '';
		transition: background 150ms var(--ease);
	}

	.play-button :global(svg) {
		position: relative;
		z-index: 1;
	}

	.play-button:hover::after {
		background: var(--primary-hover);
	}

	.play-button:hover {
		transform: translateY(-1px);
	}

	.play-button.loading::before {
		position: absolute;
		inset: 8px;
		z-index: 2;
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
		grid-template-columns: 34px minmax(60px, 1fr) 34px;
		align-items: center;
		gap: 6px;
		color: var(--faint);
		font-size: 9px;
		font-variant-numeric: tabular-nums;
	}

	.timeline-time.end {
		text-align: right;
	}

	.timeline-scrubber {
		position: relative;
		height: 20px;
		min-width: 0;
	}

	.timeline-rail {
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 6px;
		overflow: hidden;
		border-radius: 999px;
		background: var(--track);
		transform: translateY(-50%);
	}

	.timeline-band {
		position: absolute;
		top: 0;
		bottom: 0;
		min-width: 1px;
	}

	.timeline-band.cached {
		z-index: 1;
		background: var(--timeline-cached, #6f96aa);
	}

	.timeline-band.generating {
		z-index: 2;
		background: repeating-linear-gradient(
			135deg,
			var(--timeline-generating, #e4b86a) 0 4px,
			color-mix(in srgb, var(--timeline-generating, #e4b86a) 54%, transparent) 4px 7px
		);
	}

	.timeline-band.listened {
		z-index: 3;
		background: var(--timeline-listened, #9bc7b0);
	}

	.timeline-band.narration-pending {
		z-index: 0;
		background: repeating-linear-gradient(
			90deg,
			color-mix(in srgb, var(--timeline-generating, #e4b86a) 40%, transparent) 0 3px,
			transparent 3px 6px
		);
	}

	.timeline-key {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		z-index: 5;
		display: flex;
		width: max-content;
		align-items: center;
		gap: 12px;
		padding: 7px 9px;
		border: 1px solid var(--control-border);
		border-radius: 6px;
		background: var(--surface-overlay);
		color: var(--text-soft);
		font-size: 9px;
		font-weight: 560;
		line-height: 1;
		opacity: 0;
		pointer-events: none;
		transform: translate(-50%, 3px);
		transition:
			opacity 150ms var(--ease),
			transform 150ms var(--ease),
			visibility 150ms var(--ease);
		visibility: hidden;
	}

	.timeline-key span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
	}

	.timeline-key span::before {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		background: currentColor;
		content: '';
	}

	.cached-key {
		color: var(--timeline-cached);
	}

	.listened-key {
		color: var(--timeline-listened);
	}

	.generating-key {
		color: var(--timeline-generating);
	}

	.rewriting-key {
		color: color-mix(in srgb, var(--timeline-generating) 62%, var(--text-soft));
	}

	.timeline-scrubber:hover .timeline-key,
	.timeline-scrubber:focus-within .timeline-key {
		opacity: 1;
		transform: translate(-50%, 0);
		visibility: visible;
	}

	.timeline input {
		position: relative;
		z-index: 4;
		appearance: none;
		width: 100%;
		height: 20px;
		margin: 0;
		background: transparent;
	}

	.timeline input::-webkit-slider-runnable-track {
		height: 6px;
		border-radius: 999px;
		background: transparent;
	}

	.timeline input::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
		box-shadow: 0 0 0 1px var(--control-border);
	}

	.timeline input::-moz-range-track {
		height: 6px;
		border: 0;
		border-radius: 999px;
		background: transparent;
	}

	.timeline input::-moz-range-progress {
		height: 6px;
		background: transparent;
	}

	.timeline input::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--text);
	}

	.player-options {
		display: flex;
		min-width: 0;
		align-items: center;
		justify-self: end;
		justify-content: flex-end;
		gap: 4px;
	}

	.player-error {
		position: absolute;
		right: 16px;
		bottom: calc(100% + 8px);
		max-width: 420px;
		padding: 10px 12px;
		border-left: 2px solid var(--danger);
		border-radius: 5px;
		background: var(--danger-surface);
		color: var(--danger-text);
		font-size: 9px;
	}

	@media (prefers-reduced-motion: reduce) {
		.timeline-key {
			transition: none;
		}

		.play-button.loading::before {
			animation: none;
			transform: rotate(45deg);
		}
	}

	@media (max-width: 1180px) {
		.reader-shell {
			grid-template-columns: 210px minmax(0, 1fr);
		}

		.reader-shell.outline-closed {
			grid-template-columns: minmax(0, 1fr);
		}

		.player-bar {
			grid-template-columns: 96px minmax(230px, 1fr) 132px;
			gap: 8px;
			padding-right: 20px;
			padding-left: 20px;
		}
	}

	@media (max-width: 920px) {
		.player-options {
			display: none;
		}

		.player-bar {
			grid-template-columns: 96px minmax(0, 1fr);
		}
	}

	@media (max-width: 820px) {
		.reader-shell,
		.reader-shell.outline-closed {
			grid-template-columns: minmax(0, 1fr);
		}

		.outline-panel {
			position: absolute;
			top: 0;
			bottom: 0;
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

		.mini-button {
			display: none;
		}
	}

	@media (max-width: 560px) {
		.reader-shell {
			--player-height: calc(126px + env(safe-area-inset-bottom));
		}

		.outline-panel {
			display: none;
		}

		.player-bar {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-rows: 78px 44px;
			grid-template-areas:
				'transport transport'
				'generation options';
			gap: 0 6px;
			padding: 2px 12px env(safe-area-inset-bottom);
		}

		.generation-options {
			grid-area: generation;
			gap: 2px;
		}

		.player-options {
			display: flex;
			width: auto;
			grid-area: options;
			gap: 0;
		}

		.transport {
			grid-area: transport;
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: 32px 44px;
			gap: 1px;
		}

		.timeline {
			grid-row: 1;
			grid-template-columns: 30px minmax(60px, 1fr) 30px;
		}

		.transport-buttons {
			grid-row: 2;
		}

		.seek-button {
			width: 40px;
			height: 40px;
		}

		.play-button {
			width: 42px;
			height: 42px;
		}

		.reader-stage {
			padding-right: 8px;
			padding-left: 8px;
		}

		.reading-canvas {
			padding: calc(var(--app-header-height) + 38px) 24px calc(var(--player-height) + 36px);
		}

		.document-heading h1 {
			font-size: 2rem;
		}
	}
</style>
