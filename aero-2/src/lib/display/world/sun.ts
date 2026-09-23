/**
 * Solar diurnal clock, local solar time, and day/night lighting curves.
 * Pure deterministic mathematics — rune-free and renderer-free.
 */

export function resolveLocalHours(wallSec: number, utcOffset: number): number {
	const utcSeconds = wallSec % 86_400;
	const localSeconds = (utcSeconds + utcOffset * 3600 + 86_400) % 86_400;
	return localSeconds / 3600;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

import { DEG2RAD, RAD2DEG, signedDelta } from '#lib/angles.js';

/** Day of year, 1..366, from a wall-clock epoch in seconds. */
function dayOfYear(wallSec: number): number {
	const d = new Date(wallSec * 1000);
	const start = Date.UTC(d.getUTCFullYear(), 0, 0);
	return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86_400_000;
}

export interface SunPosition {
	/** Compass bearing of the sun, degrees clockwise from true north. */
	azimuthDeg: number;
	/** Degrees above the horizon. Negative when the sun is down. */
	elevationDeg: number;
}

/**
 * Solar declination for the day `wallSec` falls in, degrees.
 *
 * One home for the axial-tilt term both `sunPosition` and
 * `localHourAtSunElevation` used to inline separately — two copies of
 * `23.44 * sin(...)` that a leap-year or tilt-model change would have had to
 * find twice.
 */
export function solarDeclination(wallSec: number): number {
	return 23.44 * Math.sin((360 / 365) * (dayOfYear(wallSec) - 81) * DEG2RAD);
}

export interface GeoPoint {
	lat: number;
	lng: number;
}

/**
 * Subsolar point: the lng/lat where the sun is directly overhead right now.
 *
 * UTC noon puts it on the prime meridian by construction (15°/hour westward
 * from there); latitude is the declination. In-map sun/moon discs hang off
 * this — world-fixed, so terrain occludes them and parallax is correct.
 */
export function subSolarPoint(wallSec: number): GeoPoint {
	const utcHours = (((wallSec % 86400) + 86400) % 86400) / 3600;
	return {
		lat: solarDeclination(wallSec),
		lng: ((180 - utcHours * 15 + 540) % 360) - 180
	};
}

/**
 * Antipode of a point. The moon disc parks here: a full moon is opposite the
 * sun, and the new moon (which would sit near the sun) is invisible anyway,
 * so the phase error only ever affects a disc you can barely see. Deliberate
 * simplification, stated so nobody "fixes" it into an ephemeris.
 */
export function antipodeOf(p: GeoPoint): GeoPoint {
	return {
		lat: -p.lat,
		lng: p.lng >= 0 ? p.lng - 180 : p.lng + 180
	};
}

/**
 * Where the sun actually is, for a place and a moment.
 *
 * Standard solar-position geometry: axial tilt gives the declination for the
 * day, the hour angle gives the time of day, and the two combine into a
 * bearing and an altitude. Accurate to a degree or so — far below what a
 * hillshade can show, and enough to make shadows swing the right way through
 * the day instead of being pinned to a hardcoded north-west.
 *
 * Pure and deterministic: same wall-clock second and place on three Pis gives
 * three identical suns, which is what keeps the panorama seam consistent.
 */
export function sunPosition(wallSec: number, lat: number, utcOffset: number): SunPosition {
	const hours = resolveLocalHours(wallSec, utcOffset);
	// Axial tilt, zeroed at the March equinox (~day 81).
	const declination = solarDeclination(wallSec);
	// 15 degrees per hour; negative before local noon, positive after.
	const hourAngle = (hours - 12) * 15;

	const latRad = lat * DEG2RAD;
	const decRad = declination * DEG2RAD;
	const haRad = hourAngle * DEG2RAD;

	const sinElevation =
		Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
	const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation)));

	const cosAzimuth =
		(Math.sin(decRad) - Math.sin(elevation) * Math.sin(latRad)) /
		(Math.cos(elevation) * Math.cos(latRad));
	let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAzimuth))) * RAD2DEG;
	// acos loses the sign: before noon the sun is east, after noon it is west.
	if (hourAngle > 0) azimuth = 360 - azimuth;

	return { azimuthDeg: azimuth, elevationDeg: elevation * RAD2DEG };
}

