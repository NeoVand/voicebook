<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { NormalizedDocument, SpeechSegment } from '$lib/domain/types';
	import type { PageRect, SegmentPlacement } from '$lib/domain/pdf-layout';
	import { openPdfRenderer } from '$lib/services/pdf-pages';
	import { openPdfLayout } from '$lib/services/pdf-layout';
	import { readerChrome } from '$lib/state/reader-chrome.svelte';

	interface Props {
		document: NormalizedDocument;
		pageCount: number;
		/** The live passages — placement is recomputed when these are rebound. */
		segments: SpeechSegment[];
		activeSegmentId?: string;
		activeWordIndex?: number;
		/** Passages carrying a reader highlight or margin note. */
		annotatedSegmentIds?: ReadonlySet<string>;
		/** The stretch the assistant is discussing, and the one sentence inside
		 * it that it is pointing at right now. */
		assistantSegmentIds?: ReadonlySet<string>;
		assistantPointId?: string;
		/** Whether playback should pull the page along with it. */
		follow?: boolean;
		onPlaySegment: (segmentId: string) => void;
	}

	let {
		document: book,
		pageCount,
		segments,
		activeSegmentId,
		activeWordIndex,
		annotatedSegmentIds,
		assistantSegmentIds,
		assistantPointId,
		follow = true,
		onPlaySegment
	}: Props = $props();

	/** US Letter, for a document whose parse recorded no page sizes. */
	const FALLBACK_WIDTH = 612;
	const FALLBACK_HEIGHT = 792;
	/** Pages this far outside the scrollport are drawn ahead of being reached,
	 * and kept a while after leaving, so ordinary scrolling never waits. */
	const PREPARE_MARGIN = '150% 0px';

	let scroller = $state<HTMLElement>();
	const canvases = new SvelteMap<number, HTMLCanvasElement>();
	/** Pages near enough the scrollport to be worth drawing. */
	const live = new SvelteSet<number>();
	/** Page → CSS pixels per PDF point, read back from the rendered canvas so
	 * the overlay follows the bitmap rather than a predicted size. */
	const scales = new SvelteMap<number, number>();
	const placements = new SvelteMap<number, Map<string, SegmentPlacement>>();
	let hovered = $state<{ page: number; segmentId: string }>();

	let sizes = $derived.by(() => {
		const stored = new Map((book.pages ?? []).map((entry) => [entry.page, entry]));
		return Array.from({ length: pageCount }, (_, index) => {
			const page = index + 1;
			const entry = stored.get(page);
			return {
				page,
				width: entry?.width || FALLBACK_WIDTH,
				height: entry?.height || FALLBACK_HEIGHT
			};
		});
	});

	/** The width a page is drawn at, in CSS pixels: the reader's canvas width,
	 * capped so a page never overflows the column it sits in. */
	let renderWidth = $derived(readerChrome.documentCanvasWidth);

	let blockText = $derived(new Map(book.blocks.map((block) => [block.id, block.text])));

	/** Which page each passage was placed on, once its page has been looked at.
	 * Playback drives the highlight, and the passage it names may be anchored
	 * to one page but printed on the next. */
	let pageBySegment = $derived.by(() => {
		const found = new SvelteMap<string, number>();
		for (const [page, placed] of placements) {
			for (const segmentId of placed.keys()) if (!found.has(segmentId)) found.set(segmentId, page);
		}
		return found;
	});

	let activePlacement = $derived.by(() => {
		if (!activeSegmentId) return undefined;
		const page = pageBySegment.get(activeSegmentId);
		return page === undefined ? undefined : placements.get(page)?.get(activeSegmentId);
	});

	let activeWordRect = $derived(
		activeWordIndex === undefined ? undefined : activePlacement?.wordRects[activeWordIndex]
	);

	function trackPage(page: number) {
		return (node: HTMLElement) => {
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) live.add(page);
						else live.delete(page);
					}
				},
				{ root: scroller ?? null, rootMargin: PREPARE_MARGIN }
			);
			observer.observe(node);
			return () => {
				observer.disconnect();
				live.delete(page);
			};
		};
	}

	function trackCanvas(page: number) {
		return (node: HTMLCanvasElement) => {
			canvases.set(page, node);
			return () => {
				canvases.delete(page);
				scales.delete(page);
			};
		};
	}

	// Draw the pages that are in play, at the current zoom. Re-runs on zoom
	// because the bitmap is rendered at the display size, not scaled up from a
	// smaller one — a PDF page enlarged from a stale raster is a blurry page.
	$effect(() => {
		const width = renderWidth;
		const pages = new Set(live);
		// A page that has scrolled well away gives its bitmap back: a long
		// document would otherwise accumulate one full-size raster per page
		// visited, which is where a page view runs out of memory.
		for (const [page, canvas] of canvases) {
			if (pages.has(page) || !scales.has(page)) continue;
			canvas.width = 0;
			canvas.height = 0;
			scales.delete(page);
		}
		let cancelled = false;
		void openPdfRenderer(book).then(async (renderer) => {
			if (!renderer || cancelled) return;
			for (const page of pages) {
				if (cancelled) return;
				const canvas = canvases.get(page);
				if (!canvas || scales.get(page) === width / pageWidth(page)) continue;
				try {
					await renderer.renderPage(page, canvas, width);
					if (!cancelled) scales.set(page, width / pageWidth(page));
				} catch {
					// A page that will not draw stays blank; the rest still read.
				}
			}
		});
		return () => {
			cancelled = true;
		};
	});

	// Place the passages on the pages in play. Independent of drawing: the
	// highlight can arrive after the bitmap, or before it.
	let placedAgainst: SpeechSegment[] | undefined;
	$effect(() => {
		const pages = [...live];
		const currentSegments = segments;
		// Rebinding the passages (a listening-mode switch, a narration swap)
		// mints new segment ids, so everything placed against the old ones is
		// stale — including whatever is mid-flight.
		if (placedAgainst !== currentSegments) {
			placedAgainst = currentSegments;
			placements.clear();
		}
		const layout = openPdfLayout(book);
		let cancelled = false;
		for (const page of pages) {
			if (placements.has(page)) continue;
			void layout.placements(page, pageCount, currentSegments, blockText).then((placed) => {
				if (!cancelled && placedAgainst === currentSegments) placements.set(page, placed);
			});
		}
		return () => {
			cancelled = true;
		};
	});

	function pageWidth(page: number): number {
		return sizes[page - 1]?.width || FALLBACK_WIDTH;
	}

	function pageScale(page: number): number {
		return scales.get(page) ?? renderWidth / pageWidth(page);
	}

	function styleFor(rect: PageRect, page: number): string {
		const scale = pageScale(page);
		return `left:${rect.x * scale}px;top:${rect.y * scale}px;width:${rect.width * scale}px;height:${rect.height * scale}px`;
	}

	type MarkKind = 'annotated' | 'assistant' | 'point' | 'passage' | 'hover';

	/**
	 * Everything to paint over one page, back to front. The reading view puts
	 * these on the same passage as competing backgrounds and lets specificity
	 * decide; here they are separate rectangles, so the order they are emitted
	 * in is what decides — live emphasis last, over persistent ink.
	 */
	function marksFor(page: number, placed?: Map<string, SegmentPlacement>) {
		const marks: Array<{ key: string; kind: MarkKind; rect: PageRect }> = [];
		if (!placed) return marks;
		const add = (kind: MarkKind, segmentId: string) => {
			const rects = placed.get(segmentId)?.rects ?? [];
			rects.forEach((rect, index) =>
				marks.push({ key: `${kind}:${segmentId}:${index}`, kind, rect })
			);
		};
		for (const segmentId of annotatedSegmentIds ?? []) {
			if (segmentId !== activeSegmentId) add('annotated', segmentId);
		}
		for (const segmentId of assistantSegmentIds ?? []) {
			if (segmentId !== activeSegmentId && segmentId !== assistantPointId) {
				add('assistant', segmentId);
			}
		}
		if (assistantPointId && assistantPointId !== activeSegmentId) add('point', assistantPointId);
		if (hovered?.page === page && hovered.segmentId !== activeSegmentId)
			add('hover', hovered.segmentId);
		if (activeSegmentId) add('passage', activeSegmentId);
		return marks;
	}

	/** The passage under a point on a page, in PDF points. Rectangles are
	 * tested with a little vertical slack: line boxes stop at the type's
	 * bounds, and the gap between two lines belongs to one of them. */
	function segmentAt(page: number, x: number, y: number): string | undefined {
		const placed = placements.get(page);
		if (!placed) return undefined;
		for (const [segmentId, placement] of placed) {
			for (const rect of placement.rects) {
				if (
					x >= rect.x &&
					x <= rect.x + rect.width &&
					y >= rect.y - rect.height * 0.25 &&
					y <= rect.y + rect.height * 1.25
				) {
					return segmentId;
				}
			}
		}
		return undefined;
	}

	function pointerPoint(event: PointerEvent | MouseEvent, page: number): { x: number; y: number } {
		const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const scale = pageScale(page);
		return { x: (event.clientX - bounds.left) / scale, y: (event.clientY - bounds.top) / scale };
	}

	function handleHover(event: PointerEvent, page: number): void {
		const { x, y } = pointerPoint(event, page);
		const segmentId = segmentAt(page, x, y);
		if (hovered?.segmentId === segmentId && hovered?.page === page) return;
		hovered = segmentId ? { page, segmentId } : undefined;
	}

	function handleActivate(event: MouseEvent, page: number): void {
		const { x, y } = pointerPoint(event, page);
		const segmentId = segmentAt(page, x, y);
		if (segmentId) onPlaySegment(segmentId);
	}

	/** Bring a page into view by number — the fallback for a passage whose
	 * page has not been placed yet, and what the jump control uses. */
	export function goToPage(page: number): void {
		const element = scroller?.querySelector<HTMLElement>(`[data-page="${page}"]`);
		element?.scrollIntoView({ block: 'start', behavior: 'auto' });
	}

	// Follow playback. A passage already comfortably on screen stays put:
	// re-centring every sentence would drag the page under the reader's eyes.
	$effect(() => {
		if (!follow || !activeSegmentId || !scroller) return;
		const page = pageBySegment.get(activeSegmentId);
		const placement = activePlacement;
		const target = page === undefined ? undefined : scroller.querySelector(`[data-page="${page}"]`);
		if (page === undefined || !(target instanceof HTMLElement)) {
			const anchored = segments.find((segment) => segment.id === activeSegmentId)?.anchor.page;
			if (anchored) goToPage(anchored);
			return;
		}
		const rect = placement?.rects[0];
		if (!rect) return;
		const scale = pageScale(page);
		const top = target.offsetTop + rect.y * scale;
		const height = rect.height * scale;
		const settled = 72;
		const visibleFrom = scroller.scrollTop + settled;
		const visibleTo = scroller.scrollTop + scroller.clientHeight - settled;
		if (top >= visibleFrom && top + height <= visibleTo) return;
		const centered = top - (scroller.clientHeight - height) / 2;
		const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const next = Math.max(0, Math.min(maximum, centered));
		const longJump = Math.abs(next - scroller.scrollTop) > scroller.clientHeight * 1.5;
		scroller.scrollTo({ top: next, behavior: reducedMotion || longJump ? 'auto' : 'smooth' });
	});
