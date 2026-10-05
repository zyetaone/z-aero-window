/**
 * Where the sun is, as a unit vector in the scene's frame (x east, y up, z north).
 *
 * Solar time, not the clock on the wall: the hour angle comes from UTC plus
 * longitude, so no time zone table is needed and three panes computing from the
 * same wall second agree. `clockHours` pins local solar time (the `?clock=`
 * param) so a frame-cost run sees the same sky every time. Accurate to about a
 * degree, which is far below what the sky shows.
 */
const RAD = Math.PI / 180;

export type Sun = { x: number; y: number; z: number; elevationDeg: number };

export function sunAt(ms: number, latDeg: number, lonDeg: number, clockHours?: number): Sun {
	const date = new Date(ms);
	const dayOfYear = (ms - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86_400_000;
	const declination = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10)) * RAD;
	const utcHours = (ms / 3_600_000) % 24;
	const solarHours = clockHours ?? (utcHours + lonDeg / 15 + 24) % 24;
	const hourAngle = (solarHours - 12) * 15 * RAD;
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
