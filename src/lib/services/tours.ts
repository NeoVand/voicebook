/**
 * Contextual interface tours (driver.js). Each surface gets its own short
 * walkthrough; the help button in the header starts the tour for wherever
 * the user currently is. The reader tour also auto-runs the first time a
 * document opens on this device.
 */
import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';

export type TourContext = 'reader' | 'library' | 'voice' | 'llm' | 'appearance' | 'system';

const READER_TOUR_SEEN_KEY = 'voicebook:reader-tour-seen';

const TOURS: Record<TourContext, DriveStep[]> = {
	// Reader steps sweep the player bar left to right, then the navbar left
	// to right — the spotlight never jumps back and forth.
	reader: [
		{
			element: '[data-tour="audio-menu"]',
			popover: {
				title: 'Audio menu',
				description:
					'Everything about the voice: pick who reads, prepare the whole document ahead of time, download it as an MP3, or clear cached audio.',
				side: 'top',
				align: 'start'
			}
		},
		{
			element: '[data-tour="llm-chip"]',
			popover: {
				title: 'Spoken descriptions',
				description:
					'The brain rewrites equations, tables, and diagrams into words the voice can speak. Click it to pause, regenerate, or tune the style.',
				side: 'top',
				align: 'start'
			}
		},
		{
			element: '[data-tour="play"]',
			popover: {
				title: 'Play',
				description:
					'Reads aloud from the current passage. You can also click any sentence in the document to start from there.',
				side: 'top',
				align: 'center'
			}
		},
		{
			element: '[data-tour="timeline"]',
			popover: {
				title: 'Timeline',
				description:
					'Shows what you have listened to, what audio is already prepared, and what is generating right now. Drag to seek.',
				side: 'top',
				align: 'center'
			}
		},
		{
			element: '[data-tour="speed"]',
			popover: {
				title: 'Speed',
				description: 'From 0.5× to 3×, without the chipmunk effect.',
				side: 'top',
				align: 'end'
			}
		},
		{
			element: '[data-tour="volume"]',
			popover: {
				title: 'Volume',
				description: 'Click for a slider.',
				side: 'top',
				align: 'end'
			}
		},
		{
			element: '[data-tour="outline"]',
			popover: {
				title: 'Contents',
				description: 'The document outline — jump between sections from here.',
				side: 'bottom',
				align: 'end'
			}
		},
		{
			element: '[data-tour="zoom"]',
			popover: {
				title: 'Zoom',
				description: 'Click the percentage for a size slider. Double-click resets.',
				side: 'bottom',
				align: 'end'
			}
		},
		{
			element: '[data-tour="fullscreen"]',
			popover: {
				title: 'Fullscreen',
				description: 'Just you and the document.',
				side: 'bottom',
				align: 'end'
			}
		},
		{
			element: '[data-tour="help"]',
			popover: {
				title: 'This tour lives here',
				description:
					'The help button adapts to wherever you are — it explains the Voice, LLM, and Appearance pages too.',
				side: 'bottom',
				align: 'end'
			}
		},
		{
			element: '[data-tour="theme"]',
			popover: {
				title: 'Theme',
				description:
					'One click, one theme — keep going around. The full palette and reading fonts live in Appearance.',
				side: 'bottom',
				align: 'end'
			}
		}
	],
	library: [
		{
			element: '[data-tour="add-document"]',
			popover: {
				title: 'Add a document',
				description: 'PDF, DOCX, Markdown, or plain text — or just drop files anywhere.'
			}
		},
		{
			element: '[data-tour="paste-text"]',
			popover: {
				title: 'Paste text',
				description: 'Paste anything; Markdown is detected automatically.'
			}
		},
		{
			element: '[aria-label="Voicebook settings"]',
			popover: {
				title: 'Settings',
				description: 'Voice, LLM, Appearance, and System — each has its own tour.'
			}
		}
	],
	voice: [
		{
			element: 'section[aria-labelledby="speech-engine-choice-title"]',
			popover: {
				title: 'Speech engine',
				description:
					'Who generates the audio: the free on-device engine, or ElevenLabs with your own API key.'
			}
		},
		{
			element: 'section[aria-labelledby="engine-title"]',
			popover: {
				title: 'On-device engine',
				description:
					'Manage the local model and trade generation speed against audio quality with the steps setting.'
			}
		},
		{
			element: 'section[aria-labelledby="voices-title"]',
			popover: {
				title: 'Voices',
				description: 'Preview any voice and pick who reads to you.'
			}
		},
		{
			element: 'section[aria-labelledby="el-voices-title"]',
			popover: {
				title: 'Voices',
				description: 'Your ElevenLabs voices — preview and pick who reads to you.'
			}
		}
	],
	llm: [
		{
			element: 'section[aria-labelledby="llm-engine-title"]',
			popover: {
				title: 'Descriptions engine',
				description:
					'Who rewrites equations, tables, diagrams, and images into speakable words: the on-device model, or Claude, GPT, or Gemini with your key.'
			}
		},
		{
			element: 'section[aria-labelledby="llm-style-title"]',
			popover: {
				title: 'Description style',
				description:
					'Concise states things, Educational explains them. Custom lets you edit the prompts yourself.'
			}
		},
		{
			element: 'section[aria-labelledby="llm-behavior-title"]',
			popover: {
				title: 'Behavior',
				description: 'Turn automatic descriptions on or off, or regenerate everything.'
			}
		},
		{
			element: 'section[aria-labelledby="llm-models-title"]',
			popover: {
				title: 'On-device models',
				description: 'Download, switch, or remove the local language models.'
			}
		}
	],
	appearance: [
		{
			element: 'section[aria-labelledby="theme-title"]',
			popover: {
				title: 'Themes',
				description: 'Ten palettes, light and dark. The header button cycles through them too.'
			}
		},
		{
			element: 'section[aria-labelledby="font-title"]',
			popover: {
				title: 'Reading font',
				description: 'The typeface of the page itself — menus keep their own.'
			}
		}
	],
	system: [
		{
			element: 'section[aria-labelledby="storage-title"]',
			popover: {
				title: 'Storage',
				description:
					'Everything lives on this device. Clear generated audio anytime — documents stay.'
			}
		},
		{
			element: 'section[aria-labelledby="shortcuts-title"]',
			popover: {
				title: 'Shortcuts',
				description: 'Space plays, J and L skip, brackets change speed.'
			}
		},
		{
			element: 'section[aria-labelledby="reset-title"]',
			popover: {
				title: 'Factory reset',
				description: 'The everything-must-go option: documents, audio, models, and keys.'
			}
		}
	]
};

