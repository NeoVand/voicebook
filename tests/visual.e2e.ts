import { expect, test } from '@playwright/test';
import { installFakeTts } from './helpers';

test('empty library visual baseline', async ({ page }, testInfo) => {
	await installFakeTts(page);
	await page.goto('./');
	await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible();
	await expect(page).toHaveScreenshot(`library-empty-${testInfo.project.name}.png`, {
		fullPage: true,
		animations: 'disabled'
	});
});

test('reader workspace visual baseline', async ({ page }, testInfo) => {
	await installFakeTts(page);
	await page.goto('./');
	await page.getByRole('link', { name: 'Voice', exact: true }).click();
	await page.getByRole('checkbox', { name: 'I have reviewed the terms' }).check();
	await page.getByRole('button', { name: 'Install locally' }).click();
	await page.getByRole('link', { name: 'Library', exact: true }).click();
	await page.locator('#document-upload').setInputFiles({
		name: 'quiet-machine.md',
		mimeType: 'text/markdown',
		buffer: Buffer.from(
			'# The Quiet Machine\n\nA local reader should feel calm, immediate, and precise. Every control should earn its place.\n\n## A deliberate beginning\n\nThe page stays centered while the outline and player remain exactly where you expect them.\n\n## Listening without friction\n\nSpeech is prepared one passage at a time, with the next passages buffered quietly in the background.'
		)
	});
	await expect(page.getByRole('heading', { name: 'The Quiet Machine', exact: true })).toBeVisible();
	await expect(page).toHaveScreenshot(`reader-workspace-${testInfo.project.name}.png`, {
		fullPage: true,
		animations: 'disabled'
	});
});
