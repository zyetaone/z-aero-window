/**
 * Atmospheric bands, continuous altitude transitions, and sky/fog color blending.
 * Pure deterministic mathematics — rune-free and renderer-free.
 */

/** Linear RGB, 0..1. */
export type Rgb = readonly [number, number, number];

export interface AtmosphereBand {
	readonly id: string;
	/** Ceiling of the band, and the altitude the HUD label changes at. */
	readonly topM: number;
	readonly fogDensity: number;
	readonly skyTop: Rgb;
	readonly skyHorizon: Rgb;
}

/**
 * `groundDetail`, `deckOpacity`, `nextBandId` and `crossing` used to be here.
 * Nothing outside this file ever read one of them -- the only occurrences of
 * "crossing" in src/ are two prose comments. Four of eight fields were
 * bookkeeping for a consumer that was never written.
 */
export interface AtmosphereState {
	readonly bandId: string;
	readonly fogDensity: number;
	readonly skyTop: Rgb;
	readonly skyHorizon: Rgb;
}

export const ATMOSPHERE_BANDS: readonly AtmosphereBand[] = [
	{
		id: 'ground',
		topM: 1_000,
		fogDensity: 1.0e-4,
		skyTop: [0.35, 0.55, 0.85],
		skyHorizon: [0.75, 0.82, 0.9]
	},
	{
		id: 'haze',
		topM: 3_000,
		fogDensity: 2.5e-4,
		skyTop: [0.3, 0.5, 0.82],
		skyHorizon: [0.7, 0.78, 0.88]
	},
	{
		id: 'midDeck',
		topM: 7_000,
		fogDensity: 4.0e-4,
		skyTop: [0.22, 0.42, 0.78],
		skyHorizon: [0.6, 0.72, 0.86]
	},
	{
		id: 'cirrus',
		topM: 11_000,
		fogDensity: 2.0e-4,
		skyTop: [0.13, 0.3, 0.7],
		skyHorizon: [0.45, 0.6, 0.8]
	},
	{
		id: 'stratosphere',
		topM: Number.POSITIVE_INFINITY,
		fogDensity: 0.8e-4,
		skyTop: [0.04, 0.12, 0.42],
		skyHorizon: [0.22, 0.38, 0.66]
	}
];

/**
 * Where each band's values actually apply: its MIDDLE, not its whole span.
 *
 * The stratosphere is open-ended, so it anchors at a real cruise altitude
 * rather than at infinity.
 */
const STRATOSPHERE_ANCHOR_M = 13_000;

function anchorOf(i: number): number {
	const band = ATMOSPHERE_BANDS[i];
	const floor = i === 0 ? 0 : ATMOSPHERE_BANDS[i - 1].topM;
	return Number.isFinite(band.topM) ? (floor + band.topM) / 2 : STRATOSPHERE_ANCHOR_M;
}

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/**
 * Blend two linear-RGB colours. Exported because Sky.svelte had a byte-identical
 * copy: colour maths that drifts between the band table and the sky dome shows
 * up as a seam, and a seam across a three-pane wall is the whole product failing.
 */
export function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
	return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Linear RGB (0..1) to a CSS `rgba()` string. */
