import { describe, it, expect } from 'vitest';
import { moonPosition } from '#lib/display/world/sun.js';

describe('moonPosition', () => {
	const T0 = Date.UTC(2026, 8, 23) / 1000;
	it('is bounded and deterministic', () => {
		for (let k = 0; k < 200; k++) {
			const t = T0 + k * 3_600 * 7;
			const a = moonPosition(t, 25.2, 55.27);
			expect(moonPosition(t, 25.2, 55.27)).toEqual(a);
			expect(a.azimuthDeg).toBeGreaterThanOrEqual(0);
			expect(a.azimuthDeg).toBeLessThan(360);
			expect(Math.abs(a.elevationDeg)).toBeLessThanOrEqual(90);
			expect(a.illumination).toBeGreaterThanOrEqual(0);
			expect(a.illumination).toBeLessThanOrEqual(1);
		}
	});
	it('runs through a full and a new moon inside a month', () => {
		let hi = 0;
		let lo = 1;
		for (let h = 0; h < 30 * 24; h += 6) {
			const m = moonPosition(T0 + h * 3600, 25.2, 55.27).illumination;
			hi = Math.max(hi, m);
			lo = Math.min(lo, m);
		}
		expect(hi).toBeGreaterThan(0.95);
		expect(lo).toBeLessThan(0.05);
	});
	it('rises and sets over a day at mid-latitude', () => {
		let hi = -90;
		let lo = 90;
		for (let h = 0; h < 25; h++) {
			const e = moonPosition(T0 + h * 3600, 39.9, -104.7).elevationDeg;
			hi = Math.max(hi, e);
			lo = Math.min(lo, e);
		}
		expect(hi).toBeGreaterThan(10);
		expect(lo).toBeLessThan(-10);
	});
	it('sits opposite the sun when full: a full moon at local midnight is high', () => {
		// Find the fullest hour in the month, then check it is above the horizon near local midnight.
		let best = { t: T0, ill: 0 };
		for (let h = 0; h < 30 * 24; h++) {
			const t = T0 + h * 3600;
			const ill = moonPosition(t, 25.2, 55.27).illumination;
			if (ill > best.ill) best = { t, ill };
		}
		// Local midnight in Dubai (UTC+4) nearest the full moon.
		const day = Math.floor((best.t + 4 * 3600) / 86_400);
		const midnight = day * 86_400 - 4 * 3600;
		expect(moonPosition(midnight, 25.2, 55.27).elevationDeg).toBeGreaterThan(30);
	});
});
