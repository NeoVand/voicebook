<script lang="ts">
	import { on } from 'svelte/events';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { NormalizedDocument, SpeechSegment } from '$lib/domain/types';
	import type { PageRect, SegmentPlacement } from '$lib/domain/pdf-layout';
	import { openPdfRenderer } from '$lib/services/pdf-pages';
	import { openPdfLayout } from '$lib/services/pdf-layout';
	import { appearanceState } from '$lib/state/appearance.svelte';
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
		/** The reader scrolled by hand; whatever was following should stop. */
		onManualScroll?: () => void;
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
		onPlaySegment,
		onManualScroll
	}: Props = $props();

	/** US Letter, for a document whose parse recorded no page sizes. */
	const FALLBACK_WIDTH = 612;
	const FALLBACK_HEIGHT = 792;
	/** Pages this far outside the scrollport are drawn ahead of being reached,
	 * and kept a while after leaving, so ordinary scrolling never waits. */
	const PREPARE_MARGIN = '150% 0px';

	let scroller = $state<HTMLElement>();
	/** The page under the middle of the scrollport: what to draw first, and
	 * what to measure distance from when releasing bitmaps. */
	let focusPage = $state(1);
	const canvases = new SvelteMap<number, HTMLCanvasElement>();
	/** Pages near enough the scrollport to be worth drawing. */
	const live = new SvelteSet<number>();
	/** Page → the width its bitmap was drawn for. Only the draw loop and the
	 * memory budget care: layout never does, because the canvas is stretched to
	 * whatever size its sheet is, so a page drawn at another zoom is briefly
	 * soft rather than the wrong size. */
	const drawnWidths = new SvelteMap<number, { width: number; darken: boolean }>();
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

	/** The room the stack has for a page, in CSS pixels. */
	let available = $state(0);

	/**
	 * Paper is white, and a white page is a poor thing to hand someone who has
	 * chosen a dark theme to read in. Under one the page is turned dark at the
	 * point it is drawn — no preference to find or set, because the reader
	 * already said which kind of light they are reading by.
	 */
	let darken = $derived(appearanceState.themeSpec.dark);

	/**
	 * The width a page is drawn at. At 100% a page fits the pane, however
	 * narrow it is — a page you have to scroll sideways to read is not a
	 * readable page. Above 100% it is meant to overflow: that is what zooming
	 * into a figure is for, and the stack scrolls both ways to follow.
	 */
	let renderWidth = $derived.by(() => {
		// The reading view's column width before zoom — the same measure, so the
		// two views feel like one document at one size.
		const column = readerChrome.documentCanvasWidth / readerChrome.documentZoom;
		const fitted = available > 0 ? Math.min(column, available) : column;
		return Math.max(280, fitted) * readerChrome.documentZoom;
	});

	/**
	 * The width to draw at, held still until the reader stops changing it. The
	 * zoom slider reports every percent it passes through, and redrawing on each
	 * would abandon and restart every page fifty times across one drag. Layout
	 * follows `renderWidth` immediately, so the pages resize under the slider
	 * as it moves — a little soft until the redraw lands, which is what a zoom
	 * should feel like.
	 */
	let drawWidth = $state(0);
	const ZOOM_SETTLE_MS = 160;
	/** Plain, not reactive: the settle effect must depend on the width being
	 * asked for, never on the width it last handed over. */
	let widthSeen: number | undefined;

	$effect(() => {
		const width = renderWidth;
		const first = widthSeen === undefined;
		widthSeen = width;
		// The first width is not a zoom — draw at it straight away.
		if (first) {
			drawWidth = width;
			return;
		}
		const settle = setTimeout(() => (drawWidth = width), ZOOM_SETTLE_MS);
		return () => clearTimeout(settle);
	});

	function trackStack(node: HTMLElement) {
		scroller = node;
		const observer = new ResizeObserver(() => {
			const style = getComputedStyle(node);
			available = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
		});
		observer.observe(node);
		let measuring = false;
		const measureFocus = () => {
			if (measuring) return;
			measuring = true;
			requestAnimationFrame(() => {
				measuring = false;
				const middle = node.scrollTop + node.clientHeight / 2;
				let nearest = focusPage;
				let best = Infinity;
				for (const slot of node.querySelectorAll<HTMLElement>('.page-slot')) {
					const distance = Math.abs(slot.offsetTop + slot.offsetHeight / 2 - middle);
					if (distance >= best) continue;
					best = distance;
					nearest = Number(slot.dataset.page);
				}
				if (Number.isFinite(nearest)) focusPage = nearest;
			});
		};
		measureFocus();
		// Reading ahead of the narration wins over following it, the same way it
		// does on the reflowed canvas.
		const stopFollowing = () => {
			owedFollow = undefined;
			onManualScroll?.();
		};
		const removeListeners = [
			on(node, 'scroll', measureFocus, { passive: true }),
			on(node, 'wheel', stopFollowing, { passive: true }),
			on(node, 'touchmove', stopFollowing, { passive: true })
		];
		return () => {
			observer.disconnect();
			for (const removeListener of removeListeners) removeListener();
			if (scroller === node) scroller = undefined;
		};
	}

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
				drawnWidths.delete(page);
			};
		};
	}

	/**
	 * Bitmaps to keep, as a pixel budget rather than a page count: a page at
	 * 200% zoom is four times the memory of the same page at 100%, and on a
	 * retina display four times again — it is the megabytes that take a tab
	 * down, not the number of pages. About 130 MB of canvas, which on a retina
	 * display is still half a dozen pages kept either side of the two or three
	 * actually on screen.
	 */
	const RENDERED_PIXEL_BUDGET = 32_000_000;

	/** Pages being drawn right now: the width each draw is for, and the handle
	 * that abandons it. Deliberately NOT a SvelteMap — the draw loop consults it
	 * but must not be re-run by it, or recording the start of a draw would
	 * restart the effect that started the draw. Every write here is paired with
	 * a reactive one (`drawnWidths`) when the draw actually lands. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const drawing = new Map<
		number,
		{ width: number; darken: boolean; controller: AbortController }
	>();

	function drawnPixels(page: number): number {
		const canvas = canvases.get(page);
		return canvas ? canvas.width * canvas.height : 0;
	}

	/**
	 * Draw the pages that are in play, at the current zoom. Re-runs on zoom
	 * because the bitmap is rendered at the display size, not scaled up from a
	 * smaller one — a PDF page enlarged from a stale raster is a blurry page.
	 *
	 * Three rules keep a heavy page from taking the view down with it, all
	 * learned from one paper with a 163,000-operation vector figure on page 12:
	 * a page already being drawn is never queued again, a page the reader has
	 * left is abandoned mid-draw, and bitmaps are released against a memory
	 * budget instead of the moment a page leaves the scrollport. Without the
	 * last one, scrolling back and forth across that figure re-drew it every
	 * pass; without the first two, those draws piled up in a queue that runs
	 * one at a time, and every other page stopped appearing behind it.
	 */
	$effect(() => {
		const width = drawWidth;
		const dark = darken;
		const pages = new Set(live);
		if (!width) return;

		// Abandon draws nobody is waiting for any more: the reader has scrolled
		// past the page, or has zoomed, which makes the size being drawn wrong.
		for (const [page, draw] of drawing) {
			if (!pages.has(page) || draw.width !== width || draw.darken !== dark) draw.controller.abort();
		}

		// Release bitmaps once they add up to more than the budget, furthest from
		// the reader first. A page in view or mid-draw is never released.
		//
		// Counted over the canvases, not over the pages recorded as drawn: a
		// canvas is sized the moment its draw begins, so an abandoned draw leaves
		// a full-size bitmap behind with nothing recorded against it. Budgeting
		// by the record instead of the pixels let those accumulate unseen — 300 MB
		// of them after a few sweeps of a twenty-page paper on a retina display.
		const rendered = [...canvases.keys()].filter(
			(page) => drawnPixels(page) > 1 && !pages.has(page) && !drawing.has(page)
		);
		let held = [...canvases.keys()].reduce((total, page) => total + drawnPixels(page), 0);
		const focus = focusPage;
		rendered.sort((left, right) => Math.abs(right - focus) - Math.abs(left - focus));
		for (const page of rendered) {
			if (held <= RENDERED_PIXEL_BUDGET) break;
			const canvas = canvases.get(page);
			if (!canvas) continue;
			held -= drawnPixels(page);
			canvas.width = 0;
			canvas.height = 0;
			drawnWidths.delete(page);
		}

		let cancelled = false;
		// Nearest the reader first: draws run one at a time, and a page of dense
		// vector art can hold the queue for seconds. Whoever is waiting should be
		// waiting for the page they are looking at.
		const order = [...pages].sort(
			(left, right) => Math.abs(left - focusPage) - Math.abs(right - focusPage)
		);
		void openPdfRenderer(book).then(async (renderer) => {
			if (!renderer || cancelled) return;
			for (const page of order) {
				if (cancelled) return;
				const canvas = canvases.get(page);
				// Already drawn at this size, or already being drawn: queueing it
				// again would only make the reader wait behind their own request.
				const drawn = drawnWidths.get(page);
				if (!canvas || drawing.has(page) || (drawn?.width === width && drawn.darken === darken)) {
					continue;
				}
				const draw = { width, darken: dark, controller: new AbortController() };
				drawing.set(page, draw);
				try {
					await renderer.renderPage(page, canvas, width, {
						signal: draw.controller.signal,
						darken
					});
					drawnWidths.set(page, { width, darken });
				} catch {
					// Abandoned, or a page that will not draw. The canvas still shows
					// whatever it showed before — the picture was painted off-screen —
					// so there is nothing to clean up but the record.
					drawnWidths.delete(page);
				} finally {
					if (drawing.get(page) === draw) drawing.delete(page);
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
		return renderWidth / pageWidth(page);
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

	/**
	 * Following is edge-triggered: one passage becoming current earns at most
	 * one jump to its page and one settle onto its line, and nothing else moves
	 * the scroll.
	 *
	 * This has to be a debt rather than a plain effect, because the effect's
	 * inputs change constantly for reasons that have nothing to do with the
	 * playhead — every page that finishes placing as the reader scrolls updates
	 * `placements`. Re-running the scroll on those was the bug that made the
	 * document snap back to the playhead each time you tried to read ahead.
	 */
	let owedFollow = $state<string>();
	let jumpedToPage = false;
	let followedLast: string | undefined;
	// Undefined until the first run, so mounting counts as a change and an
	// already-current passage is followed on open.
	let followLast: boolean | undefined;

	$effect(() => {
		// Playback leads; when it is not running, the assistant's fingertip does.
		const followed = activeSegmentId ?? assistantPointId;
		if (followed !== followedLast || follow !== followLast) {
			followedLast = followed;
			followLast = follow;
			// Re-enabling follow owes a scroll too: that is the whole point of the
			// "Follow narration" button.
			owedFollow = follow ? followed : undefined;
			jumpedToPage = false;
		}
	});

	$effect(() => {
		const followed = owedFollow;
		if (!follow || !followed || !scroller) return;
		const page = pageBySegment.get(followed);
		const target = page === undefined ? null : scroller.querySelector(`[data-page="${page}"]`);
		if (page === undefined || !(target instanceof HTMLElement)) {
			// The passage has not been placed yet — its page may not even have
			// been read. Go to where it is anchored, once, and settle onto the
			// line itself if and when the placement arrives.
			if (jumpedToPage) return;
			const anchored = segments.find((segment) => segment.id === followed)?.anchor.page;
			jumpedToPage = true;
			if (anchored) goToPage(anchored);
			return;
		}
		const rect = placements.get(page)?.get(followed)?.rects[0];
		if (!rect) return;
		owedFollow = undefined;
		const scale = pageScale(page);
		const top = target.offsetTop + rect.y * scale;
		const height = rect.height * scale;
		// A passage already comfortably on screen stays put: re-centring every
		// sentence would drag the page under the reader's eyes.
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

<div class="page-stack" class:darkened={darken} {@attach trackStack}>
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
				class:over-passage={hovered?.page === size.page}
				title="Double-click to play from here"
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
		/* `safe` matters once a zoomed page is wider than the pane: plain
		   centring would put its left edge out of reach of the scrollbar. */
		align-items: safe center;
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

	/* The page arrives already dark from the renderer, so the sheet only has to
	   stop being a white rectangle behind it while it draws, and drop the
	   drop-shadow that belonged to paper. */
	.darkened .page-sheet {
		background: #131313;
		box-shadow: none;
	}

	/* Highlights are painted over ink that is now light on dark, so they have to
	   lighten rather than darken to show at all. */
	.darkened .page-marks {
		mix-blend-mode: screen;
	}

	.page-sheet.over-passage {
		cursor: pointer;
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
		background: color-mix(in srgb, var(--primary) 17%, transparent);
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
