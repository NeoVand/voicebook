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
			[
				'---',
				'title: The Quiet Machine',
				'category: Private listening',
				'---',
				'',
				'# The Quiet Machine',
				'',
				'A local reader should feel **calm**, *immediate*, and precise. Every control should earn its place, and every [private link](https://example.com) should remain safe.',
				'',
				'> The reading surface should feel like a beautifully typeset page, not another dashboard card.',
				'',
				'## A deliberate beginning',
				'',
				'- [x] Preserve document structure',
				'- [ ] Keep the controls quiet',
				'',
				'### Structured details',
				'',
				'| Capability | Behavior |',
				'| :--- | ---: |',
				'| Storage | Local only |',
				'| Speech | One passage at a time |',
				'',
				'```ts',
				'const privateByDefault = true;',
				'```'
			].join('\n')
		)
	});
	await expect(page.getByRole('heading', { name: 'The Quiet Machine', exact: true })).toBeVisible();
	await expect(page.getByText('Document metadata')).toBeVisible();
	await expect(page.getByRole('link', { name: 'private link' })).toHaveAttribute(
		'href',
		'https://example.com/'
	);
	await expect(page.getByRole('list')).toBeVisible();
	await expect(page.getByRole('region', { name: 'Document table' })).toBeAttached();
	await expect(page.locator('figure.code-block')).toContainText('const privateByDefault = true;');
	await expect(page).toHaveScreenshot(`reader-workspace-${testInfo.project.name}.png`, {
		fullPage: true,
		animations: 'disabled'
	});
});

test('populated library visual baseline', async ({ page }, testInfo) => {
	await installFakeTts(page);
	await page.goto('./');
	await page.getByRole('button', { name: 'Paste text', exact: true }).click();
	await page.getByLabel('Title').fill('The Quiet Machine');
	await page
		.getByRole('textbox', { name: 'Text' })
		.fill(
			'A deliberate reading about calm interfaces, private documents, and a listening experience that stays out of the way.'
		);
	await page.getByRole('button', { name: 'Add to library' }).click();
	await page.getByRole('link', { name: 'Voicebook library' }).click();
	await expect(page.getByRole('heading', { name: 'Documents', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add document', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Paste text', exact: true })).toBeVisible();
	await expect(page).toHaveScreenshot(`library-populated-${testInfo.project.name}.png`, {
		fullPage: true,
		animations: 'disabled'
	});
});
