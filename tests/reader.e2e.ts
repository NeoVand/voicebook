import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { installFakeTts } from './helpers';

test.beforeEach(async ({ page }) => {
	await installFakeTts(page);
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

	await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Reading options' }).click();
	await expect(page.getByRole('menuitem', { name: /Prepare whole document/ })).toBeVisible();
	await page.getByRole('button', { name: 'Reading options' }).click();
	await page.getByRole('button', { name: 'Play', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
	await page.getByLabel('Playback speed').selectOption('1.5');
	await expect(page.getByLabel('Playback speed')).toHaveValue('1.5');
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

test('keeps the desktop player settings inside the playback dock', async ({ page }) => {
	await page.goto('./');
	await page.getByRole('button', { name: 'Paste text' }).click();
	await page.getByLabel('Title').fill('Player spacing check');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill('The playback dock should remain compact, aligned, and fully visible.');
	await page.getByRole('button', { name: 'Add to library' }).click();
	await expect(page.getByRole('heading', { name: 'Player spacing check' })).toBeVisible();

	for (const width of [1024, 1280, 1440]) {
		await page.setViewportSize({ width, height: 800 });
		const geometry = await page.locator('.player-options').evaluate((options) => {
			const player = options.closest<HTMLElement>('.player-bar');
			const volume = options.querySelector<HTMLElement>('.volume-field');
			if (!player || !volume) throw new Error('Player settings geometry is unavailable');

			const playerRect = player.getBoundingClientRect();
			const optionsRect = options.getBoundingClientRect();
			const volumeRect = volume.getBoundingClientRect();

			return {
				documentOverflow:
					document.documentElement.scrollWidth - document.documentElement.clientWidth,
				optionsOverflow: Math.max(0, options.scrollWidth - options.clientWidth),
				playerRightInset: playerRect.right - optionsRect.right,
				volumeRightInset: playerRect.right - volumeRect.right
			};
		});

		expect(geometry.documentOverflow, `${width}px document overflow`).toBe(0);
		expect(geometry.optionsOverflow, `${width}px settings overflow`).toBe(0);
		expect(geometry.playerRightInset, `${width}px settings right inset`).toBeGreaterThanOrEqual(19);
		expect(geometry.volumeRightInset, `${width}px volume right inset`).toBeGreaterThanOrEqual(19);
	}
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
	await page.getByRole('link', { name: 'Back to library' }).click();
	await input.setInputFiles({
		name: 'repeat.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('A repeatable local document.')
	});
	await expect(page.getByRole('dialog', { name: 'Already in your library' })).toBeVisible();
	await page.getByRole('button', { name: 'Keep copy' }).click();
	await expect(page.getByText('repeat — Copy')).toBeVisible();
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
	const sizeToggle = page.getByRole('button', { name: 'Full size' });
	await sizeToggle.click();
	await expect(page.getByRole('button', { name: 'Fit width' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
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
	const farSection = tableOfContents.getByRole('button', { name: 'Far section', exact: true });
	await expect
		.poll(() => canvas.evaluate((element) => element.scrollHeight > element.clientHeight))
		.toBe(true);

	await farSection.click();
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

	await page.setViewportSize({ width: 800, height: 760 });
	await tableOfContents.getByRole('button', { name: 'Opening section', exact: true }).click();
	await expect(outline).toBeHidden();
	await expect(
		page.getByRole('heading', { name: 'Opening section', exact: true }).locator('..')
	).toBeFocused();
});
