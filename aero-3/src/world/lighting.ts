/**
 * The light of one frame, from the sun's and the moon's height: how dark it is, the
 * exposure the eye adapts to, and every gain that follows from those. Pure, so the
 * rules (and the traps they encode) are tested, and main.ts only applies the numbers.
 */
import { smoothstep } from '../math.ts';

export type Knobs = {
	/** The atmosphere's exposure by day (`?sky=`). */
	sky: number;
	/** How far the eye's exposure rises into the night (`?lift=`). */
	lift: number;
	/** Every emissive gain (`?lamps=`) and the VIIRS carpet's own (`?carpet=`). */
	lamps: number;
	carpet: number;
	/** Moonlight at a full, high moon (`?moonlight=`). */
	moonlight: number;
};
export type Mix = { haze: number; glow: number };

const LAMP_ALPHA = 0.22; // faint per lamp: ~200k additive points sum to a white sheet at anything brighter

/** One frame's numbers. `dayHaze` and `dayLights` are today's (day.ts); `shedding` is a hot Pi. */
export function lightingAt(sunElevationDeg: number, knobs: Knobs, mix: Mix, dayHaze: number, dayLights: number, shedding: boolean) {
	// Lamps, window glow, stars and the eye's twilight adaptation all follow the sun, not the hour.
	const dark = 1 - smoothstep(-8, 2, sunElevationDeg);
	const exposure = knobs.sky + knobs.lift * dark;
	return {
		dark,
		exposure,
		/** Shaded walls take the sky's ambient by day only. */
		ambient: 1 - dark,
		// Exposure multiplies emissive too, so it is divided back out: a gain of 0.12 is 0.12 at night.
		haze: shedding ? 0 : (mix.haze * dayHaze * dark) / exposure,
		emissive: (knobs.lamps * dark) / exposure,
		carpet: (knobs.lamps * dark * knobs.carpet) / exposure,
		// Under 1, always: at 1 an additive material draws in the opaque pass (AGENTS.md traps).
		lampAlpha: Math.min(0.999, LAMP_ALPHA * knobs.lamps * dayLights * dark),
		glowOn: dark > 0.02 && !shedding,
		glow: mix.glow * dark,
		/** The stars come out later than the lamps: only once the sky itself is dark. */
		stars: 1 - smoothstep(-14, -4, sunElevationDeg)
	};
}

/**
 * The moon light: a clear night's skyglow from overhead as the floor, so a new moon is dim, not
 * black; a high, full moon swings the light round to itself and adds up to four times that.
 * `m` is moonAt(); the direction is the light's (toward the ground).
 */
export function moonlightAt(m: { x: number; y: number; z: number; illumination: number; elevationDeg: number }, dark: number, strength: number) {
	const up = m.illumination * smoothstep(-1, 12, m.elevationDeg);
	const [dx, dy, dz] = [-m.x * up, -Math.max(m.y, 0) * up - (1 - up), -m.z * up];
	const len = Math.hypot(dx, dy, dz) || 1;
	return { direction: [dx / len, dy / len, dz / len] as [number, number, number], intensity: strength * dark * (0.25 + 0.75 * up) };
}
