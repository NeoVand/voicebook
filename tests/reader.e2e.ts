import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installFakeTts } from './helpers';

test.beforeEach(async ({ page }) => {
	await installFakeTts(page);
});

test('presents one intentional empty-library import surface', async ({ page }) => {
	await page.goto('./');
	const emptyState = page.getByRole('region', { name: 'What would you like to listen to?' });
	await expect(emptyState).toBeVisible();
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
	await expect(emptyState).toHaveCSS('border-radius', '14px');

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
	for (const theme of ['midnight', 'sunny', 'cloudy', 'rainy']) {
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

test('highlights only the document currently open in the reader', async ({ page }) => {
	await page.goto('./');
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

test('import → install → play → seek → bookmark → reload → offline reopen', async ({
	page,
	context
}) => {
	await page.goto('./');
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
	const emptyA11y = await new AxeBuilder({ page }).analyze();
	expect(
		emptyA11y.violations.filter((item) => ['critical', 'serious'].includes(item.impact ?? ''))
	).toEqual([]);

	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await page.getByRole('checkbox', { name: 'I have reviewed the terms' }).check();
	await page.getByRole('button', { name: 'Install locally' }).click();
	await page.getByRole('link', { name: 'Library', exact: true }).click();
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
	await page.getByRole('button', { name: 'Open bookmarks' }).click();
	const readerSurfaceColors = () =>
		page.evaluate(() => {
			const header = document.querySelector<HTMLElement>('.app-header');
			const sidebar = document.querySelector<HTMLElement>('.app-sidebar');
			const outline = document.querySelector<HTMLElement>('.outline-panel');
			const bookmarks = document.querySelector<HTMLElement>('.bookmarks-panel');
			const playerBar = document.querySelector<HTMLElement>('.player-bar');
			const readerStage = document.querySelector<HTMLElement>('.reader-stage');
			const readingCanvas = document.querySelector<HTMLElement>('.reading-canvas');
			if (
				!header ||
				!sidebar ||
				!outline ||
				!bookmarks ||
				!playerBar ||
				!readerStage ||
				!readingCanvas
			)
				throw new Error('Reader surfaces are unavailable');
			return {
				chrome: [header, sidebar, outline, bookmarks, playerBar].map(
					(element) => getComputedStyle(element).backgroundColor
				),
				chromeBackdrop: [header, sidebar, outline, bookmarks, playerBar].map((element) => {
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
	for (const theme of ['midnight', 'sunny', 'cloudy', 'rainy']) {
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
		const surfaces = await readerSurfaceColors();
		expect(new Set(surfaces.chrome).size, `${theme} chrome surfaces should match`).toBe(1);
		expect(surfaces.chrome[0], `${theme} chrome should remain translucent`).toContain('rgba');
		expect(
			surfaces.chromeBackdrop,
			`${theme} chrome surfaces should share the frosted backdrop`
		).toEqual(Array(5).fill('blur(22px) saturate(1.35)'));
		expect(new Set(surfaces.document).size, `${theme} document surfaces should match`).toBe(1);
		await readerThemeButton.click();
	}
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
	await page
		.getByRole('complementary', { name: 'Bookmarks' })
		.getByRole('button', { name: 'Close bookmarks' })
		.click();
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

	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
	await expect(page.getByRole('button', { name: 'Prepare whole document audio' })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'Generation quality' })).toContainText(
		'10 steps'
	);
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
	await page.getByRole('button', { name: 'Add bookmark' }).click();
	await expect(page.getByRole('button', { name: 'Remove bookmark' })).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					new Promise<number>((resolve, reject) => {
						const request = indexedDB.open('voicebook-v1');
						request.onerror = () => reject(request.error);
						request.onsuccess = () => {
							const transaction = request.result.transaction('documents');
							const documents = transaction.objectStore('documents').getAll();
							documents.onerror = () => reject(documents.error);
							documents.onsuccess = () => resolve(documents.result[0]?.bookmarks?.length ?? 0);
						};
					})
			)
		)
		.toBe(1);
	await page.getByRole('button', { name: 'Forward 10 seconds' }).click();

	await page.reload();
	await expect(page.getByRole('heading', { name: 'The Quiet Machine' })).toBeVisible();
	await page.getByRole('button', { name: 'Open bookmarks' }).click();
	await expect(page.getByText('1 saved')).toBeVisible();
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
	await page.goto('./');
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await page.getByRole('checkbox', { name: 'I have reviewed the terms' }).check();
	await page.getByRole('button', { name: 'Install locally' }).click();
	await page.getByRole('link', { name: 'Library', exact: true }).click();
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

	await page.getByRole('button', { name: 'Prepare whole document audio' }).click();
	await expect(page.getByRole('button', { name: /Stop preparing whole document/ })).toBeVisible();
	await expect(page.locator('.timeline-band.generating').first()).toBeVisible();
	await expect(page.locator('.timeline-band.generating').first()).not.toHaveCSS(
		'background-image',
		'none'
	);
	const ready = page.getByRole('button', { name: 'Whole document audio is ready' });
	await expect(ready).toBeVisible();
	await expect(ready).toBeDisabled();
	await expect(page.locator('.timeline-band.cached')).toHaveCount(6);
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
	await expect(page.getByRole('button', { name: 'Prepare whole document audio' })).toBeEnabled();

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
	await page.getByRole('button', { name: 'Prepare whole document audio' }).click();
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
	await expect(page.getByRole('button', { name: 'Whole document audio is ready' })).toBeVisible();
	await expect(page.locator('.timeline-band.cached')).toHaveCount(6);
	await page.getByRole('button', { name: 'Document audio options' }).click();
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
	await page.goto('./');
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
	await expect(page.getByRole('group', { name: 'Speech generation settings' })).toBeHidden();
	await expect(page.getByRole('group', { name: 'Playback settings' })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Back 10 seconds' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Forward 10 seconds' })).toBeVisible();
	await expect(page.getByRole('slider', { name: 'Reading position' })).toBeVisible();

	const geometry = await page.locator('.player-bar').evaluate((playerBar) => {
		const reader = document.querySelector<HTMLElement>('.reader-stage');
		const bounds = playerBar.getBoundingClientRect();
		return {
			playerWidth: bounds.width,
			playerHeight: bounds.height,
			readerWidth: reader?.getBoundingClientRect().width
		};
	});
	expect(geometry).toEqual({ playerWidth: 390, playerHeight: 88, readerWidth: 390 });
});

test('keeps the desktop player settings inside the playback dock', async ({ page }) => {
	await page.goto('./');
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Player spacing check');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('The playback dock should remain compact, aligned, and fully visible.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('heading', { name: 'Player spacing check' })).toBeVisible();
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
			const volume = options.querySelector<HTMLElement>('.player-volume');
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

	const qualitySelect = page.getByRole('combobox', { name: 'Generation quality' });
	await qualitySelect.click();
	await page.getByRole('option', { name: '14 steps', exact: true }).click();
	await expect(qualitySelect).toContainText('14 steps');
	await page.reload();
	await expect(page.getByRole('combobox', { name: 'Generation quality' })).toContainText(
		'14 steps'
	);
});

test('collapses and remembers the desktop sidebar', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('./');
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
	await expect(themeButton).toHaveAccessibleName('Theme: Midnight. Switch to Sunny theme');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'sunny');
	await expect(themeButton).toHaveAccessibleName('Theme: Sunny. Switch to Cloudy theme');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'cloudy');
	await themeButton.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'rainy');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'rainy');
	await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveAccessibleName(
		'Theme: Rainy. Switch to Midnight theme'
	);
	await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toHaveCount(0);
	await expect(page.getByRole('link', { name: 'Open Voicebook on GitHub' })).toHaveAttribute(
		'href',
		'https://github.com/NeoVand/voicebook'
	);
});