export function cssRgb(c: Rgb, alpha = 1): string {
	return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${alpha})`;
}

/** The band whose span contains this altitude — the HUD label, nothing more. */
function labelFor(h: number): string {
	for (const band of ATMOSPHERE_BANDS) if (h < band.topM) return band.id;
	return ATMOSPHERE_BANDS[ATMOSPHERE_BANDS.length - 1].id;
}

/**
 * The atmosphere at an altitude — a continuous curve through the band table.
 *
 * This used to hold each band's values FLAT across its whole span and then
 * blend over a 200 m boundary. Against bands 2,000-4,000 m tall that is not a
 * transition, it is a cliff: measured across a 0-13,000 m climb the atmosphere
 * was CONSTANT for 11,400 m and changed over only 1,600 m — 88% plateau, four
 * step changes. That is what read as layering. Climbing did not feel like
 * climbing; it felt like crossing four lines.
 *
 * The table is unchanged and still the tuning surface. What changed is that
 * each row is now an anchor at the middle of its band and the curve is
 * interpolated between anchors across the full climb, so every metre of
 * altitude moves the sky. Same peak values, same authored intent, no steps —
 * and less code than the version with the plateau in it.
 */
export function resolveAtmosphere(aglM: number): AtmosphereState {
	const h = Math.max(0, aglM);
	const last = ATMOSPHERE_BANDS.length - 1;

	let i = 0;
	while (i < last - 1 && h >= anchorOf(i + 1)) i++;

	const lo = ATMOSPHERE_BANDS[i];
	const hi = ATMOSPHERE_BANDS[i + 1];
	const a = anchorOf(i);
	const b = anchorOf(i + 1);

	// Flat below the first anchor and above the last: extrapolating a colour
	// ramp past its ends produces channels outside 0..1.
	const raw = (h - a) / (b - a);
	const t = Math.max(0, Math.min(1, raw));

	return {
		bandId: labelFor(h),
		fogDensity: lerp(lo.fogDensity, hi.fogDensity, t),
		skyTop: lerpRgb(lo.skyTop, hi.skyTop, t),
		skyHorizon: lerpRgb(lo.skyHorizon, hi.skyHorizon, t)
	};
}

/**
 * How much the weather takes OUT of the light, 0 (clear) to 1 (storm).
 *
 * `weather` reached the window in exactly two places: turbulence, and droplets
 * on the glass. So a storm was a shaky window with rain on it, over sunlit
 * ground under a blue sky — every photometric property of the scene identical
 * to `clear`. That is the wrong way round: from altitude you cannot feel the
 * turbulence and the droplets are a few pixels, while the thing you cannot
 * miss is that the world has gone grey and flat.
 *
 * Cloud does three things to the light below it, and they are separable:
 *   - it DIMS, because less flux arrives;
 *   - it FLATTENS, because the light arrives from the whole sky rather than
 *     from one disc, which is why shadows and hillshade soften to nothing;
 *   - it DESATURATES toward the neutral grey of the cloud base.
 *
 * One scalar drives all three, so the look cannot drift apart across the four
 * components that consume it. Deliberately NOT a colour or a set of curves:
 * this is the tuning surface the band table already is, and a second colour
 * table would be a second place for the sky to disagree with the ground.
 *
 * Values are the shape of the sky, not a linear ramp on `WEATHERS` — `cloudy`
 * is a bright day with cumulus and barely dims at all, while the step from
 * `rain` to `overcast` is the sky closing over.
 */
const WEATHER_LIGHT_LOSS = {
	clear: 0,
	cloudy: 0.14,
	rain: 0.52,
	overcast: 0.68,
	storm: 0.85
} as const satisfies Record<string, number>;

export function weatherLightLoss(weather: string): number {
	return (WEATHER_LIGHT_LOSS as Record<string, number>)[weather] ?? 0;
}

/**
 * The same colour under cloud: desaturated toward its own grey, and darker.
 *
 * This replaced a FIXED grey, and the fix is worth keeping written down because
 * the fixed version measured backwards. Cloud colour is not an absolute — a
 * storm at noon is mid-grey and a storm at midnight is nearly black — but
 * `OVERCAST_GREY` was one constant for both. Because it is used as fog, and fog
 * thickens with the weather, at storm strength that constant became most of the
 * lower frame: brighter than the night scene it was supposed to be dimming.
 * Measured with the clock frozen so the sun could not move between samples, a
 * storm came out 32% BRIGHTER than clear.
 *
 * Deriving it from the colour it is replacing keeps it circadian for nothing.
 * Luma-preserving desaturation, then a straight multiply: exactly the two
 * things a cloud layer does to the light beneath it, and both relative.
 */
export function cloudedRgb(c: Rgb, loss: number): Rgb {
	const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
	const dim = 1 - loss * 0.55;
	// Toward its own luma (grey) by `loss`, then dimmed by the same scalar.
	return [
		lerp(c[0], luma, loss * 0.8) * dim,
		lerp(c[1], luma, loss * 0.8) * dim,
		lerp(c[2], luma, loss * 0.8) * dim
	];
}
