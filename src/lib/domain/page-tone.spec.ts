import { describe, expect, it } from 'vitest';
import { parseColor, toneDistance, tonePixels, type Rgb } from './page-tone';

const PAPER_DARK: Rgb = [24, 25, 29];
const INK_LIGHT: Rgb = [244, 241, 233];
const PAPER_WARM: Rgb = [255, 250, 241];
const INK_DARK: Rgb = [35, 31, 25];

/** One pixel through the ramp, as [r, g, b]. */
function toned(pixel: [number, number, number], paper: Rgb, ink: Rgb): number[] {
	const data = new Uint8ClampedArray([...pixel, 255]);
	tonePixels(data, paper, ink);
	return [data[0], data[1], data[2]];
}

describe('parseColor', () => {
	it('reads the forms the theme sheet uses', () => {
		expect(parseColor('#18191d')).toEqual([24, 25, 29]);
		expect(parseColor('#FFF')).toEqual([255, 255, 255]);
		expect(parseColor('  rgb(12, 34, 56)  ')).toEqual([12, 34, 56]);
		expect(parseColor('rgba(12 34 56 / 0.5)')).toEqual([12, 34, 56]);
	});

	it('refuses what it cannot read rather than guessing', () => {
		expect(parseColor('hsl(200 20% 30%)')).toBeNull();
		expect(parseColor('rebeccapurple')).toBeNull();
		expect(parseColor('#12')).toBeNull();
		expect(parseColor('rgb(1, 2)')).toBeNull();
	});
});

describe('toneDistance', () => {
	it('is nothing when the paper is already white under black ink', () => {
		expect(toneDistance([255, 255, 255], [0, 0, 0])).toBeCloseTo(0);
	});

	it('is at its largest for a full inversion', () => {
		expect(toneDistance([0, 0, 0], [255, 255, 255])).toBeCloseTo(2);
	});

	it('separates a warm light theme from a dark one', () => {
		expect(toneDistance(PAPER_WARM, INK_DARK)).toBeLessThan(0.2);
		expect(toneDistance(PAPER_DARK, INK_LIGHT)).toBeGreaterThan(1.5);
	});
});

describe('tonePixels', () => {
	it('prints white paper as the theme’s paper', () => {
		expect(toned([255, 255, 255], PAPER_DARK, INK_LIGHT)).toEqual([...PAPER_DARK]);
	});

	it('prints black ink as the theme’s ink', () => {
		expect(toned([0, 0, 0], PAPER_DARK, INK_LIGHT)).toEqual([...INK_LIGHT]);
	});

	it('carries a mid grey to the middle of the ramp', () => {
		const [red] = toned([128, 128, 128], PAPER_DARK, INK_LIGHT);
		expect(red).toBeGreaterThan(Math.min(PAPER_DARK[0], INK_LIGHT[0]));
		expect(red).toBeLessThan(Math.max(PAPER_DARK[0], INK_LIGHT[0]));
	});

	it('keeps the greys in order, so a rule stays lighter than the type', () => {
		const type = toned([20, 20, 20], PAPER_DARK, INK_LIGHT)[0];
		const rule = toned([160, 160, 160], PAPER_DARK, INK_LIGHT)[0];
		// Under a dark theme the ramp runs the other way: darker ink prints
		// lighter, and the order has to survive intact either way.
		expect(type).toBeGreaterThan(rule);
	});

	it('leaves the author’s colour alone', () => {
		expect(toned([220, 30, 30], PAPER_DARK, INK_LIGHT)).toEqual([220, 30, 30]);
		expect(toned([40, 160, 90], PAPER_WARM, INK_DARK)).toEqual([40, 160, 90]);
	});

	it('fades the remap out across the edge of a coloured glyph', () => {
		// A pixel half way between grey and colour comes out between the two,
		// rather than snapping to one of them and fringing the letter. The grey
		// it is compared against is the one of the same lightness, so only the
		// chroma differs.
		const [red] = toned([150, 128, 128], PAPER_DARK, INK_LIGHT);
		const fully = toned([139, 139, 139], PAPER_DARK, INK_LIGHT)[0];
		expect(red).toBeGreaterThan(Math.min(150, fully));
		expect(red).toBeLessThan(Math.max(150, fully));
	});

	it('barely touches a page under a paper-white theme', () => {
		const [red, green, blue] = toned([255, 255, 255], PAPER_WARM, INK_DARK);
		expect(Math.abs(red - 255)).toBeLessThanOrEqual(1);
		expect(Math.abs(green - 250)).toBeLessThanOrEqual(1);
		expect(Math.abs(blue - 241)).toBeLessThanOrEqual(1);
	});

	it('leaves alpha alone', () => {
		const data = new Uint8ClampedArray([255, 255, 255, 137]);
		tonePixels(data, PAPER_DARK, INK_LIGHT);
		expect(data[3]).toBe(137);
	});

	it('walks a whole buffer, not just its first pixel', () => {
		const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
		tonePixels(data, PAPER_DARK, INK_LIGHT);
		expect([data[0], data[1], data[2]]).toEqual([...PAPER_DARK]);
		expect([data[4], data[5], data[6]]).toEqual([...INK_LIGHT]);
	});
});
