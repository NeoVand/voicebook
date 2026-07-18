import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mdsvex } from 'mdsvex';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

const basePath = (process.env.BASE_PATH || '') as '' | `/${string}`;

/**
 * Tesseract language data must live at a STABLE url — the OCR worker fetches
 * `${langPath}/eng.traineddata.gz` by convention, so a hashed `?url` asset
 * cannot work. (Passing bytes directly via `{code, data}` lang objects is
 * broken in tesseract.js ≤7: `initialize` uses `l.data` as the language
 * *name*.) Emitting from node_modules keeps the 3 MB binary out of git.
 */
function tessdataPlugin(): Plugin {
	const require = createRequire(import.meta.url);
	const source = require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz');
	return {
		name: 'voicebook-tessdata',
		configureServer(server) {
			server.middlewares.use(`${basePath}/tessdata/eng.traineddata.gz`, (_req, res) => {
				res.setHeader('Content-Type', 'application/gzip');
				res.end(readFileSync(source));
			});
		},
		generateBundle() {
			if (this.environment?.name === 'ssr') return;
			this.emitFile({
				type: 'asset',
				fileName: 'tessdata/eng.traineddata.gz',
				source: readFileSync(source)
			});
		}
	};
}

export default defineConfig({
	// transformers.js loads its ONNX/WASM backends dynamically at runtime;
	// pre-bundling breaks those dynamic imports inside the LLM worker. The
	// liteparse wasm-bindgen glue resolves its .wasm beside itself the same
	// way.
	optimizeDeps: { exclude: ['@huggingface/transformers', '@llamaindex/liteparse-wasm'] },
	// Module workers (tts.worker.ts, llm/worker.ts) must be emitted as ES
	// modules — the classic-worker default cannot use import statements.
	worker: { format: 'es' },
	plugins: [
		tessdataPlugin(),
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({ fallback: '404.html' }),
			paths: { base: basePath },
			serviceWorker: { register: false },
			preprocess: [mdsvex({ extensions: ['.svx', '.md'] })],
			extensions: ['.svelte', '.svx', '.md']
		})
	],
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'json-summary', 'html'],
			include: [
				'src/lib/domain/docx-extras.ts',
				'src/lib/domain/explain-prompts.ts',
				'src/lib/domain/importers.ts',
				'src/lib/domain/model-catalog.ts',
				'src/lib/domain/segmenter.ts',
				'src/lib/domain/speech-words.ts',
				'src/lib/services/generation-plan.ts',
				'src/lib/services/repository.ts',
				'src/lib/services/timeline.ts',
				'src/lib/services/tts-client.ts'
			],
			thresholds: { lines: 85, functions: 85, statements: 85, branches: 80 }
		},
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
