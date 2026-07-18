import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { completeModelSetup, installFakeTts, openReadyLibrary } from './helpers';

test.beforeEach(async ({ page }) => {
	await installFakeTts(page);
});

test('completes voice setup before presenting the empty-library import surface', async ({
	page
}) => {
	await page.goto('./');
	await expect(page.getByRole('heading', { name: 'Choose how Voicebook reads.' })).toBeVisible();
	const libraryShell = page.locator('.library-page');
	const setupLogo = page.locator('.model-setup .brand-logo');
	await expect(libraryShell).toBeVisible();
	await expect(setupLogo).toBeVisible();
	await expect(setupLogo).not.toHaveClass(/\bactive\b/);
	await expect(page.locator('.setup-mark')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Add document', exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Paste text', exact: true })).toHaveCount(0);
	const setupA11y = await new AxeBuilder({ page }).analyze();
	expect(
		setupA11y.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
	).toEqual([]);
	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsLoadDelayMs: number;
			}
		).__voicebookTtsLoadDelayMs = 180;
	});
	const skipDescriptions = page.getByRole('radio', { name: 'Skip' });
	if (await skipDescriptions.isVisible()) await skipDescriptions.click();
	await page.getByRole('checkbox', { name: /I accept the model licenses/ }).check();
	await page.getByRole('button', { name: /^Download ·/ }).click();
	await expect(setupLogo).toHaveClass(/\bactive\b/);
	await page
		.getByRole('heading', { name: 'Choose how Voicebook reads.' })
		.waitFor({ state: 'hidden' });

	const emptyState = page.getByRole('region', { name: 'What would you like to listen to?' });
	await expect(emptyState).toBeVisible();
	await expect(libraryShell).toBeVisible();
	const emptyLogo = emptyState.locator('.brand-logo');
	await expect(emptyLogo).toBeVisible();
	await expect(emptyLogo).not.toHaveClass(/\bactive\b/);
	await expect(page.getByText('Your library is empty', { exact: true })).toHaveCount(0);
	await expect(page.locator('.import-strip')).toHaveCount(0);

	const addDocument = page.getByRole('button', { name: 'Add document', exact: true });
	const pasteText = page.getByRole('button', { name: 'Paste text', exact: true });
	await expect(addDocument).toHaveCount(1);
	await expect(pasteText).toHaveCount(1);
	const [addBox, pasteBox] = await Promise.all([
		addDocument.boundingBox(),
		pasteText.boundingBox()
	]);
	expect(addBox).not.toBeNull();
	expect(pasteBox).not.toBeNull();
	expect(addBox?.width).toBe(pasteBox?.width);
	expect(addBox?.height).toBe(44);
	expect(pasteBox?.height).toBe(44);
	await expect(emptyState).toHaveCSS('border-top-width', '0px');

	const emptyBeforeDrag = await emptyState.boundingBox();
	await page.locator('.library-page').evaluate((library) => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['A short local document.'], 'local.txt', { type: 'text/plain' }));
		library.dispatchEvent(
			new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer })
		);
	});
	await expect(page.getByText('Drop to add to your library', { exact: true })).toBeVisible();
	expect(await emptyState.boundingBox()).toEqual(emptyBeforeDrag);
	await page.locator('.library-page').dispatchEvent('dragleave');
	await expect(page.getByText('Drop to add to your library', { exact: true })).toHaveCount(0);

	const themeButton = page.getByRole('button', { name: /^Theme:/ });
	// The header button cycles through every theme in order, wrapping around.
	for (const theme of [
		'midnight',
		'forest',
		'cocoa',
		'ocean',
		'aurora',
		'sunny',
		'cloudy',
		'meadow',
		'sakura',
		'rainy'
	]) {
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		await addDocument.hover();
		await expect
			.poll(
				() =>
					addDocument.evaluate((button) => {
						const expected = document.createElement('span');
						expected.style.color = 'var(--primary-ink)';
						expected.style.backgroundColor = 'var(--primary-hover)';
						document.body.append(expected);
						const buttonStyle = getComputedStyle(button);
						const expectedStyle = getComputedStyle(expected);
						const colorsMatch = {
							text: buttonStyle.color === expectedStyle.color,
							background: buttonStyle.backgroundColor === expectedStyle.backgroundColor
						};
						expected.remove();
						return colorsMatch;
					}),
				{ message: `${theme} primary hover should use theme-aware colors` }
			)
			.toEqual({ text: true, background: true });
		await themeButton.click();
	}
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
});

test('keeps the unified welcome flow stable on a phone viewport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('./');
	const setupLogo = page.locator('.model-setup .brand-logo');
	await expect(page.getByRole('heading', { name: 'Choose how Voicebook reads.' })).toBeVisible();
	await expect(setupLogo).toBeVisible();
	const setupLogoBox = await setupLogo.boundingBox();
	expect(setupLogoBox).not.toBeNull();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);

	await completeModelSetup(page);
	// Clicking through the (taller) setup column scrolls the page; the logo
	// parity below is about layout, not leftover scroll.
	await page.evaluate(() => window.scrollTo(0, 0));
	const emptyState = page.getByRole('region', { name: 'What would you like to listen to?' });
	const emptyLogo = emptyState.locator('.brand-logo');
	await expect(emptyLogo).toBeVisible();
	const emptyLogoBox = await emptyLogo.boundingBox();
	expect(emptyLogoBox).not.toBeNull();
	expect(
		Math.abs(
			(setupLogoBox?.x ?? 0) +
				(setupLogoBox?.width ?? 0) / 2 -
				((emptyLogoBox?.x ?? 0) + (emptyLogoBox?.width ?? 0) / 2)
		)
	).toBeLessThanOrEqual(1);
	expect(Math.abs((setupLogoBox?.y ?? 0) - (emptyLogoBox?.y ?? 0))).toBeLessThanOrEqual(1);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);
});

test('keeps the outline and help reachable in the phone reader', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('Pocket outline');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('# First heading\n\nA sentence to read aloud.\n\n## Second heading\n\nMore to hear.');
	await page.getByRole('button', { name: 'Add to library' }).click();

	// The table of contents and the tour must stay reachable on phones; only
	// zoom and fullscreen give way to the narrow command bar.
	const outlineToggle = page.getByRole('button', { name: 'Open document outline' });
	await expect(outlineToggle).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show me around' })).toBeVisible();
	await expect(page.getByRole('button', { name: /Document zoom/ })).toBeHidden();

	await outlineToggle.click();
	const outline = page.locator('#document-outline');
	await expect(outline).toBeVisible();
	await expect(outline.getByRole('button', { name: /Second heading/ })).toBeVisible();
	// The overlay drawer must not widen the page.
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).toBe(true);
});

