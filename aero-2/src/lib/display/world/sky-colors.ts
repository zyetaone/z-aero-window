/**
 * sky-colors — one home for the sky vault colours.
 *
 * `Sky.svelte` derives these for the MapLibre `setSky` dome and `SkyBackdrop`
 * paints them as a fullscreen gradient underneath the map. Two components
 * computing the same sky from the same inputs is how the dome and the
 * backdrop end up disagreeing about what blue is, which on one continuous
 * window reads as a seam. Every colour both of them need lives here, pure
 * and unit-tested.
 *
 * WHY THE BACKDROP EXISTS AT ALL: MapLibre's sky shader ends with
 * `mix(skyColor, transparent, u_sky_blend)`, where `u_sky_blend` is the
 * globe↔mercator projection transition — 1 in a settled globe view. So in
 * the exact view the kiosk flies, the dome's own gradient is mixed to
 * transparent and only the limb atmosphere-glow (transparent at zenith)
 * remains: the zenith renders canvas-black at 30,000 ft in daylight, while
 * the same colours read blue at close-up where the transition rests at 0.
 * The backdrop is a backstop gradient in the same colours, drawn first, so
 * the sky is blue at every altitude. Verified against the maplibre-gl
 * sources we ship, not assumed.
 */

import { duskHorizonMix, duskVaultMix } from './sun.js';
import { cloudedRgb, lerpRgb, type Rgb } from './atmosphere.js';
import { Location } from '#lib/settings/locations.js';

const DUSK_SKY: Rgb = [0.22, 0.12, 0.32];
const NIGHT_SKY: Rgb = [0.01, 0.02, 0.06];
const DUSK_HORIZON: Rgb = [0.85, 0.42, 0.18];
const NIGHT_HORIZON: Rgb = [0.03, 0.06, 0.14];
const DAY_FOG: Rgb = [0.76, 0.86, 0.96];
const DUST: Rgb = [0.87, 0.75, 0.58];

export interface SkyInputs {
	/** Band-table zenith colour for the current altitude. */
	baseTop: Rgb;
	/** Band-table horizon colour for the current altitude. */
	baseHorizon: Rgb;
	sunElevDeg: number;
	night: number;
	/** 0 (clear) to 1 (storm): shared weather scalar. */
	overcast: number;
	placeId: string;
}

/** Zenith colour: band blue → dusk violet → cloud deck → night. */
export function resolveSkyTopColor(inputs: SkyInputs): Rgb {
	const dusk = duskVaultMix(inputs.sunElevDeg);
	const duskBlended = lerpRgb(inputs.baseTop, DUSK_SKY, dusk * 0.55);
	// Under cloud there is no blue vault to see, only the underside of the
	// deck. Applied BEFORE the night blend so a storm at night stays black
	// rather than being lifted to grey.
	const clouded = cloudedRgb(duskBlended, inputs.overcast);
	return lerpRgb(clouded, NIGHT_SKY, inputs.night);
}

/** Horizon colour: band haze → sunset orange → cloud deck → night. */
export function resolveSkyHorizonColor(inputs: SkyInputs): Rgb {
	// A sunset needs a clear sky; under an overcast the orange is the first
	// thing to go, so the dusk mix is scaled down before it is applied.
	const dusk = duskHorizonMix(inputs.sunElevDeg);
	const duskBlended = lerpRgb(
		inputs.baseHorizon,
		DUSK_HORIZON,
		dusk * (1 - inputs.night) * (1 - inputs.overcast)
	);
	const clouded = cloudedRgb(duskBlended, inputs.overcast);
	return lerpRgb(clouded, NIGHT_HORIZON, inputs.night);
}

/**
 * Fog colour up to the sunward-scatter tint and the night blend, which stay
 * with the dome — the backdrop never draws fog, only sky.
 */
export function resolveFogColor(inputs: SkyInputs): Rgb {
	// Per-place dust: the Sahara horizon is amber while the alpine one stays
	// blue, from the same sky. Day only — dust needs light.
	const dustMix = Math.min(0.5, Location.moodFor(inputs.placeId).dust) * (1 - inputs.night);
	const dusted = lerpRgb(lerpRgb(inputs.baseHorizon, DAY_FOG, 0.45), DUST, dustMix);
	return cloudedRgb(dusted, inputs.overcast);
}

/**
 * Where the horizon sits down the glass, as a percentage from the top.
 *
 * Linear in pitch rather than a projection: the window looks down between
 * roughly -5 and -35 degrees, and across that band an analytic pinhole
 * horizon and a straight line differ by less than the softness of the fade.
 * Tuned against real frames, not derived — an earlier pinhole model put the
 * horizon above the top of frame, which the screenshots contradicted.
 */
export function skyHorizonPct(cameraPitchDeg: number): number {
	// `view.cameraPitchDeg` already contains the bank, so the mask tracks the
	// horizon instead of trying to out-run it.
	const depressionDeg = Math.max(0, 90 - cameraPitchDeg);
	return Math.max(0, Math.min(100, 36 + depressionDeg * 0.9));
}

/**
 * Top of the backdrop gradient, as a percentage from the top of frame.
 *
 * The gradient runs horizon colour at the horizon to zenith colour SPAN
 * points above it, then flat zenith colour to the top of frame. The span is
 * deliberately wider than any plausible horizon error, so a mistuned horizon
 * hides its seam behind terrain instead of drawing a band across the sky.
 */
export const SKY_GRADIENT_SPAN_PCT = 50;

export function skyGradientTopPct(horizonPct: number): number {
	return Math.max(0, Math.min(100, horizonPct - SKY_GRADIENT_SPAN_PCT));
}
