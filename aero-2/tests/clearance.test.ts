import { describe, it, expect } from 'vitest';
import {
	DATUM_FALL_PER_SEC,
	DATUM_MARGIN_M,
	resolveClearance,
	smoothDatum
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

describe('smoothDatum', () => {
	it('starts at the margined target — low flight keeps its floor plus margin', () => {
		expect(smoothDatum(null, 500, 0.016)).toBe(500 + DATUM_MARGIN_M);
	});

	it('climbs a newly sampled ridge instantly, margin included', () => {
		// Camera was gliding over the mean; the DEM decodes a ridge 300 m up.
		// Waiting even one frame would put the lens inside the hillside.
		expect(smoothDatum(620, 800, 0.016)).toBe(800 + DATUM_MARGIN_M);
	});

	it('glides down toward a lower target without stepping or crossing', () => {
		const prev = 2000;
		const target = 500;
		const next = smoothDatum(prev, target, 0.016);
		expect(next).toBeLessThan(prev);
		expect(next).toBeGreaterThan(target + DATUM_MARGIN_M);
		// Converges: repeated frames land on the goal, never below it.
		let v = prev;
		for (let i = 0; i < 600; i++) v = smoothDatum(v, target, 0.016);
		expect(v).toBeCloseTo(target + DATUM_MARGIN_M, 6);
	});

	it('holds still when already on the goal', () => {
		expect(smoothDatum(620, 500, 0.016)).toBe(620);
	});

	it('treats a zero or negative dt as no time passing', () => {
		expect(smoothDatum(2000, 500, 0)).toBe(2000);
		expect(smoothDatum(2000, 500, -1)).toBe(2000);
	});

	it('the fall rate is the documented constant, not a second number', () => {
		expect(DATUM_FALL_PER_SEC).toBe(2.5);
		expect(DATUM_MARGIN_M).toBe(120);
	});
});
