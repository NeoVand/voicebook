import type { DocumentBlock } from './types';

/**
 * Back matter — the citation apparatus a narrator skips by convention:
 * references, bibliographies, notes, and acknowledgements. Detected by
 * heading title so the reader can announce and skip past it while the text
 * stays on the page and remains playable on demand.
 */
const BACK_MATTER_TITLES: ReadonlySet<string> = new Set([
	'references',
	'reference',
	'references and notes',
	'bibliography',
	'works cited',
	'literature cited',
	'notes',
	'endnotes',
	'end notes',
	'footnotes',
	'foot notes',
	'acknowledgment',
	'acknowledgments',
	'acknowledgement',
	'acknowledgements'
]);

/** Lowercase a heading and strip leading numbering ("7.", "IV.", "A)") and
 * trailing punctuation so titles compare cleanly. */
export function normalizeHeadingTitle(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/^(?:\d+|[ivxlcdm]+|[a-z])[.)]\s+/i, '')
		.replace(/[:.]+$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** True for an exact back-matter section title — "References", "Notes",
 * "Acknowledgements" — but not content that merely starts with one of those
 * words ("Reference Implementation", "Notes on Method"). */
export function isBackMatterHeading(text: string, extraTitles?: ReadonlySet<string>): boolean {
	const title = normalizeHeadingTitle(text);
	return BACK_MATTER_TITLES.has(title) || Boolean(extraTitles?.has(title));
}

/**
 * The ids of every block inside a back-matter section. A section runs from its
 * heading until the next heading at the same or a higher level that is NOT
 * itself back matter — so a "References" section swallows its own subheadings
 * but a following "Appendix" (real content) closes it.
 */
export function backMatterBlockIds(
	blocks: DocumentBlock[],
	extraTitles?: ReadonlySet<string>
): Set<string> {
	const ids = new Set<string>();
	let openLevel: number | null = null;
	for (const block of blocks) {
		if (block.kind === 'heading') {
			const level = block.level ?? 2;
			if (isBackMatterHeading(block.text, extraTitles)) {
				openLevel = openLevel === null ? level : Math.min(openLevel, level);
				ids.add(block.id);
				continue;
			}
			if (openLevel !== null && level <= openLevel) {
				openLevel = null;
				continue;
			}
		}
		if (openLevel !== null) ids.add(block.id);
	}
	return ids;
}

/** The one-line spoken notice before a back-matter section is skipped. */
export function backMatterAnnouncement(heading: string): string {
	const label = normalizeHeadingTitle(heading) || 'end matter';
	return `Skipping the ${label}.`;
}