/**
 * How dark it is: 0 in full day, 1 once the sun is well below the horizon.
 *
 * Takes the sun's ACTUAL elevation, not the clock. The version this replaces
 * was `nightFactor(timeOfDay)` with the hours hardcoded -- dark 21:00-05:00,
 * dusk ramped 17:30-21:00 -- which knows nothing about latitude or season and
 * is therefore only correct near the equator at an equinox. Everywhere else it
 * disagreed with `sunPosition`, computed three lines above it from the same
 * wall-clock second, and the disagreement was visible: at Mumbai 19:41 it
 * returned 0.68 while the sun was 20 degrees below the horizon, so the ground
 * graded to `brightness-max` 0.36 instead of 0.16 and lit the night with a pale
 * sheet brighter than the sky over it. At Chicago's 41.9N the error runs the
 * other way in December -- sunset near 16:20 while this still returned 0, full
 * daylight ground under a dark sky -- and reverses again in June.
 *
 * -12 to +6 is the civil/nautical twilight band. Still pure and still a
 * function of wall-clock and place alone, so three panes agree.
 */
export function nightAmount(sunElevationDeg: number): number {
	return 1 - smoothstep(-12, 6, sunElevationDeg);
}

/**
 * How much sunset colour the sky vault takes, 0..1.
 *
 * Symmetric about the horizon via `Math.abs`, so dawn dims like dusk, and eased
 * rather than linear — a linear ramp changes colour at a constant rate, which
 * reads as a wipe instead of a sunset.
 */
export function duskVaultMix(sunElevationDeg: number): number {
	const t = Math.max(0, Math.min(1, (Math.abs(sunElevationDeg) - -6) / (14 - -6)));
	return 1 - t * t * (3 - 2 * t);
}

/**
 * How much sunset orange the HORIZON takes, 0..1.
 *
 * Was `(15 - elev) / 15`: not symmetric, and still 0.33 at 10 deg of elevation,
 * which is mid-morning. Blending a deep orange into a blue horizon at that
 * strength produces grey-pink mud rather than either colour. Gone by 8 deg.
 *
 * That replacement clamped at -4 and never came back down, so it returned a
 * FULL sunset band for every sun below the horizon -- 1.0 at -18, and 1.0 at
 * -56, which is local midnight in the Sahara with a warm orange glow banding
 * the horizon under a field of stars. It was not a dusk curve, it was a
 * not-daytime curve. `duskVaultMix` escapes the same bug only by accident,
 * through its `Math.abs`.
 *
 * A glow needs a sun to cast it. This one lives in a band: it rises as the sun
 * drops toward the horizon, holds through civil twilight, and is gone by -18
 * where the sky has no sunlight left in it.
 */
export function duskHorizonMix(sunElevationDeg: number): number {
	const lit = smoothstep(-18, -6, sunElevationDeg);
	const notYetDay = 1 - smoothstep(-4, 8, sunElevationDeg);
	return Math.min(lit, notYetDay);
}

/**
 * The local hour at which the sun sits at `targetElevationDeg`, on this day.
 *
 * WHY A PRESET CANNOT JUST NAME AN HOUR. Sunset is not a time of day. At Las
 * Vegas the sun is +10.6 deg at 18:25 in June and -16.4 deg at the same hour in
 * December, so the "Golden Hour Cruise" preset — authored as `localHour: 18.25,
 * // low amber sun, just before the horizon` — was a correct sunset for about
 * four months of the year and pitch dark from October to February. Measured
 * across a full year, its sun elevation ranged +10.5 to -15.2.
 *
 * That is the same class of bug the `localHour` field itself was introduced to
 * fix: the presets were originally authored as `clockOffsetH` deltas, which
 * held only when the real local hour happened to match. This is one layer
 * further out — an hour holds all day but not all YEAR.
 *
 * Solves the standard hour-angle equation for the requested elevation:
 *
 *     sin(elev) = sin(lat)sin(dec) + cos(lat)cos(dec)cos(H)
 *
 * `evening` picks which of the two daily solutions to take; the sun passes
 * every elevation twice, once climbing and once descending.
 *
 * Returns null when the elevation is unreachable that day, which is a real
 * case rather than an error: above the Arctic circle in midsummer the sun
 * never sets, so there is no hour at which it sits at -6. The caller decides
 * what to do, and `applyPreset` falls back to the authored clock hour.
 */
