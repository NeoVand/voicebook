import {
	FOCUSED_SPOKEN_RULES,
	NATURAL_SPOKEN_RULES,
	VERBATIM_SPOKEN_RULES,
	type SpokenRule
} from './spoken-style';
import type { ListeningMode } from './types';

export type { ListeningMode };

export const DEFAULT_LISTENING_MODE: ListeningMode = 'natural';

export interface ListeningModeInfo {
	id: ListeningMode;
	label: string;
	/** One line for the picker. */
	description: string;
}

export const LISTENING_MODES: ReadonlyArray<ListeningModeInfo> = [
	{
		id: 'verbatim',
		label: 'Verbatim',
		description: 'Reads the page literally, including citation markers.'
	},
	{
		id: 'natural',
		label: 'Natural',
		description: 'Skips citations, reads abbreviations aloud, pauses like a narrator.'
	},
	{
		id: 'focused',
		label: 'Focused',
		description: 'Also drops cross-references and pointer asides for a cleaner listen.'
	}
];

const RULES: Record<ListeningMode, SpokenRule[]> = {
	verbatim: VERBATIM_SPOKEN_RULES,
	natural: NATURAL_SPOKEN_RULES,
	focused: FOCUSED_SPOKEN_RULES
};

export function isListeningMode(value: unknown): value is ListeningMode {
	return value === 'verbatim' || value === 'natural' || value === 'focused';
}

/** The spoken-style rules a mode applies during segmentation. */
export function spokenRulesFor(mode: ListeningMode): SpokenRule[] {
	return RULES[mode] ?? RULES[DEFAULT_LISTENING_MODE];
}

/** Whether natural playback announces and skips references/notes in this mode. */
export function skipsBackMatter(mode: ListeningMode): boolean {
	return mode !== 'verbatim';
}