test('highlights only the document currently open in the reader', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	const title = 'A Quiet Sidebar With a Deliberately Long Document Title';
	await page.getByLabel('Title').fill(title);
	await page.getByRole('textbox', { name: 'Text' }).fill('The active state belongs to the reader.');
	await page.getByRole('button', { name: 'Add to library' }).click();

	const recentDocuments = page.getByRole('navigation', { name: 'Recent documents' });
	const currentDocument = recentDocuments.getByRole('link', { name: title });
	await expect(currentDocument).toHaveAttribute('aria-current', 'page');
	await expect(currentDocument).toHaveClass(/\bactive\b/);
	await expect(currentDocument.locator('svg')).toHaveAttribute('width', '14');
	await expect(currentDocument.locator('svg')).toHaveAttribute('height', '14');
	expect(
		await currentDocument.locator('svg').evaluate((icon) => {
			const bounds = icon.getBoundingClientRect();
			return { width: bounds.width, height: bounds.height };
		})
	).toEqual({ width: 14, height: 14 });

	await page.getByRole('link', { name: 'Voicebook library' }).click();
	await expect(currentDocument).not.toHaveAttribute('aria-current', 'page');
	await expect(currentDocument).not.toHaveClass(/\bactive\b/);
});

test('switches the open reader document from the sidebar library links', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('First document');
	await page.getByRole('textbox', { name: 'Text' }).fill('The first document speaks first.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('article', { name: 'First document' })).toBeVisible();

	await page.getByRole('link', { name: 'Voicebook library' }).click();
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('Second document');
	await page.getByRole('textbox', { name: 'Text' }).fill('The second document takes over.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('article', { name: 'Second document' })).toBeVisible();

	// Same route, different ?document — the reader must swap books in place.
	const recentDocuments = page.getByRole('navigation', { name: 'Recent documents' });
	await recentDocuments.getByRole('link', { name: 'First document' }).click();
	const firstArticle = page.getByRole('article', { name: 'First document' });
	await expect(firstArticle).toBeVisible();
	await expect(firstArticle.getByText('The first document speaks first.')).toBeVisible();
	await expect(recentDocuments.getByRole('link', { name: 'First document' })).toHaveAttribute(
		'aria-current',
		'page'
	);

	await recentDocuments.getByRole('link', { name: 'Second document' }).click();
	await expect(page.getByRole('article', { name: 'Second document' })).toBeVisible();
	await expect(page.getByText('The second document takes over.')).toBeVisible();
});

test('walks through contextual interface tours from the help button', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('Tour stop');
	await page.getByRole('textbox', { name: 'Text' }).fill('A short document for the tour.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('article', { name: 'Tour stop' })).toBeVisible();

	await page.getByRole('button', { name: 'Show me around' }).click();
	const popover = page.locator('.driver-popover');
	await expect(popover).toBeVisible();
	// The tour sweeps the player bar left to right: the wave button leads,
	// then the brain chip when it is on screen, then the transport.
	await expect(popover.locator('.driver-popover-title')).toHaveText('Audio menu');
	await popover.getByRole('button', { name: 'Next' }).click();
	await expect(popover.locator('.driver-popover-title')).toHaveText(/Spoken descriptions|Play/);
	await page.keyboard.press('Escape');
	await expect(popover).toHaveCount(0);

	// The same button gives a different tour per surface.
	await page.goto('./settings/?section=llm');
	await page.getByRole('button', { name: 'Show me around' }).click();
	await expect(page.locator('.driver-popover-title')).toHaveText('Descriptions engine');
	await page.keyboard.press('Escape');
	await expect(page.locator('.driver-popover')).toHaveCount(0);
});

test('detects and renders pasted Markdown as structured document content', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('# Pasted handbook\n\n1. First step\n2. Second step\n\n```ts\nconst local = true;\n```');
	await page.getByRole('button', { name: 'Add to library' }).click();

	const readingCanvas = page.getByRole('article', { name: 'Pasted handbook' });
	await expect(
		readingCanvas.getByRole('heading', { name: 'Pasted handbook', level: 1 })
	).toBeVisible();
	await expect(readingCanvas.locator('ol.document-list')).toContainText('First step');
	await expect(readingCanvas.locator('figure.code-block')).toContainText('const local = true;');
	await expect(readingCanvas).not.toContainText('```ts');
});

test('fills a rolling three-passage buffer while the current passage is playing', async ({
	page
}) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('Continuous listening');
	const passages = [
		'First passage is playing now.',
		'Second passage should be ready next.',
		'Third passage belongs in the rolling buffer.',
		'Fourth passage proves the buffer keeps filling.'
	];
	await page.getByRole('textbox', { name: 'Text' }).fill(passages.join(' '));
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsDelayMs: number;
			}
		).__voicebookTtsDelayMs = 100;
	});

	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(page.locator('.speech-segment.active')).toContainText(passages[0]);
	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__voicebookTtsMessages: Array<{ type: string; text?: string }>;
					}
				).__voicebookTtsMessages
					.filter((message) => message.type === 'synthesize')
					.map((message) => message.text)
			)
		)
		.toEqual(passages);
	await expect(page.locator('.speech-segment.active')).toContainText(passages[0]);
});