export function localHourAtSunElevation(
	targetElevationDeg: number,
	wallSec: number,
	lat: number,
	evening = true
): number | null {
	const declination = solarDeclination(wallSec);
	const latRad = lat * DEG2RAD;
	const decRad = declination * DEG2RAD;

	const cosH =
		(Math.sin(targetElevationDeg * DEG2RAD) - Math.sin(latRad) * Math.sin(decRad)) /
		(Math.cos(latRad) * Math.cos(decRad));

	// |cosH| > 1 means the sun does not reach that elevation today at all.
	if (!Number.isFinite(cosH) || cosH < -1 || cosH > 1) return null;

	const hourAngle = (Math.acos(cosH) * RAD2DEG) / 15;
	return evening ? 12 + hourAngle : 12 - hourAngle;
}

/**
 * How strongly the window is looking INTO the sun, 0 (away) to 1 (straight at
 * it), for a camera bearing and a sun azimuth.
 *
 * `cos` of the heading delta, rectified — smooth by construction, and it costs
 * nothing that a pane facing away gets exactly zero.
 *
 * Hoisted out of `Sky.svelte` when a second caller appeared. Two components
 * computing the same specular geometry from the same two angles is how the
 * water sheen and the sunward haze end up disagreeing about where the sun is,
 * which on one continuous window reads as a seam.
 */
export function facingSunAmount(cameraBearingDeg: number, sunAzimuthDeg: number): number {
	return Math.max(0, Math.cos(signedDelta(cameraBearingDeg, sunAzimuthDeg) * DEG2RAD));
}

/**
 * Specular response for a horizontal surface: bright when the sun is LOW and
 * the window is pointed at it, gone when the sun is high or behind.
 *
 * The low-sun term is the physical half — a high sun reflects its glint
 * straight back down rather than along the sightline, which is why a lake is a
 * mirror at 18:00 and a flat grey sheet at noon.
 */
export function specularGlint(
	cameraBearingDeg: number,
	sunAzimuthDeg: number,
	sunElevationDeg: number
): number {
	if (sunElevationDeg <= 0) return 0;
	const lowSun = 1 - Math.max(0, Math.min(1, sunElevationDeg / 40));
	return facingSunAmount(cameraBearingDeg, sunAzimuthDeg) * lowSun;
}

/**
 * Shared night-lighting ramp: every emitted-light layer (VIIRS raster,
 * vector roads) fades in on night^NIGHT_LIGHT_RAMP so the two arrive
 * together, and mounts through the ON/OFF hysteresis below (a single epsilon
 * blinked the sources at twilight — see NIGHT_MOUNT_ON).
 *
 * The exponent lived as a bare `1.5` in two components with a comment each
 * swearing they matched. Caps stay local (VIIRS 0.8, roads 1.0) — those are
 * per-layer grades, not the shared curve.
 */
export const NIGHT_LIGHT_RAMP = 1.5;
/**
 * The raster↔vector handover window: street vectors fade in from
 * NIGHT_VECTOR_TOP_M down across NIGHT_VECTOR_SPAN_M, and the VIIRS raster
 * fades out across the same metres. One home because the two sides live in
 * different files (Roads vs NightLights) and silently different windows
 * would read as one layer lagging the other on every descent.
 */
export const NIGHT_VECTOR_TOP_M = 9000;
export const NIGHT_VECTOR_SPAN_M = 5000;
/**
 * The far-field window: the arterial dot layer fades in from
 * NIGHT_FAR_TOP_M down across NIGHT_FAR_SPAN_M, handing over to the
 * near-field vectors exactly where they arrive (NIGHT_VECTOR_TOP_M).
 * One home for the same reason as the pair above: two files share one
 * seam, and a silent 500 m mismatch would double-draw or gap the city
 * on every descent. The bottom of this window IS the top of that one.
 */
export const NIGHT_FAR_TOP_M = 13000;
export const NIGHT_FAR_SPAN_M = 4000;

/**
 * Share of the far-field arterial dots at an altitude: 0 where the
 * near-field vectors have taken over, 1 at cruise. Pure — unit-tested.
 */
export function farFieldShare(aglM: number): number {
	if (!Number.isFinite(aglM)) return 0;
	return Math.max(
		0,
		Math.min(1, (aglM - NIGHT_VECTOR_TOP_M) / NIGHT_FAR_SPAN_M)
	);
}
/**
 * Dusk/dawn mount hysteresis for the night layers.
 *
 * Their opacity ramps cross the mount epsilon SLOWLY at twilight, so a single
 * gate would mount and unmount the source every few frames while it hovers —
 * each remount re-parses Denver's 4.4 MB of GeoJSON and the layer visibly
 * blinks. Latch on above ON_AT, release below OFF_AT.
 */
