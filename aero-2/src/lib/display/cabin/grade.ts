/**
 * Window color grade — the finishing pass aero-1 did in shaders, done in CSS.
 *
 * Every layer grades itself at the source (imagery constants, sky curves,
 * wing lighting), so nothing unifies the frame: dusk never warms the whole
 * window, night never cools it. MapLibre offers no shader hooks for a real
 * post chain, and a second WebGL pass would cost Pi frames for subtlety —
 * so the grade is one DOM element with two stacked washes (normal
 * blending, no mix-blend GPU cost): warm amber through civil twilight,
 * cool blue at night, transparent by day.
 *
 * Ramps off the same inputs as everything else (`night` for the cool
 * wash, the dusk band for the warm one), so it cannot arrive on a
 * schedule of its own. Pure — unit-tested via grade.test.ts.
 */

import { duskHorizonMix } from '../world/sun.js';
import { clamp01 } from '#lib/angles.js';

export interface GradeWash {
	/** Warm dusk wash opacity, 0..1. */
	warm: number;
	/** Cool night wash opacity, 0..1. */
	cool: number;
}

/** Peak opacities: washes, not filters — the world stays readable. */
export const GRADE_WARM_MAX = 0.14;
/**
 * Zero since 2026-09-21: a 16% blue wash over black lifts the night floor to
 * navy, which is the opposite of the Feb look (void, then lights). Kept as a
 * knob rather than deleted so Grade.svelte's shape stays; raise it only if the
 * night reads flat on hardware.
 */
export const GRADE_COOL_MAX = 0;


export function gradeWash(night: number, sunElevationDeg: number): GradeWash {
	if (!Number.isFinite(night) || !Number.isFinite(sunElevationDeg))
		return { warm: 0, cool: 0 };
	const dusk = duskHorizonMix(sunElevationDeg);
	return {
		warm: clamp01(dusk) * GRADE_WARM_MAX,
		cool: clamp01(night) * GRADE_COOL_MAX
	};
}