test('import → install → play → seek → reload → offline reopen', async ({ page, context }) => {
	await page.goto('./');
	await completeModelSetup(page);
	await expect(
		page.getByRole('region', { name: 'What would you like to listen to?' })
	).toBeVisible();
	const emptyA11y = await new AxeBuilder({ page }).analyze();
	expect(
		emptyA11y.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
	).toEqual([]);

	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('The Quiet Machine');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill(
			'Voicebook reads each sentence clearly. The next sentence creates a useful seek target. A final sentence makes resume behavior visible.'
		);
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page).toHaveURL(/\/voicebook\/read\/?\?document=/);
	await expect(page.getByRole('heading', { name: 'The Quiet Machine' })).toBeVisible();
	// Contents starts closed; these surface checks need the panel open.
	await page.getByRole('button', { name: 'Open document outline' }).click();
	const readerSurfaceColors = () =>
		page.evaluate(() => {
			const header = document.querySelector<HTMLElement>('.app-header');
			const sidebar = document.querySelector<HTMLElement>('.app-sidebar');
			const outline = document.querySelector<HTMLElement>('.outline-panel');
			const playerBar = document.querySelector<HTMLElement>('.player-bar');
			const readerStage = document.querySelector<HTMLElement>('.reader-stage');
			const readingCanvas = document.querySelector<HTMLElement>('.reading-canvas');
			if (!header || !sidebar || !outline || !playerBar || !readerStage || !readingCanvas)
				throw new Error('Reader surfaces are unavailable');
			return {
				chrome: [header, sidebar, outline, playerBar].map(
					(element) => getComputedStyle(element).backgroundColor
				),
				chromeBackdrop: [header, sidebar, outline, playerBar].map((element) => {
					const style = getComputedStyle(element);
					return style.backdropFilter && style.backdropFilter !== 'none'
						? style.backdropFilter
						: style.getPropertyValue('-webkit-backdrop-filter');
				}),
				document: [readerStage, readingCanvas].map(
					(element) => getComputedStyle(element).backgroundColor
				)
			};
		});
	const readerThemeButton = page.getByRole('button', { name: /^Theme:/ });
	// One full lap of the theme cycle keeps every palette's chrome honest.
	for (const theme of [
		'midnight',
		'forest',
		'cocoa',
		'ocean',
		'aurora',
		'sunny',
		'cloudy',
		'meadow',
		'sakura',
		'rainy'
	]) {
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		const surfaces = await readerSurfaceColors();
		expect(new Set(surfaces.chrome).size, `${theme} chrome surfaces should match`).toBe(1);
		expect(surfaces.chrome[0], `${theme} chrome should remain translucent`).toContain('rgba');
		expect(
			surfaces.chromeBackdrop,
			`${theme} chrome surfaces should share the frosted backdrop`
		).toEqual(Array(4).fill('blur(22px) saturate(1.35)'));
		expect(new Set(surfaces.document).size, `${theme} document surfaces should match`).toBe(1);
		await readerThemeButton.click();
	}
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
	await expect(page.getByRole('banner', { name: 'Voicebook header' })).toHaveCount(1);
	await expect(page.locator('.reader-header')).toHaveCount(0);
	await expect(
		page.getByRole('banner', { name: 'Voicebook header' }).getByText('The Quiet Machine')
	).toBeVisible();
	const commandbarTitle = page.locator('.reader-commandbar-title');
	await expect(commandbarTitle.locator('span')).toHaveCount(0);
	const titleAlignment = await commandbarTitle.evaluate((title) => {
		const header = title.closest<HTMLElement>('.app-header');
		if (!header) throw new Error('Application header is unavailable');
		const titleRect = title.getBoundingClientRect();
		const headerRect = header.getBoundingClientRect();
		return Math.abs(titleRect.x + titleRect.width / 2 - (headerRect.x + headerRect.width / 2));
	});
	expect(titleAlignment).toBeLessThan(1);
	await expect(page.getByRole('link', { name: 'Back to library' })).toHaveCount(0);
	const fullscreenButton = page.getByRole('button', { name: 'Enter fullscreen' });
	await expect(fullscreenButton).toBeVisible();
	await expect(page.getByRole('group', { name: 'Document zoom' })).toContainText('100%');
	expect(
		await fullscreenButton.evaluate((button) =>
			button.parentElement?.classList.contains('document-zoom')
		)
	).toBe(true);
	await expect(page.getByRole('link', { name: 'Open Voicebook on GitHub' })).toHaveAttribute(
		'href',
		'https://github.com/NeoVand/voicebook'
	);
	await expect(page.locator('.github-link svg[data-icon="github-outline"]')).toHaveAttribute(
		'fill',
		'none'
	);
	const brandPalette = await page.locator('.brand-logo').evaluate((logo) => {
		const fill = (selector: string) => {
			const element = logo.querySelector<SVGElement>(selector);
			if (!element) throw new Error(`Missing brand layer: ${selector}`);
			return getComputedStyle(element).fill;
		};
		return [fill('.headphones'), fill('.paper'), fill('.wave-bar'), fill('.wave-bar:nth-child(2)')];
	});
	expect(new Set(brandPalette).size).toBe(3);
	const readerTypography = await page.evaluate(() => {
		const title = document.querySelector<HTMLElement>('.reader-commandbar-title strong');
		const outlineItem = document.querySelector<HTMLElement>('.outline-panel nav button');
		if (!title || !outlineItem) throw new Error('Reader typography targets are unavailable');
		const titleStyle = getComputedStyle(title);
		const outlineStyle = getComputedStyle(outlineItem);
		return {
			titleFamily: titleStyle.fontFamily,
			outlineFamily: outlineStyle.fontFamily,
			titleOpticalSize: titleStyle.fontVariationSettings,
			outlineOpticalSize: outlineStyle.fontVariationSettings
		};
	});
	expect(readerTypography.outlineFamily).toBe(readerTypography.titleFamily);
	expect(readerTypography.outlineOpticalSize).toBe(readerTypography.titleOpticalSize);

	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
	// Everything audio lives in the wave button's action menu now.
	await page.getByRole('button', { name: 'Document audio options' }).click();
	await expect(page.getByRole('menuitem', { name: 'Prepare whole document audio' })).toBeEnabled();
	await expect(
		page.getByRole('group', { name: 'Generation quality' }).getByText('10 steps')
	).toBeVisible();
	await page.keyboard.press('Escape');
	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsDelayMs: number;
			}
		).__voicebookTtsDelayMs = 450;
	});
	const timeline = page.locator('.timeline');
	const timelineBeforePlayback = await timeline.boundingBox();
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.locator('.brand-logo.active')).toBeVisible();
	const preparingButton = page.getByRole('button', { name: 'Stop preparing speech' });
	await expect(preparingButton).toHaveAttribute('aria-busy', 'true');
	await expect(timeline).toBeVisible();
	await expect(page.locator('.generation-status')).toHaveCount(0);
	const timelineDuringPreparation = await timeline.boundingBox();
	expect(timelineBeforePlayback).not.toBeNull();
	expect(timelineDuringPreparation).not.toBeNull();
	expect(timelineDuringPreparation?.y).toBe(timelineBeforePlayback?.y);
	expect(timelineDuringPreparation?.height).toBe(timelineBeforePlayback?.height);
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	const activeWord = page.locator('.active-word').first();
	await expect(activeWord).toBeVisible();
	const activeWordStyle = await activeWord.evaluate((word) => {
		const style = getComputedStyle(word);
		return { backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage };
	});
	expect(activeWordStyle.backgroundImage).toBe('none');
	expect(activeWordStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
	const speedSelect = page.getByRole('combobox', { name: 'Playback speed' });
	await speedSelect.click();
	const speedListbox = page.getByRole('listbox', { name: 'Playback speed' });
	await expect(speedListbox).toBeVisible();
	await expect(speedListbox).toHaveCSS('background-color', 'rgb(27, 29, 35)');
	await page.getByRole('option', { name: '1.5×', exact: true }).click();
	await expect(speedSelect).toContainText('1.5×');
	const synthesisRequest = await page.evaluate(() =>
		(
			window as unknown as {
				__voicebookTtsMessages: Array<{ type: string; totalSteps?: number }>;
			}
		).__voicebookTtsMessages.find((message) => message.type === 'synthesize')
	);
	expect(synthesisRequest?.totalSteps).toBe(10);
	await page.getByRole('button', { name: 'Forward 10 seconds' }).click();

	await page.reload();
	await expect(page.getByRole('heading', { name: 'The Quiet Machine' })).toBeVisible();
	await page.getByRole('button', { name: 'Open document outline' }).click();
	const readerA11y = await new AxeBuilder({ page }).analyze();
	expect(
		readerA11y.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
	).toEqual([]);

	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'The Quiet Machine' })).toBeVisible();
	await context.setOffline(false);
});

