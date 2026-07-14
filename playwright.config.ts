import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests',
	testMatch: '**/*.e2e.{ts,js}',
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	projects: [
		{
			name: 'chromium',
			use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
			testIgnore: '**/visual.e2e.ts'
		},
		{
			name: 'visual-1440',
			use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
			testMatch: '**/visual.e2e.ts'
		},
		{
			name: 'visual-1280',
			use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
			testMatch: '**/visual.e2e.ts'
		},
		{
			name: 'visual-1024',
			use: { browserName: 'chromium', viewport: { width: 1024, height: 768 } },
			testMatch: '**/visual.e2e.ts'
		}
	],
	use: {
		baseURL: 'http://127.0.0.1:4173/voicebook/',
		colorScheme: 'dark',
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure'
	},
	webServer: {
		command: 'BASE_PATH=/voicebook npm run build && npm run preview:pages',
		url: 'http://127.0.0.1:4173/voicebook/',
		timeout: 180_000,
		reuseExistingServer: !process.env.CI
	}
});
