import { describe, it, expect } from 'vitest';
import { blendViews, calculateCameraView } from '#lib/display/flight/view.js';
import { windDriftAngle } from '#lib/display/flight/flight-path.js';
import { readSettings } from '#lib/settings/settings.svelte.js';
import { cruiseStartSec } from '#lib/display/display.svelte.js';

const SEC = 1_788_940_000;
const paramsFor = (search: string) =>
	readSettings(new URL(`http://kiosk.local/${search}`));

describe('blendViews', () => {
	const a = calculateCameraView(SEC, paramsFor('?place=dubai'));
	const b = calculateCameraView(SEC, paramsFor('?place=mumbai'));

	it('holds endpoints exactly', () => {
		const start = blendViews(a, b, 0);
		const end = blendViews(a, b, 1);
		expect(start.lat).toBeCloseTo(a.lat, 9);
		expect(start.lon).toBeCloseTo(a.lon, 9);
		expect(end.lat).toBeCloseTo(b.lat, 9);
		expect(end.lon).toBeCloseTo(b.lon, 9);
	});

	it('passes through the midpoint', () => {
		const mid = blendViews(a, b, 0.5);
		expect(mid.lat).toBeCloseTo((a.lat + b.lat) / 2, 9);
		expect(mid.aglM).toBeCloseTo((a.aglM + b.aglM) / 2, 9);
	});

	it('takes the short way round the antimeridian', () => {
		const east = { ...a, lon: 179, targetLon: 179 };
		const west = { ...b, lon: -179, targetLon: -179 };
		const mid = blendViews(east, west, 0.5);
		// 2 deg apart across the seam, not 358 the long way: |lon| ~ 180.
		expect(Math.abs(mid.lon)).toBeGreaterThan(179);
		expect(Math.abs(mid.targetLon)).toBeGreaterThan(179);
	});

	it('blends headings on the shortest arc', () => {
		const from = { ...a, planeHeadingDeg: 350 };
		const to = { ...b, planeHeadingDeg: 10 };
		const mid = blendViews(from, to, 0.5);
		// 20 deg forward through north, not 340 back: ~0, not ~180.
		const norm = ((mid.planeHeadingDeg % 360) + 360) % 360;
		expect(norm < 1 || norm > 359).toBe(true);
	});

	it('blends the dial across midnight instead of rewinding it', () => {
		const from = { ...a, timeOfDay: 23.5 };
		const to = { ...b, timeOfDay: 0.5 };
		const mid = blendViews(from, to, 0.5);
		// Forward one hour through midnight: 0, not 12.
		expect(mid.timeOfDay! % 24).toBeCloseTo(0, 9);
	});
});

describe('windDriftAngle', () => {
	it('reverses with the flight direction and scales with speed', () => {
		const fwd = windDriftAngle(1000, 1.0, 1);
		const rev = windDriftAngle(1000, 1.0, -1);
		expect(rev).toBeCloseTo(-fwd, 9);
		expect(windDriftAngle(1000, 2.0, 1)).toBeCloseTo(2 * fwd, 9);
		expect(windDriftAngle(0, 1.0, 1)).toBe(0);
	});
});

/**
 * The glide must start where every pane can compute, not where each one looked.
 */
describe('cruiseStartSec', () => {
	const DWELL = 240;

	it('snaps a slot-driven change back to the boundary', () => {
		const boundary = 1_788_940_080 - (1_788_940_080 % DWELL);
		// Three panes notice the same change on three different frames.
		for (const frameOffset of [0, 0.016, 0.25, 0.5, 3.4]) {
			expect(cruiseStartSec(boundary + frameOffset)).toBe(boundary);
		}
	});

	it('leaves a mid-slot change alone, so it still glides', () => {
		const boundary = 1_788_940_080 - (1_788_940_080 % DWELL);
		const midSlot = boundary + 100;
		expect(cruiseStartSec(midSlot)).toBe(midSlot);
	});
});
