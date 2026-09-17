import { describe, it, expect } from 'vitest';
import {
	featureLuminance,
	glowFromLuminance,
	lonLatToTile,
	percentile,
	sampleCoords
} from '../tools/stamp-road-glow.mjs';

// A city spread like Denver's: p5=0.03 in the dark prairie, p95=0.85
// in the lit core.
const P5 = 0.03;
const P95 = 0.85;

describe('lonLatToTile', () => {
	it('lands on the packed tiles the probe verified by hand', () => {
		// Slippy XYZ at z8; these exact tiles exist in data/tiles/viirs
		// and decoded to the luminances the normalisation is tuned for.
		expect(lonLatToTile(-104.99, 39.75, 8)).toEqual([53, 97]);
		expect(lonLatToTile(78.38, 17.44, 8)).toEqual([183, 115]);
	});
});

describe('glowFromLuminance', () => {
	it('clamps out-of-range input instead of leaking it into the pack', () => {
		expect(glowFromLuminance(-1, P5, P95)).toBeCloseTo(0.12, 10);
		expect(glowFromLuminance(2, P5, P95)).toBe(1);
		expect(glowFromLuminance(P5, P5, P95)).toBeCloseTo(0.12, 10);
		expect(glowFromLuminance(P95, P5, P95)).toBe(1);
	});

	it('fails open to full gain when a pack has no spread at all', () => {
		expect(glowFromLuminance(0.5, 1, 1)).toBe(1);
	});

	it('rises monotonically: rural dim, suburbs mid, cores saturated', () => {
		const rural = glowFromLuminance(0.05, P5, P95);
		const suburb = glowFromLuminance(0.44, P5, P95);
		const core = glowFromLuminance(1, P5, P95);
		expect(rural).toBeLessThan(suburb);
		expect(suburb).toBeLessThan(core);
		// The floor keeps country roads alive rather than deleting them;
		// the curve spreads the city's own tail instead of bunching it.
		expect(rural).toBeGreaterThan(0.15);
		expect(rural).toBeLessThan(0.4);
		expect(suburb).toBeGreaterThan(0.5);
		expect(suburb).toBeLessThan(0.8);
	});

	it('percentiles interpolate between ranks', () => {
		expect(percentile([], 0.5)).toBe(0);
		expect(percentile([0.2, 0.4, 0.6, 0.8], 0)).toBe(0.2);
		expect(percentile([0.2, 0.4, 0.6, 0.8], 1)).toBe(0.8);
		expect(percentile([0, 10], 0.5)).toBe(5);
	});

	it('samples walk arc length, not vertices', () => {
		// Vertices bunched at one end: vertex sampling would read four
		// of its five from the first fifth of the road; arc sampling
		// spreads evenly down the whole length.
		const line = [
			[0, 0],
			[0.005, 0],
			[0.01, 0],
			[0.015, 0],
			[0.02, 0],
			[0.05, 0],
			[0.09, 0]
		];
		const pts = sampleCoords(line);
		expect(pts).toHaveLength(5);
		expect(pts[0][0]).toBeCloseTo(0, 9);
		expect(pts[1][0]).toBeCloseTo(0.0225, 3);
		expect(pts[2][0]).toBeCloseTo(0.045, 3);
		expect(pts[4][0]).toBeCloseTo(0.09, 9);
		// Degenerate (zero-length) features sample their single point.
		expect(sampleCoords([[1, 2]])).toEqual([[1, 2]]);
	});
});

describe('featureLuminance', () => {
	it('reads null for missing or non-linear geometry', () => {
		expect(featureLuminance(null)).toBeNull();
		expect(featureLuminance({})).toBeNull();
		expect(
			featureLuminance({ geometry: { type: 'Point', coordinates: [0, 0] } })
		).toBeNull();
	});
});