test('whole-document preparation fills cache coverage and preserves read-along timing', async ({
	page
}) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Prepared Without Pressure');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill(
			'First passage keeps its word timing. Second passage is cached without decoding. Third passage confirms the preparation state. Fourth passage keeps the queue moving. Fifth passage follows the new playhead. Sixth passage completes the wrapped preparation.'
		);
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsDelayMs: number;
			}
		).__voicebookTtsDelayMs = 120;
	});

	const audioMenuTrigger = page.getByRole('button', { name: 'Document audio options' });
	await audioMenuTrigger.click();
	await page.getByRole('menuitem', { name: 'Prepare whole document audio' }).click();
	await expect(audioMenuTrigger).toHaveAttribute('aria-busy', 'true');
	await expect(page.locator('.timeline-band.generating').first()).toBeVisible();
	await expect(page.locator('.timeline-band.generating').first()).not.toHaveCSS(
		'background-image',
		'none'
	);
	await expect(page.locator('.timeline-band.cached')).toHaveCount(6);
	await expect(audioMenuTrigger).toHaveAttribute('aria-busy', 'false');
	await audioMenuTrigger.click();
	const ready = page.getByRole('menuitem', { name: 'Whole document audio is ready' });
	await expect(ready).toBeVisible();
	await expect(ready).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(page.locator('.timeline-band.cached').first()).not.toHaveCSS(
		'background-color',
		'rgba(0, 0, 0, 0)'
	);
	await expect(page.locator('#timeline-coverage-summary')).toContainText('100% audio cached');

	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(page.locator('.active-word').first()).toBeVisible();
	await expect(page.locator('.timeline-band.listened').first()).toBeVisible();
	await expect(page.locator('.timeline-band.listened').first()).not.toHaveCSS(
		'background-color',
		'rgba(0, 0, 0, 0)'
	);
	await expect(page.locator('#timeline-coverage-summary')).not.toContainText('0% listened');

	await page.getByRole('button', { name: 'Document audio options' }).click();
	await page.getByRole('menuitem', { name: 'Clear cached audio This document' }).click();
	await expect(page.locator('.timeline-band.cached')).toHaveCount(0);
	await expect(page.locator('.timeline-band.listened')).toHaveCount(0);
	await expect(page.locator('#timeline-coverage-summary')).toContainText('0% audio cached');
	await expect(page.locator('#timeline-coverage-summary')).toContainText('0% listened');
	await audioMenuTrigger.click();
	await expect(page.getByRole('menuitem', { name: 'Prepare whole document audio' })).toBeEnabled();
	await page.keyboard.press('Escape');

	await page.reload();
	await expect(page.getByRole('heading', { name: 'Prepared Without Pressure' })).toBeVisible();
	await expect(page.locator('#timeline-coverage-summary')).toContainText('0% audio cached');
	await expect(page.locator('#timeline-coverage-summary')).toContainText('0% listened');

	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsDelayMs: number;
			}
		).__voicebookTtsDelayMs = 600;
	});
	await page.getByRole('button', { name: 'Document audio options' }).click();
	await page.getByRole('menuitem', { name: 'Prepare whole document audio' }).click();
	await expect(page.locator('.timeline-band.generating').first()).toBeVisible();
	await page.getByRole('button', { name: 'Next passage' }).click();
	await page.getByRole('button', { name: 'Next passage' }).click();
	await page.getByRole('button', { name: 'Next passage' }).click();
	await page.getByRole('button', { name: 'Next passage' }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as {
						__voicebookTtsMessages: Array<{ type: string; text?: string }>;
					}
				).__voicebookTtsMessages
					.filter((message) => message.type === 'synthesize')
					.slice(1, 3)
					.map((message) => message.text)
			)
		)
		.toEqual([
			'Fifth passage follows the new playhead.',
			'Sixth passage completes the wrapped preparation.'
		]);
	await expect(page.locator('.timeline-band.cached')).toHaveCount(6);
	await expect(page.getByRole('button', { name: 'Document audio options' })).toHaveAttribute(
		'aria-busy',
		'false'
	);
	await page.getByRole('button', { name: 'Document audio options' }).click();
	await expect(
		page.getByRole('menuitem', { name: 'Whole document audio is ready' })
	).toBeDisabled();
	const downloadItem = page.getByRole('menuitem', { name: 'Download MP3 Whole document' });
	await expect(downloadItem).toBeEnabled();
	const downloadPromise = page.waitForEvent('download');
	await downloadItem.click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toBe('Prepared Without Pressure.mp3');
	expect(await download.failure()).toBeNull();

	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.locator('.timeline-band.listened').first()).toBeVisible();
	await expect(page.locator('#timeline-coverage-summary')).not.toContainText('0% listened');
});

