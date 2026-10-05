/**
 * The sky's clock: where the sun is, and how far the stars have turned.
 *
 * Solar time, not the clock on the wall: the hour angle comes from UTC plus
 * longitude, so no time zone table is needed and three panes computing from the
 * same wall second agree. A pinned hour (the `?clock=` param, the slider) is
 * turned into a moment with `atSolarHour`, so sun and stars move together.
 * Apparent solar time: the equation of time (the sun runs up to ~16 minutes
 * ahead of or behind the mean clock through the year) is applied, so the sun
 * stands where it really does; the HUD's hour stays mean solar time.
 */
import { RAD } from './math.ts';
const DAY_MS = 86_400_000;

export type Sun = { x: number; y: number; z: number; elevationDeg: number };

/** Unit vector to the sun in the scene frame (x east, y up, z north). */
export function sunAt(ms: number, latDeg: number, lonDeg: number): Sun {
	const date = new Date(ms);
	const dayOfYear = (ms - Date.UTC(date.getUTCFullYear(), 0, 0)) / DAY_MS;
	const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10)) * RAD;
	// Equation of time in minutes (Spencer's three-term fit, within ~30 s).
	const b = ((2 * Math.PI) / 365) * (dayOfYear - 81);
	const eotMin = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
	const hourAngle = (solarHour(ms, lonDeg) + eotMin / 60 - 12) * 15 * RAD;
	const lat = latDeg * RAD;

	const elevation = Math.asin(
		Math.sin(lat) * Math.sin(declination) +
			Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
	);
	// Azimuth from north, clockwise; atan2 keeps the morning/afternoon sign acos loses.
	const azimuth = Math.atan2(
		-Math.sin(hourAngle),
		Math.tan(declination) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle)
	);

	return {
		x: Math.sin(azimuth) * Math.cos(elevation),
		y: Math.sin(elevation),
		z: Math.cos(azimuth) * Math.cos(elevation),
		elevationDeg: elevation / RAD
	};
}

/** Local solar hour, 0..24. */
export const solarHour = (ms: number, lonDeg: number) => (((ms / 3_600_000 + lonDeg / 15) % 24) + 24) % 24;

/** The moment today (UTC) when it is `hour` local solar time at `lonDeg`. */
export const atSolarHour = (ms: number, lonDeg: number, hour: number) =>
	Math.floor(ms / DAY_MS) * DAY_MS + (hour - lonDeg / 15) * 3_600_000;

/** Local sidereal angle in degrees: how far the sky has turned overhead. */
export const siderealDeg = (ms: number, lonDeg: number) =>
	(280.46061837 + 360.98564736629 * (ms / DAY_MS - 10_957.5) + lonDeg) % 360;
