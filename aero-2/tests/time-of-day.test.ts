import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { Location } from '#lib/settings/locations.js';
import { sunPosition, nightAmount } from '#lib/display/world/sun.js';

/**
 * Does the window show the RIGHT time, and does the clock offset mean what an
 * operator thinks it means?
 *
 * `clockOffsetH` is an offset applied to the location's own UTC offset, not an
 * absolute hour. That distinction has already caused one real bug in this repo
 * — probe-layers hardcoded `clock=12` believing it meant midnight, and reported
 * a working roads layer as broken for half of every day. So the arithmetic is
 * worth pinning down rather than assuming.
 */
const params = (id: string, clockOffsetH = 0) => {
	const place = Location.byId(id);
	return {
		place,
		floorM: place.climbFloorM,
		ceilingM: place.climbCeilingM,
		azimuthDeg: 0,
		pitchDeg: -10,
		clockOffsetH
	} as never;
};

describe('real time vs the clock offset', () => {
	it('tracks real wall-clock time when no offset is set', () => {
		// A known instant: 2026-01-15 18:00:00 UTC.
		const wallSec = Date.UTC(2026, 0, 15, 18, 0, 0) / 1000;
		const denver = Location.byId('denver');
		const v = calculateCameraView(wallSec, params('denver'));
		// Denver in January is UTC-7, so 18:00 UTC is 11:00 local.
		const expected = (18 + denver.utcOffset + 24) % 24;
		expect(v.timeOfDay).toBeCloseTo(expected, 3);
	});

	it('shifts by exactly the offset, in hours', () => {
		const wallSec = Date.UTC(2026, 0, 15, 18, 0, 0) / 1000;
		const base = calculateCameraView(wallSec, params('denver')).timeOfDay;
		for (const off of [-12, -5, -1, 1, 5, 12]) {
			const got = calculateCameraView(wallSec, params('denver', off)).timeOfDay;
			const want = (((base + off) % 24) + 24) % 24;
			expect(got, `offset ${off} did not shift by ${off}h`).toBeCloseTo(want, 3);
		}
	});

	it('advances one hour of local time per hour of wall clock', () => {
		const start = Date.UTC(2026, 5, 1, 0, 0, 0) / 1000;
		for (let h = 0; h < 24; h++) {
			const v = calculateCameraView(start + h * 3600, params('denver'));
			const prev = calculateCameraView(start + (h - 1) * 3600, params('denver'));
			const step = (((v.timeOfDay - prev.timeOfDay) % 24) + 24) % 24;
			expect(step, `hour ${h} did not advance by 1`).toBeCloseTo(1, 3);
		}
	});

	it('puts each location in its own local time, not the host machine time', () => {
		const wallSec = Date.UTC(2026, 5, 15, 12, 0, 0) / 1000;
		const seen = new Map<string, number>();
		for (const id of ['denver', 'dubai', 'mumbai', 'chicago_midway']) {
			seen.set(id, calculateCameraView(wallSec, params(id)).timeOfDay);
		}
		// Different longitudes must give different local hours at one instant.
		expect(new Set([...seen.values()].map((v) => Math.round(v))).size).toBeGreaterThan(1);
		// And each must match its own declared UTC offset.
		for (const [id, tod] of seen) {
			const want = (((12 + Location.byId(id).utcOffset) % 24) + 24) % 24;
			expect(tod, `${id} is not on its own clock`).toBeCloseTo(want, 3);
		}
	});

	it('is dark at local midnight and light at local noon', () => {
		const place = Location.byId('denver');
		// Choose the wall second that puts Denver at 00:00 and 12:00 local.
		const midnightUtcH = (0 - place.utcOffset + 24) % 24;
		const noonUtcH = (12 - place.utcOffset + 24) % 24;
		const day = Date.UTC(2026, 5, 15, 0, 0, 0) / 1000;

		// (wallSec, lat, utcOffset) — and nightAmount takes the ELEVATION, not
		// the whole position.
		const night = nightAmount(
			sunPosition(day + midnightUtcH * 3600, place.lat, place.utcOffset).elevationDeg
		);
		const noon = nightAmount(
			sunPosition(day + noonUtcH * 3600, place.lat, place.utcOffset).elevationDeg
		);
		expect(night, 'local midnight was not dark').toBeGreaterThan(0.8);
		expect(noon, 'local noon was not light').toBeLessThan(0.2);
	});
});