test('keeps the phone reader focused on content and a compact transport', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Pocket reader');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('The phone reader keeps the document and essential playback controls in view.');
	await page.getByRole('button', { name: 'Add to library' }).click();

	await expect(page.getByRole('complementary', { name: 'Document outline' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Close document outline' })).toBeHidden();
	await expect(page.getByRole('group', { name: 'Document zoom' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeHidden();
	await expect(page.getByRole('group', { name: 'Speech generation settings' })).toBeVisible();
	await expect(page.getByRole('group', { name: 'Playback settings' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Back 10 seconds' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Forward 10 seconds' })).toBeVisible();
	await expect(page.getByRole('slider', { name: 'Reading position' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Playback speed' })).toBeVisible();
	const volumeButton = page.getByRole('button', { name: /Volume 90 percent/ });
	await expect(volumeButton).toBeVisible();
	await volumeButton.click();
	const volumeSlider = page.getByRole('slider', { name: 'Volume' });
	await expect(volumeSlider).toBeVisible();
	expect(await volumeSlider.evaluate((slider) => getComputedStyle(slider).writingMode)).toContain(
		'vertical'
	);
	await page.getByRole('button', { name: 'Document audio options' }).click();
	await expect(page.getByRole('group', { name: 'Voice' })).toBeVisible();
	await expect(page.getByRole('group', { name: 'Generation quality' })).toBeVisible();
	await expect(page.getByRole('menuitemradio', { name: '10', exact: true })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await expect(page.getByRole('menuitem', { name: 'Prepare whole document audio' })).toBeVisible();
	await page.getByRole('button', { name: 'Document audio options' }).click();

	await page.getByRole('button', { name: 'Open navigation' }).click();
	await expect(page.getByRole('complementary', { name: 'Voicebook navigation' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Library', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Voice', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'LLM', exact: true })).toBeVisible();
	await expect(page.getByRole('link', { name: 'System', exact: true })).toBeVisible();
	await page
		.getByRole('banner', { name: 'Voicebook header' })
		.getByRole('button', { name: 'Close navigation' })
		.click();

	const geometry = await page.locator('.player-bar').evaluate((playerBar) => {
		const reader = document.querySelector<HTMLElement>('.reader-stage');
		const bounds = playerBar.getBoundingClientRect();
		return {
			playerWidth: bounds.width,
			playerHeight: bounds.height,
			readerWidth: reader?.getBoundingClientRect().width
		};
	});
	expect(geometry).toEqual({ playerWidth: 390, playerHeight: 126, readerWidth: 390 });
});

test('keeps the desktop player settings inside the playback dock', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Player spacing check');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('The playback dock should remain compact, aligned, and fully visible.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('heading', { name: 'Player spacing check' })).toBeVisible();
	await page.getByRole('button', { name: 'Open document outline' }).click();
	await page.getByRole('button', { name: 'Collapse sidebar' }).click();
	await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

	for (const width of [1024, 1280, 1440]) {
		await page.setViewportSize({ width, height: 800 });
		const geometry = await page.locator('.player-options').evaluate((options) => {
			const player = options.closest<HTMLElement>('.player-bar');
			const shell = player?.closest<HTMLElement>('.reader-shell');
			const header = document.querySelector<HTMLElement>('.app-header');
			const sidebar = document.querySelector<HTMLElement>('.app-sidebar');
			const stage = shell?.querySelector<HTMLElement>('.reader-stage');
			const outline = shell?.querySelector<HTMLElement>('.outline-panel');
			const volume = options.querySelector<HTMLElement>('.volume-control');
			const generation = player?.querySelector<HTMLElement>('.generation-options');
			const transport = player?.querySelector<HTMLElement>('.transport');
			const playButton = player?.querySelector<HTMLElement>('.play-button');
			if (
				!player ||
				!shell ||
				!header ||
				!sidebar ||
				!stage ||
				!outline ||
				!volume ||
				!generation ||
				!transport ||
				!playButton
			)
				throw new Error('Player settings geometry is unavailable');

			const playerRect = player.getBoundingClientRect();
			const shellRect = shell.getBoundingClientRect();
			const headerRect = header.getBoundingClientRect();
			const sidebarRect = sidebar.getBoundingClientRect();
			const stageRect = stage.getBoundingClientRect();
			const outlineRect = outline.getBoundingClientRect();
			const optionsRect = options.getBoundingClientRect();
			const volumeRect = volume.getBoundingClientRect();
			const generationRect = generation.getBoundingClientRect();
			const transportRect = transport.getBoundingClientRect();
			const playButtonRect = playButton.getBoundingClientRect();
			const playVisualStyle = getComputedStyle(playButton, '::after');
			const playerStyle = getComputedStyle(player);

			return {
				documentOverflow:
					document.documentElement.scrollWidth - document.documentElement.clientWidth,
				optionsOverflow: Math.max(0, options.scrollWidth - options.clientWidth),
				playerOverflow: Math.max(0, player.scrollWidth - player.clientWidth),
				playerRightInset: playerRect.right - optionsRect.right,
				volumeRightInset: playerRect.right - volumeRect.right,
				flushBottom: Math.abs(playerRect.bottom - shellRect.bottom) < 1,
				fullWidth:
					Math.abs(playerRect.left - shellRect.left) < 1 &&
					Math.abs(playerRect.right - shellRect.right) < 1,
				contentUnderlay:
					Math.abs(stageRect.bottom - shellRect.bottom) < 1 &&
					Math.abs(outlineRect.bottom - shellRect.bottom) < 1,
				position: playerStyle.position,
				backdropFilter:
					playerStyle.backdropFilter !== 'none'
						? playerStyle.backdropFilter
						: playerStyle.getPropertyValue('-webkit-backdrop-filter'),
				boxShadow: playerStyle.boxShadow,
				chromeThickness: {
					header: headerRect.height,
					sidebar: sidebarRect.width,
					player: playerRect.height
				},
				playControl: {
					target: playButtonRect.width,
					visual: Number.parseFloat(playVisualStyle.width)
				},
				singleLine:
					Math.abs(
						generationRect.y +
							generationRect.height / 2 -
							(transportRect.y + transportRect.height / 2)
					) < 1 &&
					Math.abs(
						transportRect.y + transportRect.height / 2 - (optionsRect.y + optionsRect.height / 2)
					) < 1
			};
		});

		expect(geometry.documentOverflow, `${width}px document overflow`).toBe(0);
		expect(geometry.optionsOverflow, `${width}px settings overflow`).toBe(0);
		expect(geometry.playerOverflow, `${width}px player overflow`).toBe(0);
		expect(geometry.playerRightInset, `${width}px settings right inset`).toBeGreaterThanOrEqual(15);
		expect(geometry.volumeRightInset, `${width}px volume right inset`).toBeGreaterThanOrEqual(15);
		expect(geometry.flushBottom, `${width}px player is flush with the shell bottom`).toBe(true);
		expect(geometry.fullWidth, `${width}px player spans the reader shell`).toBe(true);
		expect(geometry.contentUnderlay, `${width}px reader content continues below the player`).toBe(
			true
		);
		expect(geometry.position, `${width}px player overlays the reader`).toBe('absolute');
		expect(geometry.backdropFilter, `${width}px player uses frosted glass`).toContain('blur(22px)');
		expect(geometry.boxShadow, `${width}px player has no drop shadow`).toBe('none');
		expect(geometry.chromeThickness, `${width}px chrome uses one 52px rhythm`).toEqual({
			header: 52,
			sidebar: 52,
			player: 52
		});
		expect(geometry.playControl, `${width}px play target and visual circle`).toEqual({
			target: 44,
			visual: 36
		});
		expect(geometry.singleLine, `${width}px player controls use one line`).toBe(true);
	}

	const audioTrigger = page.getByRole('button', { name: 'Document audio options' });
	await audioTrigger.click();
	await page.getByRole('menuitemradio', { name: '14', exact: true }).click();
	await expect(
		page.getByRole('group', { name: 'Generation quality' }).getByText('14 steps')
	).toBeVisible();
	await page.keyboard.press('Escape');
	await page.reload();
	await audioTrigger.click();
	await expect(
		page.getByRole('group', { name: 'Generation quality' }).getByText('14 steps')
	).toBeVisible();
});

test('collapses and remembers the desktop sidebar', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await openReadyLibrary(page);
	await expect(page.getByText('Supertonic 3', { exact: true })).toHaveCount(0);

	const header = page.getByRole('banner', { name: 'Voicebook header' });
	await expect(header.getByRole('link', { name: 'Voicebook library' })).toBeVisible();
	const sidebar = page.getByRole('complementary', { name: 'Voicebook navigation' });
	const headerBox = await header.boundingBox();
	const sidebarBox = await sidebar.boundingBox();
	const collapseBox = await page.getByRole('button', { name: 'Collapse sidebar' }).boundingBox();
	const libraryLink = sidebar.getByRole('link', { name: 'Library' });
	await expect(libraryLink).toBeVisible();
	await expect(libraryLink.locator('span')).toHaveText('Library');
	const libraryBox = await libraryLink.boundingBox();
	await expect(sidebar.getByText('Local only', { exact: true })).toHaveCount(0);
	expect(headerBox).not.toBeNull();
	expect(sidebarBox).not.toBeNull();
	expect(collapseBox).not.toBeNull();
	expect(libraryBox).not.toBeNull();
	expect(sidebarBox?.y).toBeGreaterThanOrEqual((headerBox?.y ?? 0) + (headerBox?.height ?? 0) - 1);
	expect(collapseBox?.y).toBeLessThan((sidebarBox?.y ?? 0) + 52);
	expect(libraryBox?.x).toBeLessThan(collapseBox?.x ?? 0);
	expect(
		(sidebarBox?.x ?? 0) +
			(sidebarBox?.width ?? 0) -
			((collapseBox?.x ?? 0) + (collapseBox?.width ?? 0))
	).toBeLessThanOrEqual(9);
	const expandedWidth = (await sidebar.boundingBox())?.width ?? 0;
	await page.getByRole('button', { name: 'Collapse sidebar' }).click();
	await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
	await expect(libraryLink.locator('span')).toBeHidden();
	await expect(header.getByRole('link', { name: 'Voicebook library' })).toBeVisible();
	await expect(header.locator('.brand > span:last-child')).toHaveText('Voicebook');
	await expect(header.locator('.brand > span:last-child')).toBeVisible();
	const collapsedWidth = (await sidebar.boundingBox())?.width ?? 0;
	expect(collapsedWidth).toBeLessThan(expandedWidth);

	await page.reload();
	await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
	await expect(sidebar).toHaveCSS('width', '52px');
	await page.getByRole('button', { name: 'Expand sidebar' }).click();
	await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

	const themeButton = page.getByRole('button', { name: /^Theme:/ });
	await expect(themeButton).toHaveAccessibleName('Theme: Midnight. Switch to Forest theme');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'forest');
	await expect(themeButton).toHaveAccessibleName('Theme: Forest. Switch to Cocoa theme');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'cocoa');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'ocean');
	await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveAccessibleName(
		'Theme: Ocean. Switch to Aurora theme'
	);
	await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Open Voicebook on GitHub' })).toHaveAttribute(
		'href',
		'https://github.com/NeoVand/voicebook'
	);
});

test('starts narration from a chosen passage or selected word', async ({ page }) => {
	await openReadyLibrary(page);
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Choose a passage');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill(
			'The opening passage should remain untouched. The second passage begins gently. The third passage is the chosen starting point.'
		);
	await page.getByRole('button', { name: 'Add to library' }).click();

	const thirdPassage = page.locator('.speech-segment').filter({
		hasText: 'The third passage is the chosen starting point.'
	});
	await thirdPassage.click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(page.locator('.speech-segment.active')).toContainText(
		'The third passage is the chosen starting point.'
	);

	const firstSynthesis = await page.evaluate(() => {
		const messages = (
			window as unknown as {
				__voicebookTtsMessages: Array<{ type: string; text?: string }>;
			}
		).__voicebookTtsMessages;
		return messages.find((message) => message.type === 'synthesize')?.text;
	});
	expect(firstSynthesis).toBe('The third passage is the chosen starting point.');
	await page.getByRole('button', { name: 'Pause' }).click();

	const openingPassage = page.locator('.speech-segment').filter({
		hasText: 'The opening passage should remain untouched.'
	});
	await openingPassage.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.speech-segment.active')).toContainText(
		'The opening passage should remain untouched.'
	);
	await page.getByRole('button', { name: 'Pause' }).click();

	const selectedWord = page.locator('.spoken-word').filter({ hasText: /^begins$/ });
	await selectedWord.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('begins');
	const playSelection = page.getByRole('button', {
		name: 'Play the selected text: begins'
	});
	await expect(playSelection).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Explain the selected text: begins' })
	).toBeVisible();
	await playSelection.click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	await expect(page.locator('.speech-segment.active')).toContainText(
		'The second passage begins gently.'
	);

	// Reading a selection stops at its end instead of rolling on: the fake
	// passage lasts one second, then the transport returns to Play with the
	// selected passage still current.
	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await expect(page.locator('.speech-segment.active')).toContainText(
		'The second passage begins gently.'
	);

	const synthesisOrder = await page.evaluate(() =>
		(
			window as unknown as {
				__voicebookTtsMessages: Array<{ type: string; text?: string }>;
			}
		).__voicebookTtsMessages
			.filter((message) => message.type === 'synthesize')
			.map((message) => message.text)
	);
	expect(synthesisOrder.slice(0, 3)).toEqual([
		'The third passage is the chosen starting point.',
		'The opening passage should remain untouched.',
		'The second passage begins gently.'
	]);

	// The Explain flow opens its floating box from the same selection popover;
	// without any description engine configured it reports that instead of
	// silently doing nothing.
	const explainWord = page.locator('.spoken-word').filter({ hasText: /^gently$/ });
	await explainWord.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
		element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
	});
	await page.getByRole('button', { name: 'Explain the selected text: gently' }).click();
	const explainDialog = page.getByRole('dialog', { name: 'Explain the selected passage' });
	await expect(explainDialog).toBeVisible();
	await explainDialog.getByRole('textbox').fill('What does gently mean here?');
	await explainDialog.getByRole('button', { name: 'Explain aloud' }).click();
	await expect(explainDialog.getByRole('alert')).toContainText('No description engine');
	await page.keyboard.press('Escape');
	await expect(explainDialog).toHaveCount(0);
});

