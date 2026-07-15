<script lang="ts">
	import { FileCode, FileImage, FileText, FileType } from '@lucide/svelte';
	import type { DocumentKind } from '$lib/domain/types';

	let {
		kind,
		size = 20,
		strokeWidth = 1.7
	}: { kind: DocumentKind; size?: number; strokeWidth?: number } = $props();
</script>

{#if kind === 'pdf'}
	<FileImage {size} {strokeWidth} aria-hidden="true" />
{:else if kind === 'docx'}
	<FileType {size} {strokeWidth} aria-hidden="true" />
{:else if kind === 'markdown'}
	<FileCode {size} {strokeWidth} aria-hidden="true" />
{:else}
	<FileText {size} {strokeWidth} aria-hidden="true" />
{/if}
