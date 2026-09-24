import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { readSettings } from '#lib/settings/settings.svelte.js';
import { ALTITUDE_CEILING_M, ALTITUDE_FLOOR_M, CLIMB_PERIOD_SEC, DWELL_SEC } from '#lib/display/flight/flight-path.js';

const paramsFor = (place: string) => readSettings(new URL(`http://kiosk.local/?place=${place}&role=center`));
const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number) => {
	const dLat = (aLat - bLat) * 111.32;
	const dLon = (aLon - bLon) * 111.32 * Math.cos((bLat * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
};
const SLOT0 = Math.floor(1_790_129_700 / DWELL_SEC) * DWELL_SEC;

/**
 * The flown altitude, second by second, over whole slots. The continuity test
 * in downtown.test.ts guards lateral jumps; nothing guarded the vertical.
 * Measured before this test existed: 145 m/s (28,000 ft/min) descents, more
 * than twice a slot, because the 900 s cosine rode the 4x speed-scaled loop
 * clock and the pass then pulled a 9 km climb down in 90 s.
 */
describe('vertical rate', () => {
	// The cosine's own peak is pi * band / period (~26 m/s for the default
	// band); the pass ramp and the altitude wander sit on top. 45 leaves the
	// design headroom and would still catch the 106 and 145 this replaces.
	const MAX_M_PER_S = 45;
	const COSINE_PEAK = (Math.PI * (ALTITUDE_CEILING_M - ALTITUDE_FLOOR_M)) / CLIMB_PERIOD_SEC;
	it('bounds the limit against the curve it bounds', () => {
		expect(COSINE_PEAK).toBeLessThan(MAX_M_PER_S);
		expect(COSINE_PEAK).toBeGreaterThan(MAX_M_PER_S / 2);
	});

	for (const place of ['dubai', 'denver', 'hyderabad', 'himalayas']) {
		it(`${place}: never climbs or descends faster than ${MAX_M_PER_S} m/s inside a slot`, () => {
			const cfg = paramsFor(place);
			for (let slot = 0; slot < 4; slot++) {
				const start = SLOT0 + slot * DWELL_SEC;
				let prev = calculateCameraView(start, cfg).aglM;
				for (let t = 1; t < DWELL_SEC; t++) {
					const agl = calculateCameraView(start + t, cfg).aglM;
					expect(Math.abs(agl - prev), `${place} slot ${slot} t=${t}`).toBeLessThan(MAX_M_PER_S);
					prev = agl;
				}
			}
		});
	}

	it('the pass still engages: a city threads downtown in at least one of two consecutive slots', () => {
		for (const place of ['dubai', 'denver', 'hyderabad']) {
			const cfg = paramsFor(place);
			const near = [0, 1].map((slot) => {
				const v = calculateCameraView(SLOT0 + slot * DWELL_SEC + 150, cfg);
				return kmBetween(v.lat, v.lon, cfg.place.lat, cfg.place.lon) < 8;
			});
			expect(near.some(Boolean), `${place}: pass never engaged`).toBe(true);
		}
	});
});