test('detects duplicate file imports and keeps navigation under the Pages base path', async ({
	page
}) => {
	await openReadyLibrary(page);
	const input = page.locator('#document-upload');
	await input.setInputFiles({
		name: 'repeat.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('A repeatable local document.')
	});
	await expect(page).toHaveURL(/\/voicebook\/read\/?\?document=/);
	await page.getByRole('link', { name: 'Voicebook library' }).click();
	await input.setInputFiles({
		name: 'repeat.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('A repeatable local document.')
	});
	await expect(page.getByRole('dialog', { name: 'Already in your library' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep copy' }).click();
	await expect(page.getByRole('link', { name: 'Open repeat — Copy' })).toBeVisible();
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await expect(page).toHaveURL(/\/voicebook\/settings\/?$/);
});

test('keeps Supertonic license acceptance and its visible checkbox in sync', async ({ page }) => {
	await page.goto('./');
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Supertonic 3' })).toBeVisible();
	const acceptance = page.getByRole('checkbox', { name: 'I have reviewed the terms' });
	const install = page.getByRole('button', { name: 'Install locally' });
	await expect(acceptance).not.toBeChecked();
	await expect(install).toBeDisabled();
	await acceptance.check();
	await expect(acceptance).toBeChecked();
	await expect(install).toBeEnabled();
});

test('previews and selects built-in voices without loading another engine', async ({ page }) => {
	await page.goto('./');
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await page.getByRole('checkbox', { name: 'I have reviewed the terms' }).check();
	await page.getByRole('button', { name: 'Install locally' }).click();

	const studioTwo = page.getByRole('button', { name: 'Use Studio 2' });
	await studioTwo.click();
	await expect(studioTwo).toHaveAttribute('aria-pressed', 'true');
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<string | undefined>((resolve, reject) => {
						const request = indexedDB.open('voicebook-v1');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const transaction = request.result.transaction('settings');
							const selectedVoice = transaction.objectStore('settings').get('selected-voice');
							selectedVoice.onerror = () => reject(selectedVoice.error);
							selectedVoice.onsuccess = () => resolve(selectedVoice.result?.value);
						};
					})
			)
		)
		.toBe('F2');
	await page.reload();
	await expect(page.getByRole('button', { name: 'Use Studio 2' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	await page.evaluate(() => {
		(
			window as unknown as {
				__voicebookTtsDelayMs: number;
			}
		).__voicebookTtsDelayMs = 300;
	});
	await page.getByRole('button', { name: 'Preview Studio 2' }).click();
	await expect(page.getByRole('button', { name: 'Stop preparing Studio 2 preview' })).toBeVisible();
	await expect(page.getByText('Playing Studio 2', { exact: true })).toBeVisible();

	const synthesisRequest = await page.evaluate(() =>
		(
			window as unknown as {
				__voicebookTtsMessages: Array<{
					type: string;
					voiceId?: string;
					totalSteps?: number;
				}>;
			}
		).__voicebookTtsMessages.find((message) => message.type === 'synthesize')
	);
	expect(synthesisRequest).toMatchObject({ voiceId: 'F2', totalSteps: 10 });
	await page.getByRole('button', { name: 'Stop Studio 2 preview' }).click();
	await expect(page.getByRole('button', { name: 'Preview Studio 2' })).toBeVisible();
});

test('renders Mermaid fences as accessible diagrams with a source fallback', async ({ page }) => {
	await openReadyLibrary(page);
	await page.locator('#document-upload').setInputFiles({
		name: 'diagram.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			[
				'# Local pipeline',
				'',
				'```mermaid',
				'sequenceDiagram',
				'  participant Reader',
				'  participant Voicebook',
				'  Reader->>Voicebook: recording notice;<br/>continue locally',
				'```'
			].join('\n')
		)
	});

	await expect(page.getByRole('figure', { name: /Diagram/ })).toBeVisible();
	await expect(page.getByRole('img', { name: 'Mermaid diagram' })).toBeVisible();
	// The source expander is now the construct panel: source plus the exact
	// spoken text, with edit controls.
	await expect(page.getByText('Diagram source & spoken text')).toBeVisible();
	await page.getByText('Diagram source & spoken text').click();
	await expect(page.getByText('sequenceDiagram')).toBeVisible();
	await expect(page.getByText('A sequence diagram is shown here.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit the spoken text' })).toBeVisible();
	await expect(page.locator('figure.mermaid-diagram')).toHaveAttribute('data-status', 'ready');
	await expect(page.getByText('Diagram unavailable')).toBeHidden();
	const diagramSvg = page.locator('.mermaid-diagram .diagram-output svg');
	await expect(diagramSvg.locator('style').last()).toContainText('var(--diagram-node)');
	const diagramThemeToken = () =>
		diagramSvg.evaluate((svg) => getComputedStyle(svg).getPropertyValue('--diagram-node').trim());
	const midnightToken = await diagramThemeToken();
	await page.getByRole('button', { name: 'Theme: Midnight. Switch to Forest theme' }).click();
	await expect
		.poll(diagramThemeToken, {
			message: 'Mermaid should recolor for the active reader theme'
		})
		.not.toBe(midnightToken);
	const sizeToggle = page.getByRole('button', { name: 'Full size' });
	await sizeToggle.click();
	await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('renders technical Markdown and zooms only the document beneath the navbar', async ({
	page
}) => {
	await openReadyLibrary(page);
	await page.locator('#document-upload').setInputFiles({
		name: 'technical-reader.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			[
				'# Technical reader',
				'',
				'The identity $e^{i\\pi} + 1 = 0$ stays inline.',
				'',
				'$$',
				'\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
				'$$',
				'',
				'```typescript',
				'const answer: number = 42;',
				'```',
				'',
				'The implementation stays local.[^privacy]',
				'',
				'[^privacy]: Nothing is uploaded.'
			].join('\n')
		)
	});

	await expect(page.locator('.math-inline .katex')).toBeVisible();
	await expect(
		page.getByRole('figure', { name: 'Mathematical equation' }).locator('.katex-display')
	).toBeVisible();
	const code = page.locator('figure.code-block > pre > code');
	await expect(code).toContainText('const answer: number = 42;');
	await expect(code.locator('.hljs-keyword')).toHaveText('const');
	await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
	// Code fences narrate: the panel holds only the spoken text — the code
	// itself is already on screen, so the source is not repeated.
	const codePanel = page.locator('figure.code-block summary');
	await expect(codePanel).toHaveText('Spoken text');
	await expect(page.locator('figure.code-block .panel-source')).toHaveCount(0);
	await expect(page.getByRole('complementary', { name: 'Footnote privacy' })).toContainText(
		'Nothing is uploaded.'
	);
	await expect(page.locator('a[href="#footnote-privacy"]')).toHaveText('[privacy]');

	const header = page.getByRole('banner', { name: 'Voicebook header' });
	const canvas = page.locator('.reading-canvas');
	const geometry = await page.evaluate(() => {
		const headerElement = document.querySelector<HTMLElement>('.app-header');
		const canvasElement = document.querySelector<HTMLElement>('.reading-canvas');
		const stageElement = document.querySelector<HTMLElement>('.reader-stage');
		if (!headerElement || !canvasElement || !stageElement)
			throw new Error('Reader geometry is unavailable');
		const headerStyle = getComputedStyle(headerElement);
		return {
			headerBottom: headerElement.getBoundingClientRect().bottom,
			canvasTop: canvasElement.getBoundingClientRect().top,
			canvasRight: canvasElement.getBoundingClientRect().right,
			stageRight: stageElement.getBoundingClientRect().right,
			headerBackground: headerStyle.backgroundColor,
			rootBackground: getComputedStyle(document.documentElement).backgroundColor,
			headerFontSize: Number.parseFloat(headerStyle.fontSize)
		};
	});
	expect(geometry.canvasTop).toBeLessThan(geometry.headerBottom);
	expect(Math.abs(geometry.canvasRight - geometry.stageRight)).toBeLessThan(1);
	expect(geometry.headerBackground).not.toBe(geometry.rootBackground);

	await expect(page.getByRole('complementary', { name: 'Document outline' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Open document outline' }).click();
	await expect(page.getByRole('complementary', { name: 'Document outline' })).toBeVisible();

	const beforeZoom = await canvas.evaluate((element) => ({
		fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
		canvasWidth: Number.parseFloat(
			getComputedStyle(element).getPropertyValue('--document-canvas-width')
		)
	}));
	await page.getByRole('button', { name: 'Document zoom 100 percent' }).click();
	await page.getByRole('slider', { name: 'Document zoom' }).fill('110');
	await expect(page.getByRole('button', { name: 'Document zoom 110 percent' })).toBeVisible();
	await page.keyboard.press('Escape');
	const afterZoom = await canvas.evaluate((element) => ({
		fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
		canvasWidth: Number.parseFloat(
			getComputedStyle(element).getPropertyValue('--document-canvas-width')
		)
	}));
	expect(afterZoom.fontSize).toBeGreaterThan(beforeZoom.fontSize);
	expect(afterZoom.canvasWidth).toBeGreaterThan(beforeZoom.canvasWidth);
	expect(
		await header.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))
	).toBe(geometry.headerFontSize);
	await page.reload();
	const zoomTrigger = page.getByRole('button', { name: 'Document zoom 110 percent' });
	await expect(zoomTrigger).toBeVisible();
	await zoomTrigger.dblclick();
	await expect(page.getByRole('button', { name: 'Document zoom 100 percent' })).toBeVisible();
});

test('renders nested Markdown extensions as safe semantic document content', async ({ page }) => {
	await openReadyLibrary(page);
	await page.locator('#document-upload').setInputFiles({
		name: 'structured-reader.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			[
				'# Structured reader',
				'',
				'> [!WARNING]',
				'> Check the local model before continuing.',
				'',
				'3. Ordered parent',
				'   - Nested child',
				'     > Quoted child',
				'',
				'Term',
				': Definition with **bold** text.',
				': > A nested definition quote.',
				'',
				'```math',
				'\\operatorname{tr}(A) = \\sum_i A_{ii}',
				'```',
				'',
				'<details>',
				'<summary>More context</summary>',
				'',
				'- Hidden item',
				'',
				'</details>',
				'',
				'<table><thead><tr><th>Local</th><th>Safe</th></tr></thead><tbody><tr><td colspan="2">Yes</td></tr></tbody></table>',
				'',
				'![Remote illustration](https://example.com/illustration.png)',
				'',
				'---',
				'',
				'<script>window.markdownWasUnsafe = true</script>'
			].join('\n')
		)
	});

	await expect(page.getByRole('complementary', { name: 'Warning alert' })).toContainText(
		'Check the local model before continuing.'
	);
	const ordered = page.locator('.document-body > ol').first();
	await expect(ordered).toHaveAttribute('start', '3');
	await expect(ordered.locator('ul blockquote')).toContainText('Quoted child');
	await expect(page.locator('dl.document-definition-list')).toContainText(
		'A nested definition quote.'
	);
	await expect(page.getByRole('figure', { name: 'Mathematical equation' })).toBeVisible();
	await page.getByText('More context', { exact: true }).click();
	await expect(page.locator('details.document-details ul')).toContainText('Hidden item');
	await expect(page.locator('.html-fragment table')).toContainText('Yes');
	await expect(page.locator('.html-fragment td')).toHaveAttribute('colspan', '2');
	await expect(page.locator('img[alt="Remote illustration"]')).toHaveAttribute(
		'src',
		'https://example.com/illustration.png'
	);
	await expect(page.locator('.document-body hr')).toHaveCount(1);
	await expect(page.locator('script').filter({ hasText: 'markdownWasUnsafe' })).toHaveCount(0);
});