</script>

<div class="page-stack" bind:this={scroller}>
	{#each sizes as size (size.page)}
		{@const scale = pageScale(size.page)}
		{@const placed = placements.get(size.page)}
		<div class="page-slot" data-page={size.page} {@attach trackPage(size.page)}>
			<span class="page-number" aria-hidden="true">{size.page}</span>
			<!-- The page is a picture of paper, and the passages on it are
			     reached by pointer; the keyboard route to the same passages is
			     the reading view, which the toolbar switches to. -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="page-sheet"
				style:width={`${size.width * scale}px`}
				style:height={`${size.height * scale}px`}
				ondblclick={(event) => handleActivate(event, size.page)}
				onpointermove={(event) => handleHover(event, size.page)}
				onpointerleave={() => (hovered = undefined)}
			>
				<canvas {@attach trackCanvas(size.page)} aria-label={`Page ${size.page} of ${book.title}`}
				></canvas>
				{#if live.has(size.page)}
					<div class="page-marks" aria-hidden="true">
						{#each marksFor(size.page, placed) as mark (mark.key)}
							<span class="mark {mark.kind}" style={styleFor(mark.rect, size.page)}></span>
						{/each}
						{#if activeWordRect && placed?.has(activeSegmentId ?? '')}
							<span class="mark word" style={styleFor(activeWordRect, size.page)}></span>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/each}
</div>

<style>
	.page-stack {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		gap: 26px;
		overflow: auto;
		padding: calc(var(--app-header-height) + 22px) 20px calc(var(--player-height) + 32px);
		scroll-padding-block: calc(var(--app-header-height) + 22px) calc(var(--player-height) + 32px);
	}

	.page-slot {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.page-number {
		margin-bottom: 6px;
		color: var(--muted);
		font-family: var(--font-ui);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.06em;
	}

	/* The sheet keeps its size before anything is drawn into it, so the
	   scrollbar is honest from the first frame and page jumps land. */
	.page-sheet {
		position: relative;
		border: 1px solid var(--line);
		border-radius: 3px;
		background: white;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
	}

	.page-sheet canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	/* Multiply keeps the marks under the ink: a highlighted line stays as
	   readable as an unhighlighted one, which is the whole point of reading
	   the original. */
	.page-marks {
		position: absolute;
		mix-blend-mode: multiply;
		inset: 0;
	}

	.mark {
		position: absolute;
		border-radius: 2px;
		transition:
			left 90ms var(--ease),
			top 90ms var(--ease),
			width 90ms var(--ease);
	}

	/* Weighted for white paper under a multiply blend, not for the reader's
	   own background — the same mix that reads as a wash in the reading view
	   nearly disappears here. */
	.mark.passage {
		background: color-mix(in srgb, var(--primary) 30%, transparent);
	}

	.mark.hover {
		background: color-mix(in srgb, var(--primary) 12%, transparent);
	}

	/* Persistent reader ink: the same bookmark gold the reading view paints
	   under an annotated passage. */
	.mark.annotated {
		background: color-mix(in srgb, var(--bookmark) 34%, transparent);
	}

	.mark.assistant {
		background: color-mix(in srgb, var(--primary) 14%, transparent);
	}

	.mark.point {
		background: color-mix(in srgb, var(--primary) 30%, transparent);
	}

	.mark.word {
		background: var(--active-word-bg, rgba(112, 176, 143, 0.34));
		box-shadow: 0 0 0 0.1em var(--active-word-bg, rgba(112, 176, 143, 0.34));
	}

	@media (prefers-reduced-motion: reduce) {
		.mark {
			transition: none;
		}
	}
</style>
