/**
 * Window color grade — the finishing pass aero-1 did in shaders, done in CSS.
 *
 * Every layer grades itself at the source (imagery constants, sky curves,
 * wing lighting), so nothing unifies the frame: dusk never warms the whole
 * window. MapLibre offers no shader hooks for a real post chain, and a second
 * WebGL pass would cost Pi frames for subtlety — so the grade is one DOM
 * element with one stacked wash (normal blending, no mix-blend GPU cost):
 * warm amber through civil twilight, transparent by day.
 *
 * Ramps off the same inputs as everything else (the dusk band, off the real sun
 * elevation), so it cannot arrive on a schedule of its own. Pure — unit-tested
 * via grade.test.ts.
 */

import { duskHorizonMix } from '../world/sun.js';
import { clamp01 } from '#lib/angles.js';

/** Peak opacity: a wash, not a filter — the world stays readable. */
export const GRADE_WARM_MAX = 0.14;

/**
 * How warm the window goes at the peak of the dusk band, 0..1.
 *
 * THE COOL WASH THAT WAS HERE IS GONE, and its absence is the finding.
 *
 * It read `night` and tinted the world blue after dark, which was a 16% wash
 * over a black frame — so it lifted the night floor to navy and destroyed the
 * one thing a night window is for: void, and then lights. Measured, the night
 * stopped reading as night.
 *
 * It survived as `GRADE_COOL_MAX = 0` with a comment saying it was "kept as a
 * knob rather than deleted so Grade.svelte's shape stays" — which is a dead
 * knob. A constant no operator can change is not a knob; it is ceremony, and
 * it cost a second fullscreen gradient that was always fully transparent, a
 * `mount` clause that could never be true on its own, and a test named "warms
 * through twilight and cools at night" that asserted the cooling was zero.
 *
 * Deleted rather than re-tuned. If a night scene ever reads flat, the fix is
 * in `world/sun.ts` and the imagery grade — the night is already built from a
 * real sun elevation, a hillshade that stops casting, and VIIRS on
 * `night ** 1.5`. A blue filter on top of that fights it.
 */
export function gradeWarm(night: number, sunElevationDeg: number): number {
	// `night` is a guard, not an input: a NaN anywhere upstream must not be able
	// to paint the window.
	if (!Number.isFinite(night) || !Number.isFinite(sunElevationDeg)) return 0;
	return clamp01(duskHorizonMix(sunElevationDeg)) * GRADE_WARM_MAX;
}
