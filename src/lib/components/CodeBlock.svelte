<script lang="ts">
	import { Check, Copy } from '@lucide/svelte';
	import hljs from 'highlight.js/lib/core';
	import bash from 'highlight.js/lib/languages/bash';
	import cpp from 'highlight.js/lib/languages/cpp';
	import csharp from 'highlight.js/lib/languages/csharp';
	import css from 'highlight.js/lib/languages/css';
	import diff from 'highlight.js/lib/languages/diff';
	import go from 'highlight.js/lib/languages/go';
	import java from 'highlight.js/lib/languages/java';
	import javascript from 'highlight.js/lib/languages/javascript';
	import json from 'highlight.js/lib/languages/json';
	import markdown from 'highlight.js/lib/languages/markdown';
	import python from 'highlight.js/lib/languages/python';
	import rust from 'highlight.js/lib/languages/rust';
	import ruby from 'highlight.js/lib/languages/ruby';
	import sql from 'highlight.js/lib/languages/sql';
	import typescript from 'highlight.js/lib/languages/typescript';
	import xml from 'highlight.js/lib/languages/xml';
	import yaml from 'highlight.js/lib/languages/yaml';
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';

	hljs.registerLanguage('bash', bash);
	hljs.registerLanguage('cpp', cpp);
	hljs.registerLanguage('csharp', csharp);
	hljs.registerLanguage('css', css);
	hljs.registerLanguage('diff', diff);
	hljs.registerLanguage('go', go);
	hljs.registerLanguage('java', java);
	hljs.registerLanguage('javascript', javascript);
	hljs.registerLanguage('json', json);
	hljs.registerLanguage('markdown', markdown);
	hljs.registerLanguage('python', python);
	hljs.registerLanguage('rust', rust);
	hljs.registerLanguage('ruby', ruby);
	hljs.registerLanguage('sql', sql);
	hljs.registerLanguage('typescript', typescript);
	hljs.registerLanguage('xml', xml);
	hljs.registerLanguage('yaml', yaml);

	interface Props {
		id: string;
		source: string;
		language?: string;
		/** Optional construct-panel snippet (the spoken-description editor). */
		panel?: Snippet;
	}

	const aliases: Record<string, string> = {
		c: 'cpp',
		'c++': 'cpp',
		cs: 'csharp',
		html: 'xml',
		js: 'javascript',
		jsx: 'javascript',
		md: 'markdown',
		py: 'python',
		rb: 'ruby',
		rs: 'rust',
		sh: 'bash',
		shell: 'bash',
		ts: 'typescript',
		tsx: 'typescript',
		yml: 'yaml'
	};

	let { id, source, language, panel }: Props = $props();
	let copyState = $state<'idle' | 'copied' | 'error'>('idle');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let languageLabel = $derived(language?.trim() || 'Plain text');

	function highlightedCode(code: string, requestedLanguage?: string): Attachment<HTMLElement> {
		return (target) => {
			target.textContent = code;
			const requested = requestedLanguage?.trim().toLowerCase();
			const normalized = requested ? (aliases[requested] ?? requested) : undefined;
			// Add/remove classes individually — overwriting className would strip
			// Svelte's scoping class and detach every themed .hljs-* color rule.
			for (const existing of [...target.classList]) {
				if (existing.startsWith('language-') || existing === 'hljs') {
					target.classList.remove(existing);
				}
			}
			delete target.dataset.highlighted;
			if (normalized && hljs.getLanguage(normalized)) {
				target.classList.add(`language-${normalized}`);
			} else {
				target.classList.add('language-plaintext');
			}
			hljs.highlightElement(target);
		};
	}

	async function copyCode(): Promise<void> {
		if (copyTimer) clearTimeout(copyTimer);
		try {
			await navigator.clipboard.writeText(source);
			copyState = 'copied';
		} catch {
			copyState = 'error';
		}
		copyTimer = setTimeout(() => (copyState = 'idle'), 1_800);
	}
