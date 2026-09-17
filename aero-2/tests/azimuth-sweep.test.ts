import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import {
	AZIMUTH_SWEEP_DEG,
	DWELL_SEC,
	azimuthSweepAt
} from '#lib/display/flight/flight-path.js';
import { readSettings } from '#lib/settings/settings.svelte.js';
import { signedDelta } from '#lib/angles.js';

const paramsFor = (search = '') => readSettings(new URL(`http://kiosk.local/${search}`));

describe('azimuthSweepAt', () => {
	it('stays inside its amplitude and reaches both sides', () => {
		let min = Infinity;
		let max = -Infinity;
		for (let s = 0; s < DWELL_SEC; s++) {
			const v = azimuthSweepAt(s);
			expect(Math.abs(v)).toBeLessThanOrEqual(AZIMUTH_SWEEP_DEG);
			min = Math.min(min, v);
			max = Math.max(max, v);
		}
		expect(min).toBeCloseTo(-AZIMUTH_SWEEP_DEG, 9);
		expect(max).toBeCloseTo(AZIMUTH_SWEEP_DEG, 9);
	});

	it('repeats every dwell and never steps', () => {
		for (const s of [0, 37, 100, 239.5]) {
			expect(azimuthSweepAt(s + DWELL_SEC)).toBeCloseTo(azimuthSweepAt(s), 9);
			expect(azimuthSweepAt(-s)).toBeCloseTo(azimuthSweepAt(DWELL_SEC - s), 9);
		}
		// One cosine per dwell peaks at ~0.15°/s: the sightline drifts,
		// it does not jump. Bound it at 10x the analytic max.
		let prev = azimuthSweepAt(0);
		for (let s = 1; s <= DWELL_SEC; s++) {
			const v = azimuthSweepAt(s);
			expect(Math.abs(v - prev)).toBeLessThan(1.5);
			prev = v;
		}
	});

	it('is a pure function of the second, zero on garbage', () => {
		expect(azimuthSweepAt(100)).toBe(azimuthSweepAt(100));
		expect(azimuthSweepAt(NaN)).toBe(0);
		expect(azimuthSweepAt(Infinity)).toBe(0);
	});
});

describe('sweep in the view', () => {
	it('adds onto the operator aim without touching the pose', () => {
		const a = calculateCameraView(100, paramsFor('?place=denver&speed=1'));
		const b = calculateCameraView(100, paramsFor('?place=denver&speed=1&azimuth=10'));
		// Same second, same pose — only the bearing moved, by the knob.
		expect(a.lat).toBe(b.lat);
		expect(a.lon).toBe(b.lon);
		expect(signedDelta(a.cameraBearingDeg, b.cameraBearingDeg)).toBeCloseTo(10, 6);
	});

	it('walks the sightline across a visit', () => {
		const early = calculateCameraView(0, paramsFor('?place=denver&speed=1'));
		const mid = calculateCameraView(DWELL_SEC / 2, paramsFor('?place=denver&speed=1'));
		// Sweep alone contributes 2× amplitude between the two ends;
		// the orbit's own turning adds more, never less than half.
		const swing = Math.abs(signedDelta(early.cameraBearingDeg, mid.cameraBearingDeg));
		expect(swing).toBeGreaterThan(AZIMUTH_SWEEP_DEG);
	});

	it('leaves feature transits fixed off the nose', () => {
		// display.test.ts pins the 90° contract; this pins the reason the
		// sweep must not touch it — a transit has no framed subject.
		for (const s of [0, 60, 120, 200]) {
			const v = calculateCameraView(s, paramsFor('?place=ocean&speed=1'));
			const off = Math.abs(signedDelta(v.planeHeadingDeg, v.cameraBearingDeg));
			expect(off).toBeCloseTo(90, 0);
		}
	});
});
