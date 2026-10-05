import { expect, test } from 'bun:test';
import { atSolarHour, siderealDeg, solarHour, sunAt } from './sun.ts';

const MARCH_EQUINOX = Date.UTC(2026, 2, 20);
const at = (hour: number, lon = 78.4) => atSolarHour(MARCH_EQUINOX, lon, hour);

test('equator on the equinox: the sun is overhead at apparent noon, ~7.5 min after mean noon', () => {
	// The equation of time is about -7.5 min in late March: the real sun runs late.
	expect(sunAt(at(12 + 7.5 / 60, 0), 0, 0).elevationDeg).toBeGreaterThan(89);
	expect(sunAt(at(12, 0), 0, 0).elevationDeg).toBeLessThan(88.5);
});

test('morning sun is east, evening sun is west, midnight is below the horizon', () => {
	expect(sunAt(at(9), 17.4, 78.4).x).toBeGreaterThan(0);
	expect(sunAt(at(15), 17.4, 78.4).x).toBeLessThan(0);
	expect(sunAt(at(0), 17.4, 78.4).elevationDeg).toBeLessThan(-60);
});

test('a pinned solar hour round-trips', () => {
	expect(solarHour(at(18.25), 78.4)).toBeCloseTo(18.25, 6);
});

test('sidereal angle: Greenwich at J2000 noon is 280.46 deg, and the sky gains ~1 deg a day', () => {
	const j2000 = Date.UTC(2000, 0, 1, 12);
	expect(siderealDeg(j2000, 0)).toBeCloseTo(280.46, 2);
	expect((siderealDeg(j2000 + 86_400_000, 0) - siderealDeg(j2000, 0) + 360) % 360).toBeCloseTo(0.9856, 3);
});

test('the moon is full on 26 Oct 2026 and new on 10 Oct 2026', () => {
	const { moonAt } = require('./sun.ts');
	expect(moonAt(Date.parse('2026-10-26T04:00Z'), 17.44, 78.38).illumination).toBeGreaterThan(0.98);
	expect(moonAt(Date.parse('2026-10-10T17:00Z'), 17.44, 78.38).illumination).toBeLessThan(0.02);
});