test('table of contents moves the reading canvas and closes its compact drawer', async ({
	page
}) => {
	await openReadyLibrary(page);
	const openingParagraphs = Array.from(
		{ length: 28 },
		(_, index) =>
			`Opening passage ${index + 1} gives the reader enough material to create a real document scroll.`
	);
	await page.locator('#document-upload').setInputFiles({
		name: 'navigable-reader.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			[
				'# Navigable Reader',
				'',
				'## Opening section',
				'',
				...openingParagraphs.flatMap((paragraph) => [paragraph, '']),
				'## Far section',
				'',
				'This is the destination selected from the table of contents.',
				'',
				'## Closing section',
				'',
				'The document ends here.'
			].join('\n')
		)
	});

	const canvas = page.locator('.reading-canvas');
	await page.getByRole('button', { name: 'Open document outline' }).click();
	const outline = page.getByRole('complementary', { name: 'Document outline' });
	const tableOfContents = page.getByRole('navigation', { name: 'Table of contents' });
	const openingSection = tableOfContents.getByRole('button', {
		name: 'Opening section',
		exact: true
	});
	const farSection = tableOfContents.getByRole('button', { name: 'Far section', exact: true });
	await expect
		.poll(() => canvas.evaluate((element) => element.scrollHeight > element.clientHeight))
		.toBe(true);
	await expect(outline.getByText('Progress', { exact: true })).toHaveCount(0);
	await expect(outline.getByRole('progressbar')).toHaveCount(0);
	expect(await canvas.evaluate((element) => getComputedStyle(element).scrollbarGutter)).toBe(
		'auto'
	);

	await farSection.click();
	await expect(canvas).toHaveClass(/scrollbar-active/);
	await expect(canvas).not.toHaveClass(/scrollbar-active/, { timeout: 2_000 });
	await expect.poll(() => canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(200);
	await expect(farSection).toHaveAttribute('aria-current', 'location');
	await expect
		.poll(() =>
			page.getByRole('heading', { name: 'Far section', exact: true }).evaluate((heading) => {
				const canvasElement = document.querySelector<HTMLElement>('.reading-canvas');
				if (!canvasElement) return false;
				const canvasRect = canvasElement.getBoundingClientRect();
				const headingRect = heading.getBoundingClientRect();
				return headingRect.top >= canvasRect.top && headingRect.bottom <= canvasRect.bottom;
			})
		)
		.toBe(true);

	await canvas.evaluate((element) => {
		element.scrollTop = 0;
		element.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
	});
	await expect(farSection).toHaveAttribute('data-narration-current', 'true');
	await expect(farSection).not.toHaveAttribute('aria-current', 'location');
	await expect(tableOfContents.locator('[aria-current="location"]')).toHaveCount(1);
	const followNarration = page.getByRole('button', { name: 'Follow narration' });
	await expect(followNarration).toBeVisible();
	await followNarration.click();
	await expect(followNarration).toBeHidden();
	await expect
		.poll(() =>
			page.getByRole('heading', { name: 'Far section', exact: true }).evaluate((heading) => {
				const canvasElement = document.querySelector<HTMLElement>('.reading-canvas');
				if (!canvasElement) return false;
				const canvasRect = canvasElement.getBoundingClientRect();
				const headingRect = heading.getBoundingClientRect();
				return headingRect.top >= canvasRect.top && headingRect.bottom <= canvasRect.bottom;
			})
		)
		.toBe(true);

	await canvas.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
	await expect
		.poll(() =>
			page.getByText('The document ends here.', { exact: true }).evaluate((closingParagraph) => {
				const playerBar = document.querySelector<HTMLElement>('.player-bar');
				if (!playerBar) return false;
				return (
					closingParagraph.getBoundingClientRect().bottom <= playerBar.getBoundingClientRect().top
				);
			})
		)
		.toBe(true);

	await page.setViewportSize({ width: 800, height: 760 });
	await openingSection.click();
	await expect(outline).toBeHidden();
	await expect(
		page.getByRole('heading', { name: 'Opening section', exact: true }).locator('..')
	).toBeFocused();
});
