import { describe, it, expect } from 'vitest';
import {
	resolveFogColor,
	resolveSkyHorizonColor,
	resolveSkyTopColor,
	skyGradientTopPct,
	skyHorizonPct,
	type SkyInputs
} from '#lib/display/world/sky-colors.js';

const DAY_CLEAR: SkyInputs = {
	baseTop: [0.13, 0.3, 0.7],
	baseHorizon: [0.45, 0.6, 0.8],
	sunElevDeg: 47,
	night: 0,
	overcast: 0,
	placeId: 'dubai'
};

describe('resolveSkyTopColor', () => {
	it('passes the band blue through on a clear day', () => {
		const top = resolveSkyTopColor(DAY_CLEAR);
		expect(top[0]).toBeCloseTo(0.13, 5);
		expect(top[1]).toBeCloseTo(0.3, 5);
		expect(top[2]).toBeCloseTo(0.7, 5);
	});

	it('lands on the night vault when the sun is down', () => {
		const top = resolveSkyTopColor({ ...DAY_CLEAR, sunElevDeg: -30, night: 1 });
		expect(top[0]).toBeCloseTo(0.01, 5);
		expect(top[1]).toBeCloseTo(0.02, 5);
		expect(top[2]).toBeCloseTo(0.06, 5);
	});

	it('violets the vault at dusk, not at noon', () => {
		const noon = resolveSkyTopColor(DAY_CLEAR);
		const dusk = resolveSkyTopColor({ ...DAY_CLEAR, sunElevDeg: 2 });
		// Dusk pulls red up and blue down relative to the day vault.
		expect(dusk[0]).toBeGreaterThan(noon[0]);
		expect(dusk[2]).toBeLessThan(noon[2]);
	});
});

describe('resolveSkyHorizonColor', () => {
	it('burns orange at sunset and is gone by mid-morning', () => {
		const sunset = resolveSkyHorizonColor({ ...DAY_CLEAR, sunElevDeg: 1 });
		expect(sunset[0]).toBeGreaterThan(0.6);
		const morning = resolveSkyHorizonColor({ ...DAY_CLEAR, sunElevDeg: 20 });
		expect(morning[0]).toBeCloseTo(DAY_CLEAR.baseHorizon[0], 5);
	});

	it('never glows at midnight, however deep', () => {
		const mid = resolveSkyHorizonColor({ ...DAY_CLEAR, sunElevDeg: -30, night: 1 });
		expect(mid[0]).toBeLessThan(0.1);
	});
});

describe('resolveFogColor', () => {
	it('dusts the Sahara amber and leaves the alpine blue', () => {
		const sahara = resolveFogColor({ ...DAY_CLEAR, placeId: 'dubai' });
		const alpine = resolveFogColor({ ...DAY_CLEAR, placeId: 'himalayas' });
		expect(sahara[0]).toBeGreaterThan(alpine[0]);
	});
});

describe('skyHorizonPct', () => {
	it('puts the horizon 45% down the glass at the default depression', () => {
		// cameraPitchDeg 80 → 10° of depression.
		expect(skyHorizonPct(80)).toBeCloseTo(45, 5);
	});

	it('clamps instead of leaving the frame', () => {
		expect(skyHorizonPct(90)).toBe(36);
		expect(skyHorizonPct(-90)).toBe(100);
	});
});

describe('skyGradientTopPct', () => {
	it('spans half the frame above the horizon', () => {
		expect(skyGradientTopPct(45)).toBe(0); // 45 - 50, clamped at 0
		expect(skyGradientTopPct(80)).toBe(30);
	});

	it('never leaves 0..100', () => {
		expect(skyGradientTopPct(0)).toBe(0);
		expect(skyGradientTopPct(100)).toBe(50);
	});
});
