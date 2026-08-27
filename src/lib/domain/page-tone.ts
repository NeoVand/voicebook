/**
 * Printing a page onto the reader's paper.
 *
 * A PDF page is white with black ink on it, which is a fact about the paper it
 * was made for, not about the room it is being read in. The reading view has
 * always drawn the same document on the theme's paper in the theme's ink; this
 * puts the original pages on that same paper, so moving between the two views
 * is a change of typesetting rather than a change of lighting.
 *
 * The transform is a duotone ramp: what was white becomes the theme's paper,
 * what was black becomes its ink, and the greys in between are carried across
 * proportionally. Under a light theme that is a barely visible warming; under
 * a dark one it is a full inversion, arrived at by the same arithmetic rather
 * than by a special case.
 *
 * Colour is left alone. Red warning text stays red and a green curve on a plot
 * stays green — remapping those would be recolouring the author's work rather
 * than the paper it sits on. The line between "paper and ink" and "colour" is
 * chroma, crossed gradually so that the anti-aliased edge of a coloured glyph
 * does not fringe.
 */

export type Rgb = readonly [number, number, number];

/** Below this chroma a pixel is paper, ink, or a grey between them, and is
 * remapped in full. */
const ACHROMATIC = 10;
/** Above this it is the author's colour and is left as it is. Between the two
 * the remap fades out, which is what keeps glyph edges clean. */
const CHROMATIC = 44;

/**
 * Read a CSS colour into channels. Only the forms the theme sheet actually
 * uses need to work — hex and `rgb()` — and anything else is refused rather
 * than guessed at, so a mistyped variable shows up as an untoned page instead
 * of a mysteriously wrong one.
 */
export function parseColor(value: string): Rgb | null {
	const text = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(text);
	if (hex) {
		const digits = hex[1];
		if (digits.length === 3 || digits.length === 4) {
			const [red, green, blue] = [...digits.slice(0, 3)].map((digit) =>
				Number.parseInt(digit + digit, 16)
			);
			return [red, green, blue];
		}
		if (digits.length === 6 || digits.length === 8) {
			return [
				Number.parseInt(digits.slice(0, 2), 16),
				Number.parseInt(digits.slice(2, 4), 16),
				Number.parseInt(digits.slice(4, 6), 16)
			];
		}
		return null;
	}
	const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
	if (!rgb) return null;
	const parts = rgb[1]
		.split(/[\s,/]+/)
		.filter(Boolean)
		.map(Number);
	if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
	return [parts[0], parts[1], parts[2]];
}

/**
 * How far a page's own colouring is from the paper it is being printed onto —
 * 0 when the ramp would change nothing, 1 at a full inversion. Used to decide
 * whether the pass is worth running at all.
 */
export function toneDistance(paper: Rgb, ink: Rgb): number {
	const lightness = (color: Rgb) =>
		(0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
	return Math.abs(1 - lightness(paper)) + lightness(ink);
}

/**
 * Repaint one page's pixels in place.
 *
 * `data` is RGBA as `getImageData` gives it. Every pixel is placed on the ramp
 * by its own lightness — the midpoint of its lightest and darkest channel,
 * which is what keeps a mid-grey mid-way rather than dragging it toward
 * whichever channel happens to dominate — and then mixed back toward its
 * original colour by how chromatic it is.
 */
export function tonePixels(data: Uint8ClampedArray, paper: Rgb, ink: Rgb): void {
	const span = CHROMATIC - ACHROMATIC;
	const rampRed = paper[0] - ink[0];
	const rampGreen = paper[1] - ink[1];
	const rampBlue = paper[2] - ink[2];
	for (let index = 0; index < data.length; index += 4) {
		const red = data[index];
		const green = data[index + 1];
		const blue = data[index + 2];
		const high = red > green ? (red > blue ? red : blue) : green > blue ? green : blue;
		const low = red < green ? (red < blue ? red : blue) : green < blue ? green : blue;
		const chroma = high - low;
		if (chroma >= CHROMATIC) continue;
		const lightness = (high + low) / 510;
		const tonedRed = ink[0] + rampRed * lightness;
		const tonedGreen = ink[1] + rampGreen * lightness;
		const tonedBlue = ink[2] + rampBlue * lightness;
		if (chroma <= ACHROMATIC) {
			data[index] = tonedRed;
			data[index + 1] = tonedGreen;
			data[index + 2] = tonedBlue;
			continue;
		}
		// Part way across: fade the remap out so a coloured glyph's soft edge
		// does not sit in a ring of paper-coloured fringe.
		const keep = (chroma - ACHROMATIC) / span;
		const take = 1 - keep;
		data[index] = red * keep + tonedRed * take;
		data[index + 1] = green * keep + tonedGreen * take;
		data[index + 2] = blue * keep + tonedBlue * take;
	}
}
