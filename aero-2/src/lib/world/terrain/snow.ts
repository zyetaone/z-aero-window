/**
 * The snow line, and a colour-relief ramp that respects it.
 *
 * Pure and renderer-free, like everything else in this layer. The component
 * (`Terrain.svelte`) mounts whatever expression comes out; it does not decide
 * where snow starts.
 *
 * WHY IT IS NOT A CONSTANT ALTITUDE
 *
 * The hypsometric ramps in `Terrain.svelte` run sea-level blue through green
 * to grey at 3,000 m and stop. That is correct for a temperate coastal city and
 * wrong everywhere else: the grey at 3,000 m reads as bare rock, which is right
 * in Hyderabad and badly wrong over the Alps or the Rockies, where 3,000 m is
 * above the treeline in most years. The Himalaya entry sits at a 5,000 m mean
 * ground elevation precisely because its peaks are not optional scenery.
 *
 * Snow is the clearest signal that altitude has MEANT something. Without it a
 * 4,500 m massif and a 400 m hill are the same brown, and the window has no way
 * to say which is which — which matters here, because the flight clears local
 * peaks by design and the peaks are the subject.
 *
 * WHY IT IS A FUNCTION OF LATITUDE
 *
 * Persistent snow starts where the climate stops melting it, and that is a
 * latitude curve, not an elevation. The approximation used is the standard
 * one: the snow line falls roughly as `5000 * cos(lat)` metres, reaching the
 * poles at 0 and topping out at 5,000 m on the equator. It is crude next to a
 * real climatology — the Himalaya and the Andes both break it, and the Southern
 * Ocean far exceeds it — but it is monotonic, it is right to within a few
 * hundred metres across most of the inhabited catalogue, and it costs one
 * cosine.
 *
 * `SNOW_LINE_M` is the permanent line. Seasonal snow is deliberately NOT
 * modelled: it would need a month, and a wall that snowed in Denver in July
 * would be making a claim about weather that the band model does not make.
 */

import type { ExpressionSpecification } from 'maplibre-gl';

/** Metres, above sea level, where permanent snow begins. */
export const SNOW_LINE_M = 5_000;

/** The colour above the line. Not pure white — a hillshade is multiplied over it. */
export const SNOW_RGB: readonly [number, number, number] = [236, 240, 246];

/** Fade width, metres. A hard step reads as a contour line drawn on the world. */
export const SNOW_FADE_M = 450;

/**
 * Where permanent snow starts at this latitude, metres above sea level.
 *
 * Clamped to `[0, SNOW_LINE_M]`: `cos` is exact at the equator and negative past
 * 90°, and a negative snow line would put snow on the sea.
 */
export function snowLineM(latDeg: number): number {
	if (!Number.isFinite(latDeg)) return SNOW_LINE_M;
	const c = Math.cos((Math.abs(latDeg) * Math.PI) / 180);
	return Math.max(0, Math.min(SNOW_LINE_M, SNOW_LINE_M * c));
}

/** `[r, g, b]` as the `rgb()` string MapLibre expressions want. */
function rgb(c: readonly [number, number, number]): string {
	return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Append a snow band to a hypsometric ramp.
 *
 * The existing ramps are `['interpolate', ['linear'], ['elevation'], stop, colour,
 * ...]` and stop at 3,000 m. Elevation is unbounded, so an `interpolate` with no
 * final stop holds its last colour forever — which is exactly why a mountain
 * renders as bare grey today.
 *
 * Rather than rewrite the ramps, the snow band is appended as a nested
 * `['interpolate']` selected by latitude, so the authored ramp is untouched and
 * a place whose relief is switched off gets the same behaviour for free.
 */
export function withSnowLine(
	ramp: ExpressionSpecification,
	latDeg: number
): ExpressionSpecification {
	const line = snowLineM(latDeg);
	// Fade IN below the line, i.e. from `line - SNOW_FADE_M` up to `line`.
	const fadeStart = Math.max(0, line - SNOW_FADE_M);

	return [
		'case',
		['<=', ['elevation'], fadeStart],
		ramp,
		['interpolate', ['linear'], ['elevation'], fadeStart, ramp, line, rgb(SNOW_RGB)]
	] as unknown as ExpressionSpecification;
}

/**
 * Whether snow would show at all, so the caller can log the decision instead of
 * mounting an expression that resolves to a constant.
 *
 * A place whose highest ground is far below its own snow line gets nothing —
 * Hyderabad, at a 500 m mean, never sees this. That is the common case and it
 * is why the feature can be cheap: it costs a fill layer only where there is
 * something to draw.
 */
export function snowLineVisible(latDeg: number, groundCeilingM: number): boolean {
	return Number.isFinite(groundCeilingM) && groundCeilingM >= snowLineM(latDeg);
}