</script>

<figure class="code-block" {id}>
	<figcaption>
		<span>{languageLabel}</span>
		<button
			type="button"
			aria-label={copyState === 'copied' ? 'Code copied' : 'Copy code'}
			onclick={() => void copyCode()}
		>
			{#if copyState === 'copied'}<Check size={13} aria-hidden="true" /> Copied{:else}<Copy
					size={13}
					aria-hidden="true"
				/>
				{copyState === 'error' ? 'Try again' : 'Copy'}{/if}
		</button>
	</figcaption>
	<pre><code {@attach highlightedCode(source, language)}></code></pre>
	{#if panel}{@render panel()}{/if}
</figure>

<style>
	.code-block {
		margin: 1.8em 0;
		border: 1px solid var(--reader-rule);
		border-radius: 6px;
		background: color-mix(in srgb, var(--reader) 94%, var(--text));
		font-family: var(--font-ui);
	}

	figcaption {
		display: flex;
		min-height: 38px;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 0 9px 0 14px;
		border-bottom: 1px solid var(--reader-rule);
		color: var(--reader-quiet);
		font-size: 0.58em;
		font-weight: 650;
		letter-spacing: 0.055em;
		text-transform: uppercase;
	}

	button {
		display: inline-flex;
		min-width: 44px;
		height: 30px;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 0 8px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: var(--reader-quiet);
		font-size: 10px;
		font-weight: 620;
		letter-spacing: 0;
		text-transform: none;
	}

	button:hover {
		background: var(--reader-code-soft);
		color: var(--reader-ink);
	}

	pre {
		overflow: auto;
		margin: 0;
		padding: 18px 20px;
		color: var(--reader-ink);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.68em;
		line-height: 1.6;
		tab-size: 2;
	}

	code {
		display: block;
		min-width: max-content;
	}

	code:global(.hljs) {
		color: var(--reader-ink);
		background: transparent;
	}

	code :global(.hljs-comment),
	code :global(.hljs-quote) {
		color: var(--code-comment, var(--reader-quiet));
		font-style: italic;
	}

	code :global(.hljs-keyword),
	code :global(.hljs-selector-tag),
	code :global(.hljs-built_in),
	code :global(.hljs-name),
	code :global(.hljs-tag) {
		color: var(--code-keyword, var(--primary));
		font-weight: 620;
	}

	code :global(.hljs-string),
	code :global(.hljs-section),
	code :global(.hljs-attribute),
	code :global(.hljs-literal),
	code :global(.hljs-template-tag),
	code :global(.hljs-template-variable),
	code :global(.hljs-type) {
		color: var(--code-string, var(--bookmark));
	}

	code :global(.hljs-title),
	code :global(.hljs-title.function_),
	code :global(.hljs-title.class_),
	code :global(.hljs-function) {
		color: var(--code-function, var(--reader-link));
		font-weight: 650;
	}

	code :global(.hljs-property),
	code :global(.hljs-attr),
	code :global(.hljs-params) {
		color: var(--code-property, var(--reader-ink));
	}

	code :global(.hljs-operator),
	code :global(.hljs-punctuation) {
		color: var(--code-operator, var(--reader-quiet));
	}

	code :global(.hljs-number),
	code :global(.hljs-symbol),
	code :global(.hljs-bullet),
	code :global(.hljs-variable),
	code :global(.hljs-regexp),
	code :global(.hljs-link) {
		color: var(--code-number, var(--reader-link));
	}

	code :global(.hljs-meta) {
		color: var(--reader-link);
	}

	code :global(.hljs-addition) {
		background: var(--code-addition-bg, rgba(73, 161, 111, 0.12));
		color: var(--code-addition, #7ccf9c);
	}

	code :global(.hljs-deletion) {
		background: var(--code-deletion-bg, rgba(206, 86, 86, 0.12));
		color: var(--code-deletion, #ef9a9a);
	}
</style>
