/**
 * Angle arithmetic — the four operations everything on a compass needs.
 *
 * One home, because the codebase had grown FOUR hand-rolled copies of these
 * two-line expressions, and modular arithmetic on headings is exactly the kind
 * of code where a copy drifts silently: `flight-path.ts` and
 * `settings.svelte.ts` each had their own signed wrap, `Sky.svelte` inlined a
 * `+540` variant of the same thing `sun.ts` had just gained, and the bank-sign
 * inversion this review found lived one conceptual step from a bearing
 * convention nobody wrote down. The functions are trivial; the AGREEMENT is
 * the value.
 *
 * At `lib/` root rather than under `flight/` or `world/`, because both slices
 * need it and `settings/` does too — the same placement argument as
 * `throttle.ts`. Pure, rune-free, renderer-free.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Wrap to [0, 360). A compass bearing. */
export function normalizeHeading(deg: number): number {
	return ((deg % 360) + 360) % 360;
}

/**
 * Wrap to [-180, 180). The SHORTEST signed difference convention: use this for
 * "how far and which way", never for a bearing to display.
 */
export function wrapSigned(deg: number): number {
	return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** Signed shortest rotation from `fromDeg` to `toDeg`, -180..180. */
export function signedDelta(fromDeg: number, toDeg: number): number {
	return wrapSigned(toDeg - fromDeg);
}

/** Clamp to [0, 1]. Lives here because every curve in the display needs it. */
export function clamp01(n: number): number {
	return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * Clamp to [min, max]. No finiteness guard, unlike `clamp01`: this is the
 * body `use-blind` had, and a NaN in must stay a NaN out there.
 */
export function clamp(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

/** Linear interpolation. One home; `atmosphere.ts` and `viirs-tint.ts` each had a copy. */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}
