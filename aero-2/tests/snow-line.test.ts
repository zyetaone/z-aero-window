import { describe, it, expect } from 'vitest';
import {
	SNOW_FADE_M,
	SNOW_LINE_M,
	SNOW_RGB,
	snowLineM,
	snowLineVisible,
	withSnowLine
} from '#lib/world/terrain/snow.js';
import { LOCATIONS } from '#lib/locations.js';

describe('snowLineM', () => {
	it('is 5,000 m on the equator and falls with latitude', () => {
		expect(snowLineM(0)).toBeCloseTo(SNOW_LINE_M, 6);
		// Monotonic: further from the equator, lower. That is the whole claim.
		let prev = Infinity;
		for (let lat = 0; lat <= 90; lat += 5) {
			const line = snowLineM(lat);
			expect(line, `lat ${lat}`).toBeLessThanOrEqual(prev + 1e-9);
			prev = line;
		}
	});

	it('is symmetric about the equator', () => {
		for (const lat of [0, 15, 30, 45, 60, 80]) {
			expect(snowLineM(lat), `lat ${lat}`).toBeCloseTo(snowLineM(-lat), 9);
		}
	});

	it('reaches the poles and never goes below sea level', () => {
		expect(snowLineM(90)).toBeCloseTo(0, 6);
		expect(snowLineM(-90)).toBeCloseTo(0, 6);
		// Past the pole, cos goes negative. A negative snow line would put snow
		// on the ocean, which is the failure this clamp exists for.
		expect(snowLineM(120)).toBeCloseTo(0, 6);
		expect(snowLineM(-120)).toBeCloseTo(0, 6);
	});

	it('stays inside its envelope for every catalogue place', () => {
		for (const l of LOCATIONS) {
			const line = snowLineM(l.lat);
			expect(line, `${l.id}`).toBeGreaterThanOrEqual(0);
			expect(line, `${l.id}`).toBeLessThanOrEqual(SNOW_LINE_M);
		}
	});

	it('is finite on garbage rather than NaN', () => {
		// A NaN here would propagate into a MapLibre expression, where it fails
		// at style-load time — which takes the whole kiosk page down, per the
		// note in Roads.svelte about `['*', width, 3]`.
		for (const bad of [Number.NaN, Infinity, -Infinity]) {
			expect(Number.isFinite(snowLineM(bad as number))).toBe(true);
		}
	});
});

describe('snowLineVisible', () => {
	it('is true only where the ground reaches the line', () => {
		// The snow line at 45 deg is 5000 * cos(45) = 3,536 m, so a 4,000 m
		// ridge carries snow and a 3,000 m one does not.
		expect(snowLineVisible(45, 4_000)).toBe(true);
		expect(snowLineVisible(45, 3_000)).toBe(false);
		expect(snowLineVisible(20, 400)).toBe(false);
		// The line at 70 deg is 1,710 m, so even a modest hill qualifies.
		expect(snowLineVisible(70, 2_000)).toBe(true);
		expect(snowLineVisible(70, 1_000)).toBe(false);
	});

	it('is false on garbage ground, not true', () => {
		// An unknown ceiling must not switch the layer on: `NaN >= x` is false,
		// which is the answer we want, and the guard says so out loud.
		for (const bad of [Number.NaN, Infinity, -Infinity]) {
			expect(snowLineVisible(45, bad as number)).toBe(false);
		}
	});

	it('is false for a low city and true for the Himalaya', () => {
		const byId = (id: string) => LOCATIONS.find((l) => l.id === id)!;
		/**
		 * Both are judged on their real GROUND, not their climb ceiling. That
		 * distinction is the whole test: the ceiling is 12,500 m at Hyderabad
		 * and 13,000 m over the Himalaya, so a check fed the ceiling passes for
		 * both and learns nothing. `groundElevationM` is the mean terrain, and
		 * snow needs the peaks above it — which is why the Himalaya is asked
		 * about with headroom and Hyderabad is not.
		 */
		const hyderabad = byId('hyderabad');
		const himalayas = byId('himalayas');

		// Hyderabad: 17.4N, so the line is ~4,770 m. Its mean is 500 m and the
		// Deccan tops out near 1,750 m — three kilometres of short.
		expect(snowLineVisible(hyderabad.lat, hyderabad.groundElevationM)).toBe(false);
		expect(snowLineVisible(hyderabad.lat, 2_000)).toBe(false);

		// The Himalaya: 28.0N, line ~4,415 m, and a 5,000 m MEAN. The entry sits
		// there precisely because its peaks are not optional scenery.
		expect(snowLineVisible(himalayas.lat, himalayas.groundElevationM)).toBe(true);
	});
});

describe('withSnowLine', () => {
	const RAMP = ['interpolate', ['linear'], ['elevation'], 0, 'blue', 3_000, 'grey'];

	it('leaves the authored ramp as the default case', () => {
		// The authored ramp must survive intact — it is the tuning surface, and
		// rewriting it per-place would be a second place for the terrain to
		// disagree with itself.
		const out = withSnowLine(RAMP as never, 45) as unknown as unknown[];
		expect(out[0]).toBe('case');
		expect(out[2]).toBe(RAMP);
	});

	it('emits a bounded fade rather than a step', () => {
		const line = snowLineM(45);
		const out = withSnowLine(RAMP as never, 45) as unknown as unknown[];
		const branch = out[3] as unknown[];
		expect(branch[0]).toBe('interpolate');
		// Stops must ascend, or the expression is malformed and MapLibre throws
		// at style load — the failure mode that greens every check and blanks
		// the page.
		const stops = branch.slice(3) as unknown[];
		const elevations = stops.filter((_, i) => i % 2 === 0) as number[];
		expect(elevations.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < elevations.length; i++) {
			expect(elevations[i]).toBeGreaterThan(elevations[i - 1]);
		}
		expect(elevations[0]).toBeCloseTo(Math.max(0, line - SNOW_FADE_M), 6);
		expect(elevations[elevations.length - 1]).toBeCloseTo(line, 6);
	});

	it('reaches the snow colour at the line', () => {
		const out = withSnowLine(RAMP as never, 45) as unknown as unknown[];
		const branch = out[3] as unknown[];
		const stops = branch.slice(3) as unknown[];
		const last = stops[stops.length - 1] as string;
		expect(last).toBe(`rgb(${SNOW_RGB[0]}, ${SNOW_RGB[1]}, ${SNOW_RGB[2]})`);
	});

	it('never asks for a negative elevation stop', () => {
		// At 70 deg the line is below the fade width, so `line - fade` goes
		// negative — and a negative stop on a 0..1 elevation input is nonsense
		// even if MapLibre tolerates it.
		for (const lat of [0, 30, 45, 60, 70, 80, 89]) {
			const out = withSnowLine(RAMP as never, lat) as unknown as unknown[];
			const branch = out[3] as unknown[];
			const stops = branch.slice(3) as unknown[];
			const first = stops[0] as number;
			expect(first, `lat ${lat}`).toBeGreaterThanOrEqual(0);
		}
	});
});
