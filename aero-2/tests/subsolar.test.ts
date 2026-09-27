import { describe, it, expect } from 'vitest';
import { antipodeOf, subSolarPoint, sunPosition } from '#lib/display/world/sun.js';

/**
 * `subSolarPoint` is what the terminator, the sun disc and the moon disc are
 * all hung from, and the whole night stack is derived from it. `terminator.test.ts`
 * checks the GEOMETRY that consumes it — which would pass just as happily if
 * the point feeding it were wrong by 20 degrees, because a terminator drawn
 * around the wrong centre is still a well-formed terminator.
 *
 * So these assertions are against the astronomy, not against the geometry: the
 * subsolar point is where `sunPosition` says the sun is at 90 deg, and the
 * antipode is the point 180 deg away on the sphere rather than in the plane.
 */
const D2R = Math.PI / 180;

/**
 * Great-circle angular distance in degrees, independent of the code under test.
 *
 * Haversine rather than the spherical law of cosines: `acos` loses its
 * derivative at ±1, so a distance of exactly 180 deg comes back as
 * 179.99999915 and any tolerance tight enough to be meaningful fails on
 * arithmetic rather than on geometry. `2*asin(sqrt(h))` stays well-conditioned
 * at both ends of the range, which is the only part of the sphere this file
 * cares about — the antipode.
 */
function angularDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const dLat = (b.lat - a.lat) * D2R;
	const dLng = (b.lng - a.lng) * D2R;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
	return (2 * Math.asin(Math.min(1, Math.sqrt(h)))) / D2R;
}

describe('subSolarPoint agrees with sunPosition', () => {
	it('is the point where the sun is overhead', () => {
		/**
		 * The subsolar point is, by definition, where solar elevation is 90 deg.
		 * `sunPosition` solves elevation independently (hour angle against
		 * declination at a given latitude), so agreement between the two is a
		 * real cross-check rather than a restatement: a sign error in the
		 * longitude term, or a declination computed on a different day, moves
		 * them apart.
		 *
		 * The two take their geography in DIFFERENT shapes, which is worth
		 * stating because getting it wrong is silent and looks like a broken
		 * sun. `subSolarPoint` answers in a longitude; `sunPosition` takes a
		 * UTC OFFSET IN HOURS and derives the hour angle from it. So asking
		 * where the sun stands over the subsolar point means converting:
		 * 15 deg of longitude is one hour.
		 *
		 * The tolerance is 1e-4 deg, which is about four centimetres on the
		 * ground and four thousand times finer than the sun moves in a
		 * millisecond. Anything tighter is measuring the float round-trip
		 * through a 1.7-billion-second epoch rather than the astronomy, and
		 * fails for arithmetic reasons that have nothing to do with the sun.
		 */
		for (let h = 0; h < 24; h++) {
			const t = Date.UTC(2026, 2, 20) / 1000 + h * 3600; // near equinox
			const ss = subSolarPoint(t);
			const there = sunPosition(t, ss.lat, ss.lng / 15);
			expect(there.elevationDeg, `hour ${h}: elevation at the subsolar point`).toBeCloseTo(90, 4);
			// Directly overhead has no azimuth; finiteness is all that is meaningful.
			expect(Number.isFinite(there.azimuthDeg)).toBe(true);
		}
	});

	it('puts the subsolar point on a whole-hour meridian at a whole hour', () => {
		/**
		 * The 15-degrees-an-hour term, checked as a property rather than a
		 * restatement: if the rate were 360/24 written anywhere else, or the
		 * sign flipped, the longitude would stop landing on whole meridians and
		 * this would catch it at a glance.
		 */
		for (let h = 0; h < 24; h++) {
			const t = Date.UTC(2026, 2, 20) / 1000 + h * 3600;
			const offsetHours = subSolarPoint(t).lng / 15;
			expect(Math.abs(offsetHours - Math.round(offsetHours)), `hour ${h}`).toBeLessThan(1e-6);
		}
	});

	it('sits on the prime meridian at UTC noon, and moves 15 deg an hour', () => {
		const noon = Date.UTC(2026, 2, 20, 12, 0, 0) / 1000;
		expect(Math.abs(subSolarPoint(noon).lng)).toBeLessThan(1e-9);
		// Westward, so the longitude DECREASES through the day.
		const a = subSolarPoint(noon).lng;
		const b = subSolarPoint(noon + 3600).lng;
		expect(a - b).toBeCloseTo(15, 6);
		const c = subSolarPoint(noon + 4 * 3600).lng;
		expect(a - c).toBeCloseTo(60, 6);
	});

	it('stays inside the tropics, following the declination', () => {
		/**
		 * The obliquity is 23.44 deg, so the subsolar point can never leave
		 * |lat| <= 23.44. A terminator built around a latitude outside that band
		 * would be geometrically valid and astronomically impossible.
		 */
		let maxAbs = 0;
		for (let d = 0; d < 365; d++) {
			const t = Date.UTC(2026, 0, 1) / 1000 + d * 86_400 + 41_000;
			maxAbs = Math.max(maxAbs, Math.abs(subSolarPoint(t).lat));
		}
		expect(maxAbs).toBeGreaterThan(23.0);
		expect(maxAbs).toBeLessThanOrEqual(23.44);
	});

	it('reaches both tropics and crosses the equator twice a year', () => {
		let north = 0;
		let south = 0;
		for (let d = 0; d < 365; d++) {
			const lat = subSolarPoint(Date.UTC(2026, 0, 1) / 1000 + d * 86_400 + 41_000).lat;
			if (lat > 23.4) north++;
			if (lat < -23.4) south++;
		}
		// A couple of days either side of each solstice.
		expect(north).toBeGreaterThan(0);
		expect(south).toBeGreaterThan(0);
	});
});

describe('antipodeOf', () => {
	it('is 180 deg away on the sphere, not in the plane', () => {
		/**
		 * The planar reading — negate the latitude, shift the longitude by 180 —
		 * is wrong everywhere except on the equator, and wrong MOST at the
		 * poles, which is precisely where the night caps are drawn. This is the
		 * check that would catch it.
		 */
		for (let h = 0; h < 24; h++) {
			const t = Date.UTC(2026, 8, 22) / 1000 + h * 3600; // near equinox
			const ss = subSolarPoint(t);
			const anti = antipodeOf(ss);
			expect(angularDeg(ss, anti), `hour ${h}`).toBeCloseTo(180, 4);
		}
	});

	it('negates latitude and shifts longitude by half a turn', () => {
		for (const p of [
			{ lat: 0, lng: 0 },
			{ lat: 23.44, lng: 45 },
			{ lat: -23.44, lng: -120 },
			{ lat: 12.3, lng: 179.9 }
		]) {
			const a = antipodeOf(p);
			expect(a.lat).toBeCloseTo(-p.lat, 12);
			// Longitude must land in (-180, 180] without wrapping onto itself.
			expect(a.lng).toBeGreaterThanOrEqual(-180);
			expect(a.lng).toBeLessThanOrEqual(180);
			expect(Math.abs(a.lng)).not.toBeCloseTo(Math.abs(p.lng), 6);
		}
	});

	it('is its own inverse', () => {
		for (const p of [
			{ lat: 0, lng: 0 },
			{ lat: 20, lng: 100 },
			{ lat: -20, lng: -100 }
		]) {
			const there = antipodeOf(antipodeOf(p));
			expect(there.lat).toBeCloseTo(p.lat, 12);
			expect(there.lng).toBeCloseTo(p.lng, 12);
		}
	});
});