export const NIGHT_MOUNT_ON = 0.03;
export const NIGHT_MOUNT_OFF = 0.005;

/**
 * Pure hysteresis latch. Returns the new latched state; the caller holds it
 * in $state and feeds it back. Unit-tested: the twilight dither is exactly
 * the class of fault you cannot see in a screenshot.
 */
export function hysteresisGate(
	value: number,
	latched: boolean,
	onAt: number,
	offAt: number
): boolean {
	if (!latched && value > onAt) return true;
	if (latched && value < offAt) return false;
	return latched;
}

/**
 * Lamp shimmer for the vector night lights, a multiplier in [0.8, 1.0].
 *
 * A pure function of wall seconds, so every pane on the wall computes the
 * same value for the same instant without exchanging anything — the flicker
 * cannot drift pane-to-pane the way per-pane timers would. Frequencies stay
 * well under the 5 Hz sampler in Roads.svelte (Nyquist 2.5 Hz), so sampling
 * jitter between panes stays invisible. Unit-tested: bounds and determinism.
 */
export function lampFlicker(tSec: number): number {
	return 0.9 + 0.06 * Math.sin(tSec * 2.1) + 0.04 * Math.sin(tSec * 3.7 + 1.7);
}

/**
 * Sparse-lamp glimmer for the glimmer pass, a multiplier in [0.4, 1.0].
 *
 * The flicker above breathes every lamp together ±10% — coherent, which is
 * why the arterials read as one filament dimming in unison. Real street
 * light shimmers lamp by lamp. A line layer cannot phase-shift per dash, so
 * the glimmer pass runs a second dash train at an incommensurate period and
 * THIS deeper, faster envelope: where the two trains cross, lamps flare and
 * die individually instead of the whole run breathing as one. Same
 * wall-shared contract as lampFlicker (pure in wall seconds, under the 5 Hz
 * sampler's Nyquist). Unit-tested: bounds and determinism.
 */
export function lampGlimmer(tSec: number): number {
	return 0.7 + 0.3 * Math.sin(tSec * 4.7 + 1.3) * Math.sin(tSec * 1.9 + 0.4);
}

export interface MoonPosition extends SunPosition {
	/** Lit fraction of the disc, 0 new to 1 full. */
	illumination: number;
}

/**
 * Where the moon is, and how full. Low-precision lunar theory (a degree or
 * two), which is a painter's accuracy: the disc lands in the right part of
 * the sky on the right side of the wing and waxes on the right week. Pure in
 * `wallSec`, so three panes hang the same moon. Azimuth from north, clockwise.
 */
export function moonPosition(wallSec: number, lat: number, lon: number): MoonPosition {
	// Days since J2000.0 (2000-01-01 12:00 UTC).
	const d = wallSec / 86_400 - 10_957.5;
	const L = (218.316 + 13.176396 * d) * DEG2RAD; // mean longitude
	const M = (134.963 + 13.064993 * d) * DEG2RAD; // mean anomaly
	const F = (93.272 + 13.22935 * d) * DEG2RAD; // argument of latitude
	const lambda = L + 6.289 * DEG2RAD * Math.sin(M);
	const beta = 5.128 * DEG2RAD * Math.sin(F);
	const eps = 23.439 * DEG2RAD;

	const sinDec = Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda);
	const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
	const ra = Math.atan2(
		Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
		Math.cos(lambda)
	);
	const lst = (280.16 + 360.9856235 * d) * DEG2RAD + lon * DEG2RAD;
	const ha = lst - ra;
	const latR = lat * DEG2RAD;
	const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(ha);
	const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
	// atan2 form measured from south, westward; +180 turns it into a compass bearing.
	const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latR) - Math.tan(dec) * Math.cos(latR));
	const azimuthDeg = (((az * RAD2DEG + 180) % 360) + 360) % 360;

	const sunM = (357.528 + 0.9856003 * d) * DEG2RAD;
	const sunLambda = (280.46 + 0.9856474 * d) * DEG2RAD + (1.915 * Math.sin(sunM) + 0.02 * Math.sin(2 * sunM)) * DEG2RAD;
	const illumination = (1 - Math.cos(lambda - sunLambda)) / 2;

	return { azimuthDeg, elevationDeg: alt * RAD2DEG, illumination };
}
