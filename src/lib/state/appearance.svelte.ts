/**
 * Appearance preferences: the color theme and the reading font. Both apply
 * as attributes on <html> (the boot script in app.html restores them before
 * first paint) and persist in localStorage — they are device chrome, not
 * document data.
 */
export type ThemeId =
	'sunny' | 'cloudy' | 'rainy' | 'midnight' | 'forest' | 'cocoa' | 'ocean' | 'aurora';

export interface ThemeSpec {
	id: ThemeId;
	label: string;
	tagline: string;
	/** <meta name="theme-color"> value (the page background). */
	meta: string;
	/** Swatch colors for the appearance picker: bg, surface, primary, accent. */
	swatch: [string, string, string, string];
	dark: boolean;
}

export const THEMES: ThemeSpec[] = [
	{
		id: 'sunny',
		label: 'Sunny',
		tagline: 'Warm paper daylight',
		meta: '#f4efe6',
		swatch: ['#f4efe6', '#fffaf1', '#8a6235', '#9f6c23'],
		dark: false
	},
	{
		id: 'cloudy',
		label: 'Cloudy',
		tagline: 'Cool gray overcast',
		meta: '#edf1f3',
		swatch: ['#edf1f3', '#fbfcfc', '#5b7189', '#8a6b36'],
		dark: false
	},
	{
		id: 'rainy',
		label: 'Rainy',
		tagline: 'Slate blue evening',
		meta: '#101820',
		swatch: ['#101820', '#1b252d', '#8cb8cc', '#d2b47c'],
		dark: true
	},
	{
		id: 'midnight',
		label: 'Midnight',
		tagline: 'Near-black with sage',
		meta: '#0b0c0f',
		swatch: ['#0b0c0f', '#18191d', '#9bc7b0', '#e4b86a'],
		dark: true
	},
	{
		id: 'forest',
		label: 'Forest',
		tagline: 'Moss and fern under canopy',
		meta: '#0a100c',
		swatch: ['#0a100c', '#141c16', '#8ad2a4', '#d8b269'],
		dark: true
	},
	{
		id: 'cocoa',
		label: 'Cocoa',
		tagline: 'Dark chocolate and caramel',
		meta: '#130d09',
		swatch: ['#130d09', '#1e1611', '#dfa96f', '#d9c06a'],
		dark: true
	},
	{
		id: 'ocean',
		label: 'Ocean',
		tagline: 'Deep water and sea glass',
		meta: '#08101a',
		swatch: ['#08101a', '#101924', '#7ec6dd', '#dcb873'],
		dark: true
	},
	{
		id: 'aurora',
		label: 'Aurora',
		tagline: 'Violet night sky',
		meta: '#0d0a15',
		swatch: ['#0d0a15', '#171223', '#c2a5e9', '#e8a9c6'],
		dark: true
	}
];

export type ReaderFontId = 'newsreader' | 'instrument' | 'classic' | 'system';

export interface ReaderFontSpec {
	id: ReaderFontId;
	label: string;
	tagline: string;
	/** For preview rendering in the picker. */
	stack: string;
}

export const READER_FONTS: ReaderFontSpec[] = [
	{
		id: 'newsreader',
		label: 'Newsreader',
		tagline: 'Literary serif — the default',
		stack: "'Newsreader Variable', Newsreader, Georgia, serif"
	},
	{
		id: 'instrument',
		label: 'Instrument Sans',
		tagline: 'Clean modern sans',
		stack: "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, sans-serif"
	},
	{
		id: 'classic',
		label: 'Classic serif',
		tagline: 'Charter and Georgia — bookish',
		stack: "Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif"
	},
	{
		id: 'system',
		label: 'System',
		tagline: 'Whatever this device reads best',
		stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
	}
];

const THEME_KEY = 'voicebook:theme';
const FONT_KEY = 'voicebook:reader-font';
const browser = typeof window !== 'undefined';

export function normalizeTheme(value: string | undefined | null): ThemeId {
	if (value === 'light') return 'cloudy';
	if (value === 'dark') return 'midnight';
	return THEMES.some((theme) => theme.id === value) ? (value as ThemeId) : 'midnight';
}

function normalizeFont(value: string | undefined | null): ReaderFontId {
	return READER_FONTS.some((font) => font.id === value) ? (value as ReaderFontId) : 'newsreader';
}

export class AppearanceState {
	// The boot script stamped the attributes before hydration; trust them.
	theme = $state<ThemeId>(
		normalizeTheme(browser ? document.documentElement.dataset.theme : undefined)
	);
	readerFont = $state<ReaderFontId>(
		normalizeFont(browser ? document.documentElement.dataset.readerFont : undefined)
	);

	get themeSpec(): ThemeSpec {
		return THEMES.find((theme) => theme.id === this.theme) ?? THEMES[3];
	}

	setTheme(theme: ThemeId): void {
		this.theme = theme;
		if (!browser) return;
		document.documentElement.dataset.theme = theme;
		window.localStorage.setItem(THEME_KEY, theme);
		document
			.querySelector('meta[name="theme-color"]')
			?.setAttribute('content', this.themeSpec.meta);
	}

	/** The header button flips between the light and dark side of the aisle,
	 * keeping the full pick in Settings → Appearance. */
	toggleLightDark(): void {
		this.setTheme(this.themeSpec.dark ? 'sunny' : 'midnight');
	}

	setReaderFont(font: ReaderFontId): void {
		this.readerFont = font;
		if (!browser) return;
		if (font === 'newsreader') delete document.documentElement.dataset.readerFont;
		else document.documentElement.dataset.readerFont = font;
		window.localStorage.setItem(FONT_KEY, font);
	}
}

export const appearanceState = new AppearanceState();
