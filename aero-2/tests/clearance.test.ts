import { describe, it, expect } from 'vitest';
import {
	DATUM_FALL_PER_SEC,
	DATUM_MARGIN_M,
	datumAt,
	glideDatum,
	resolveClearance
} from '#lib/display/world/clearance.js';

describe('resolveClearance', () => {
	it('falls back to the mean on anything non-finite, never to zero', () => {
		expect(resolveClearance(500, null)).toEqual({ groundM: 500, sampled: false });
		expect(resolveClearance(500, undefined)).toEqual({ groundM: 500, sampled: false });
		expect(resolveClearance(500, NaN)).toEqual({ groundM: 500, sampled: false });
	});

	it('lets a real sample win when it runs higher than the mean', () => {
		expect(resolveClearance(500, 800)).toEqual({ groundM: 800, sampled: true });
		expect(resolveClearance(500, 200)).toEqual({ groundM: 500, sampled: true });
	});
});

describe('glideDatum / datumAt — closed-form clearance glide', () => {
	const T0 = 1_700_000_000.25;

	it('starts on the margined target — low flight keeps its floor plus margin', () => {
		const g = glideDatum(null, 500, T0);
		expect(datumAt(g, T0)).toBe(500 + DATUM_MARGIN_M);
		expect(datumAt(g, T0 + 30)).toBe(500 + DATUM_MARGIN_M);
	});

	it('climbs a newly sampled ridge instantly, margin included', () => {
		// Camera was gliding over the mean; the DEM decodes a ridge 300 m up.
		// Waiting even one frame would put the lens inside the hillside.
		const overMean = glideDatum(null, 500, T0);
		const g = glideDatum(overMean, 800, T0 + 0.016);
		expect(datumAt(g, T0 + 0.016)).toBe(800 + DATUM_MARGIN_M);
		// Mid-fall too: a ridge above the gliding datum is climbed at once.
		const falling = glideDatum(glideDatum(null, 2000, T0), 500, T0);
		const up = glideDatum(falling, 3000, T0 + 0.016);
		expect(datumAt(up, T0 + 0.016)).toBe(3000 + DATUM_MARGIN_M);
	});

	it('glides down toward a lower target without stepping or crossing', () => {
		const prev = glideDatum(null, 2000 - DATUM_MARGIN_M, T0); // datum 2000
		const g = glideDatum(prev, 500, T0);
		const goal = 500 + DATUM_MARGIN_M;
		const first = datumAt(g, T0 + 0.016);
		expect(first).toBeLessThan(2000);
		expect(first).toBeGreaterThan(goal);
		// Monotone, never below the goal, converged well inside ten seconds.
		let last = 2000;
		for (let t = 0.016; t <= 10; t += 0.016) {
			const v = datumAt(g, T0 + t);
			expect(v).toBeLessThanOrEqual(last);
			expect(v).toBeGreaterThanOrEqual(goal);
			last = v;
		}
		expect(datumAt(g, T0 + 10)).toBeCloseTo(goal, 6);
	});

	it('the fall is a function of the wall second, not of frame cadence', () => {
		// Two panes anchor the same fall; one renders at 60 Hz, the other at a
		// ragged 7 Hz with dropped frames. Same anchor, same second, same datum.
		const anchor = glideDatum(glideDatum(null, 2000, T0), 500, T0);
		let a = anchor;
		let b = anchor;
		for (let i = 1; i <= 120; i++) a = glideDatum(a, 500, T0 + i / 60);
		for (const t of [0.14, 0.31, 0.9, 1.05, 1.7, 2.0]) b = glideDatum(b, 500, T0 + t);
		expect(a).toBe(anchor);
		expect(b).toBe(anchor);
		expect(datumAt(a, T0 + 2)).toBe(datumAt(b, T0 + 2));
		// And the value at 2 s is the closed form, not a frame count.
		const goal = 500 + DATUM_MARGIN_M;
		const expected = goal + (2000 + DATUM_MARGIN_M - goal) * Math.exp(-DATUM_FALL_PER_SEC * 2);
		expect(datumAt(anchor, T0 + 2)).toBeCloseTo(expected, 9);
	});

	it('re-anchors at the current datum when the goal moves lower mid-fall — no jump', () => {
		const g1 = glideDatum(glideDatum(null, 2000, T0), 1000, T0);
		const mid = datumAt(g1, T0 + 0.5);
		const g2 = glideDatum(g1, 300, T0 + 0.5);
		expect(g2.fromM).toBe(mid);
		expect(g2.fromWallSec).toBe(T0 + 0.5);
		expect(datumAt(g2, T0 + 0.5)).toBe(mid);
		expect(datumAt(g2, T0 + 20)).toBeCloseTo(300 + DATUM_MARGIN_M, 6);
	});

	it('a goal raised but still below the current datum keeps gliding, from where it is', () => {
		const g1 = glideDatum(glideDatum(null, 2000, T0), 300, T0);
		const mid = datumAt(g1, T0 + 0.2);
		const g2 = glideDatum(g1, 1000, T0 + 0.2);
		expect(1000 + DATUM_MARGIN_M).toBeLessThan(mid);
		expect(datumAt(g2, T0 + 0.2)).toBe(mid);
		expect(datumAt(g2, T0 + 20)).toBeCloseTo(1000 + DATUM_MARGIN_M, 6);
	});

	it('holds still when already on the goal', () => {
		const g = glideDatum(null, 500, T0);
		expect(glideDatum(g, 500, T0 + 5)).toBe(g);
		expect(datumAt(g, T0 + 5)).toBe(500 + DATUM_MARGIN_M);
	});

	it('a second before the anchor reads the anchor: no time passing, no movement', () => {
		const g = glideDatum(glideDatum(null, 2000, T0), 500, T0);
		expect(datumAt(g, T0)).toBe(2000 + DATUM_MARGIN_M);
		expect(datumAt(g, T0 - 1)).toBe(2000 + DATUM_MARGIN_M);
	});

	it('the fall rate is the documented constant, not a second number', () => {
		expect(DATUM_FALL_PER_SEC).toBe(2.5);
		expect(DATUM_MARGIN_M).toBe(120);
	});
});
