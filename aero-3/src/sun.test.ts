import { expect, test } from 'bun:test';
import { sunAt } from './sun.ts';

const MARCH_EQUINOX = Date.UTC(2026, 2, 20);

test('equator at solar noon on the equinox: sun overhead', () => {
	expect(sunAt(MARCH_EQUINOX, 0, 0, 12).elevationDeg).toBeGreaterThan(88);
});

test('morning sun is east, evening sun is west, midnight is below the horizon', () => {
	expect(sunAt(MARCH_EQUINOX, 17.4, 78.4, 9).x).toBeGreaterThan(0);
	expect(sunAt(MARCH_EQUINOX, 17.4, 78.4, 15).x).toBeLessThan(0);
	expect(sunAt(MARCH_EQUINOX, 17.4, 78.4, 0).elevationDeg).toBeLessThan(-60);
});

test('wall clock and longitude agree with the pinned solar hour', () => {
	// 06:46 UTC at 78.4 E is about solar noon.
	const noon = Date.UTC(2026, 2, 20, 6, 46);
	expect(sunAt(noon, 17.4, 78.4).elevationDeg).toBeCloseTo(sunAt(noon, 17.4, 78.4, 12).elevationDeg, 0);
});
