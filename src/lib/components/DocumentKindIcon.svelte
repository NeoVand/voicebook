<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { FileImage, FileCode, FileText, FileType, Globe } from '$lib/icons';
	import type { DocumentKind } from '$lib/domain/types';

	let {
		kind,
		size = 20,
		strokeWidth = 1.7
	}: { kind: DocumentKind; size?: number; strokeWidth?: number } = $props();
</script>

{#if kind === 'pdf'}
	<Icon icon={FileImage} {size} {strokeWidth} aria-hidden="true" />
{:else if kind === 'docx'}
	<Icon icon={FileType} {size} {strokeWidth} aria-hidden="true" />
{:else if kind === 'markdown'}
	<Icon icon={FileCode} {size} {strokeWidth} aria-hidden="true" />
{:else if kind === 'web'}
	<Icon icon={Globe} {size} {strokeWidth} aria-hidden="true" />
{:else}
	<Icon icon={FileText} {size} {strokeWidth} aria-hidden="true" />
{/if}
