/**
 * world/sky — sun-position math for the Three-side env layers: the
 * sun-direction vector and the local solar elevation that feeds horizon
 * effects (air mass, low-sun warm shift).
 *
 * The time-of-day RESPONSE curves (visibility, mood phase, ambient) and the
 * per-phase colour palette (SKY_PALETTE) live in world/curves.ts — the
 * single owner of every day/dusk/night response, keyed on the canonical T
 * thresholds. This file holds only the geometric inputs layers build on.
 */

type Vec3 = [number, number, number];

/**
 * Solar declination (radians) for the UTC day `nowMs` falls in — Earth's
 * axial tilt swung through the year, zero at the March equinox (~day 81).
 * Was a constant 0.4 rad (22.9°, a permanent June solstice): Chicago in
 * December got a 47° noon sun. Memoised per day; every pane shares the
 * date, so this stays 3-Pi deterministic.
 */
const _declMemo = { day: NaN, rad: 0 };
export function solarDeclinationRad(nowMs = Date.now()): number {
	const day = Math.floor(nowMs / 86_400_000);
	if (day !== _declMemo.day) {
		const d = new Date(nowMs);
		const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000;
		_declMemo.rad = (23.44 * Math.PI / 180) * Math.sin(((360 / 365) * (doy - 81) * Math.PI) / 180);
		_declMemo.day = day;
	}
	return _declMemo.rad;
}

/**
 * World-space unit vector toward the sun for the given camera longitude
 * (deg) and time-of-day (hours 0-24). Matches the geoToCartesian Z-negation
 * convention so the result composes correctly with our Three.js scene.
 *
 *   t=0  → opposite side (midnight)
 *   t=6  → east of camera (dawn)
 *   t=12 → overhead (noon)
 *   t=18 → west of camera (dusk)
 *
 * Memoised: returns the same Vec3 array for identical (camLonDeg, timeOfDay)
 * inputs. Multiple components (ThreeOverlay, EffectStack, Venus, Wing)
 * each compute this independently in their respective
 * $derived / $effect blocks, the memo collapses 6-8 calls into 1 trig
 * evaluation per frame when inputs are shared.
 *
 * ⚠ ALIASING WARNING: the returned reference is shared across callers and
 * mutated in place on cache miss. Safe for the dominant pattern (caller
 * immediately reads d[0]/d[1]/d[2] and computes a derived value
 * synchronously). UNSAFE if a caller stores the reference and reads from
 * it later — by then another call may have rewritten _sunMemo.result.
 * Don't capture; always read-and-derive in the same synchronous block.
 */
const _sunMemo: { camLonDeg: number; timeOfDay: number; decl: number; result: Vec3 } = {
	camLonDeg: Infinity,
	timeOfDay: Infinity,
	decl: Infinity,
	result: [0, 0, 0],
};
export function computeSunDirection(camLonDeg: number, timeOfDay: number, nowMs = Date.now()): Vec3 {
	const decl = solarDeclinationRad(nowMs);
	if (camLonDeg === _sunMemo.camLonDeg && timeOfDay === _sunMemo.timeOfDay && decl === _sunMemo.decl) {
		return _sunMemo.result;
	}
	const sunLonRad = ((camLonDeg + 180 - timeOfDay * 15) * Math.PI) / 180;
	const cosTilt = Math.cos(decl);
	_sunMemo.result[0] = cosTilt * Math.cos(sunLonRad);
	_sunMemo.result[1] = Math.sin(decl);
	_sunMemo.result[2] = -cosTilt * Math.sin(sunLonRad);
	_sunMemo.camLonDeg = camLonDeg;
	_sunMemo.timeOfDay = timeOfDay;
	_sunMemo.decl = decl;
	return _sunMemo.result;
}


/**
 * Sine of the LOCAL solar elevation for an observer at `latDeg`, at solar
 * `timeOfDay` (hours 0-24). Standard solar-position formula:
 *
 *   sin(elev) = sin(lat)·sin(decl) + cos(lat)·cos(decl)·cos(hourAngle)
 *
 * with the day's declination (solarDeclinationRad, shared with
 * computeSunDirection) and hourAngle = (timeOfDay − 12)/24 · 2π.
 *
 * WHY THIS EXISTS: computeSunDirection's Y component is the sun's projection
 * onto the WORLD polar axis (CameraMirror's frame has +Y = north pole), which
 * is a CONSTANT sin(SUN_TILT) — it is NOT the local "how high is the sun"
 * elevation. Every consumer that wants horizon physics (air mass, horizon
 * boost, low-sun warm shift) must use this function, not sunDir[1].
 *
 * Pure, frame-free, deterministic (3-Pi safe — invariant #4).
 *
 *   t=12 noon    → max elevation for the latitude
 *   t=6 / t=18   → ~0 at the equator (sunrise / sunset)
 *   t=0 midnight → max negative (except polar-summer latitudes)
 */
export const DEG2RAD = Math.PI / 180;

export function sunElevationSin(latDeg: number, timeOfDay: number, nowMs = Date.now()): number {
	const lat = latDeg * DEG2RAD;
	const decl = solarDeclinationRad(nowMs);
	const hourAngle = ((timeOfDay - 12) / 24) * Math.PI * 2;
	return (
		Math.sin(lat) * Math.sin(decl)
		+ Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
	);
}

// Moon phase: Cesium Simon1994PlanetaryPositions handles this via
// atmosphere.ts. Three-side moon billboard also uses Cesium.