export function readerTourSeen(): boolean {
	try {
		return localStorage.getItem(READER_TOUR_SEEN_KEY) === '1';
	} catch {
		return true;
	}
}

export function markReaderTourSeen(): void {
	try {
		localStorage.setItem(READER_TOUR_SEEN_KEY, '1');
	} catch {
		// Storage can be unavailable; the tour simply offers itself again.
	}
}

/** Start the tour for a surface. Steps whose element is absent (engine-
 * dependent sections, hidden chips) are dropped, so the tour always matches
 * what is actually on screen. */
export function startTour(context: TourContext): void {
	const steps = TOURS[context].flatMap((step) => {
		// Some anchors render in more than one place (library header vs empty
		// state); highlight the first one actually on screen.
		const target = [...document.querySelectorAll(step.element as string)].find(
			(candidate): candidate is HTMLElement =>
				candidate instanceof HTMLElement && candidate.offsetParent !== null
		);
		return target ? [{ ...step, element: target }] : [];
	});
	if (!steps.length) return;
	if (context === 'reader') markReaderTourSeen();
	driver({
		showProgress: steps.length > 1,
		nextBtnText: 'Next',
		prevBtnText: 'Back',
		doneBtnText: 'Done',
		progressText: '{{current}} of {{total}}',
		overlayOpacity: 0.55,
		stagePadding: 6,
		stageRadius: 10,
		steps
	}).drive();
}