test('starts narration from a chosen passage or selected word', async ({ page }) => {
	await page.goto('./');
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await page.getByRole('checkbox', { name: 'I have reviewed the terms' }).check();
	await page.getByRole('button', { name: 'Install locally' }).click();
	await page.getByRole('link', { name: 'Library', exact: true }).click();
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
		name: 'Play from selected text: begins'
	});
	await expect(playSelection).toBeVisible();
	await playSelection.click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
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
});

test('detects duplicate file imports and keeps navigation under the Pages base path', async ({
	page
}) => {
	await page.goto('./');
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
	await page.goto('./');
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
	await expect(page.getByText('View diagram source')).toBeVisible();
	await expect(page.locator('figure.mermaid-diagram')).toHaveAttribute('data-status', 'ready');
	await expect(page.getByText('Diagram unavailable')).toBeHidden();
	const diagramSvg = page.locator('.mermaid-diagram .diagram-output svg');
	await expect(diagramSvg.locator('style').last()).toContainText('var(--diagram-node)');
	const diagramThemeToken = () =>
		diagramSvg.evaluate((svg) => getComputedStyle(svg).getPropertyValue('--diagram-node').trim());
	const midnightToken = await diagramThemeToken();
	await page.getByRole('button', { name: 'Theme: Midnight. Switch to Sunny theme' }).click();
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
	await page.goto('./');
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
	const code = page.locator('figure.code-block code.hljs');
	await expect(code).toContainText('const answer: number = 42;');
	await expect(code.locator('.hljs-keyword')).toHaveText('const');
	await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
	await expect(page.getByRole('complementary', { name: 'Footnote privacy' })).toContainText(
		'Nothing is uploaded.'
	);
	await expect(page.locator('a[href="#footnote-privacy"]')).toHaveText('[privacy]');

	const header = page.getByRole('banner', { name: 'Voicebook header' });
	const canvas = page.locator('.reading-canvas');
	const geometry = await page.evaluate(() => {
		const headerElement = document.querySelector<HTMLElement>('.app-header');
		const canvasElement = document.querySelector<HTMLElement>('.reading-canvas');
		if (!headerElement || !canvasElement) throw new Error('Reader geometry is unavailable');
		const headerStyle = getComputedStyle(headerElement);
		return {
			headerBottom: headerElement.getBoundingClientRect().bottom,
			canvasTop: canvasElement.getBoundingClientRect().top,
			headerBackground: headerStyle.backgroundColor,
			rootBackground: getComputedStyle(document.documentElement).backgroundColor,
			headerFontSize: Number.parseFloat(headerStyle.fontSize)
		};
	});
	expect(geometry.canvasTop).toBeLessThan(geometry.headerBottom);
	expect(geometry.headerBackground).not.toBe(geometry.rootBackground);

	await page.getByRole('button', { name: 'Close document outline' }).click();
	await expect(page.getByRole('complementary', { name: 'Document outline' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Open document outline' }).click();
	await expect(page.getByRole('complementary', { name: 'Document outline' })).toBeVisible();

	const beforeZoom = await canvas.evaluate((element) => ({
		fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
		canvasWidth: Number.parseFloat(
			getComputedStyle(element).getPropertyValue('--document-canvas-width')
		)
	}));
	await page.getByRole('button', { name: 'Zoom document in' }).click();
	await expect(
		page.getByRole('button', { name: 'Reset document zoom, currently 110%' })
	).toBeVisible();
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
	await expect(
		page.getByRole('button', { name: 'Reset document zoom, currently 110%' })
	).toBeVisible();
	await page.getByRole('button', { name: 'Reset document zoom, currently 110%' }).click();
	await expect(
		page.getByRole('button', { name: 'Reset document zoom, currently 100%' })
	).toBeVisible();
});

test('renders nested Markdown extensions as safe semantic document content', async ({ page }) => {
	await page.goto('./');
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
	await page.goto('./');
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
