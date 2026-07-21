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

/** Lowercase a heading and strip leading numbering ("7.", "7.1", "IV.", "A)")
 * and trailing punctuation so titles compare cleanly. Multi-level numbering
 * ("7.1 References") is stripped whether or not a trailing dot is present. */
export function normalizeHeadingTitle(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/^(?:\d+(?:\.\d+)+\.?|\d+[.)]|(?:[ivxlcdm]+|[a-z])[.)])\s+/i, '')
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
 * heading until the NEXT heading of any kind that is not itself back matter.
 *
 * The close is deliberately level-agnostic. Comparing levels ("close only on a
 * heading at or above the reference heading's level") looks tidier but lets a
 * deeper heading — e.g. an "Appendix" that PDF/DOCX font-size heuristics ranked
 * below "References" — be swallowed as a subsection, hiding the rest of the
 * document from playback. Closing on any real-content heading is the safe rule;
 * adjacent back-matter sections still merge because their headings re-open it.
 */
export function backMatterBlockIds(
	blocks: DocumentBlock[],
	extraTitles?: ReadonlySet<string>
): Set<string> {
	const ids = new Set<string>();
	let inBackMatter = false;
	for (const block of blocks) {
		if (block.kind === 'heading') {
			if (isBackMatterHeading(block.text, extraTitles)) {
				inBackMatter = true;
				ids.add(block.id);
				continue;
			}
			if (inBackMatter) {
				inBackMatter = false;
				continue;
			}
		}
		if (inBackMatter) ids.add(block.id);
	}
	return ids;
}

/** The one-line spoken notice before a back-matter section is skipped. */
export function backMatterAnnouncement(heading: string): string {
	const label = normalizeHeadingTitle(heading) || 'end matter';
	return `Skipping the ${label}.`;
}
