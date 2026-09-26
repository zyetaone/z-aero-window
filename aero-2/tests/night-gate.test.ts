import { describe, it, expect } from 'vitest';
import {
	antipodeOf,
	farFieldShare,
	hysteresisGate,
	lampFlicker,
	lampGlimmer,
	NIGHT_MOUNT_OFF,
	NIGHT_MOUNT_ON,
	NIGHT_VECTOR_TOP_M,
	subSolarPoint
} from '#lib/display/world/sun.js';
import { lngLatToMercator01 } from '#lib/display/world/starfield.js';

describe('hysteresisGate', () => {
	it('latches on above ON and releases below OFF', () => {
		expect(hysteresisGate(NIGHT_MOUNT_ON + 0.01, false, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(
			true
		);
		expect(hysteresisGate(NIGHT_MOUNT_OFF - 0.001, true, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(
			false
		);
	});

	it('holds state inside the band instead of dithering', () => {
		const mid = (NIGHT_MOUNT_ON + NIGHT_MOUNT_OFF) / 2;
		expect(hysteresisGate(mid, false, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(false);
		expect(hysteresisGate(mid, true, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(true);
	});

	it('ignores exact-boundary touches (strict comparisons)', () => {
		expect(hysteresisGate(NIGHT_MOUNT_ON, false, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(false);
		expect(hysteresisGate(NIGHT_MOUNT_OFF, true, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF)).toBe(true);
	});
});

describe('lampFlicker', () => {
	it('stays inside [0.8, 1.0] across a full day of seconds', () => {
		for (let t = 0; t < 86_400; t += 7) {
			const v = lampFlicker(t);
			expect(v).toBeGreaterThanOrEqual(0.8);
			expect(v).toBeLessThanOrEqual(1.0);
		}
	});

	it('is deterministic — same wall second, same shimmer on every pane', () => {
		expect(lampFlicker(12345.678)).toBe(lampFlicker(12345.678));
	});

	it('actually varies (a flat flicker is a constant wearing a comment)', () => {
		const samples = new Set([0, 1, 2, 3, 4, 5].map((s) => lampFlicker(s * 0.7).toFixed(4)));
		expect(samples.size).toBeGreaterThan(1);
	});
});

describe('lampGlimmer', () => {
	it('stays inside [0.4, 1.0] across a full day of seconds', () => {
		for (let t = 0; t < 86_400; t += 7) {
			const v = lampGlimmer(t);
			expect(v).toBeGreaterThanOrEqual(0.4);
			expect(v).toBeLessThanOrEqual(1.0);
		}
	});

	it('is deterministic — same wall second, same glimmer on every pane', () => {
		expect(lampGlimmer(12345.678)).toBe(lampGlimmer(12345.678));
	});

	it('swings deeper than the flicker (otherwise it adds no shimmer)', () => {
		let lo = Infinity;
		let hi = -Infinity;
		for (let t = 0; t < 600; t += 1) {
			const v = lampGlimmer(t);
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		expect(hi - lo).toBeGreaterThan(0.3);
	});
});

describe('subSolarPoint', () => {
	it('sits on the prime meridian at UTC noon, ±180 at UTC midnight', () => {
		// 2026-06-21 12:00 UTC: pick any noon timestamp.
		const noon = Date.UTC(2026, 5, 21, 12, 0, 0) / 1000;
		expect(subSolarPoint(noon).lng).toBeCloseTo(0, 0);
		const midnight = Date.UTC(2026, 5, 21, 0, 0, 0) / 1000;
		expect(Math.abs(subSolarPoint(midnight).lng)).toBeCloseTo(180, 0);
	});

	it('circles westward 15°/hour and stays in range', () => {
		const t0 = Date.UTC(2026, 5, 21, 6, 0, 0) / 1000;
		const a = subSolarPoint(t0).lng;
		const b = subSolarPoint(t0 + 3600).lng;
		let d = a - b;
		d = ((d + 540) % 360) - 180;
		expect(d).toBeCloseTo(15, 6);
	});
});

describe('antipodeOf', () => {
	it('mirrors latitude and flips the hemisphere', () => {
		expect(antipodeOf({ lat: 20, lng: 30 })).toEqual({ lat: -20, lng: -150 });
		expect(antipodeOf({ lat: -20, lng: -150 })).toEqual({ lat: 20, lng: 30 });
	});
});

describe('lngLatToMercator01', () => {
	it('maps the world edges into 0..1 without escaping', () => {
		expect(lngLatToMercator01(0, 0)[0]).toBeCloseTo(0.5, 6);
		const [x, y] = lngLatToMercator01(179.9, 85);
		expect(x).toBeGreaterThan(0.99);
		expect(x).toBeLessThanOrEqual(1);
		expect(y).toBeGreaterThanOrEqual(0);
		expect(y).toBeLessThan(0.01);
	});
});

describe('farFieldShare', () => {
	it('is shut where the near vectors own the city and open at cruise', () => {
		expect(farFieldShare(4000)).toBe(0);
		expect(farFieldShare(NIGHT_VECTOR_TOP_M)).toBe(0);
		expect(farFieldShare(11_000)).toBe(0.5);
		expect(farFieldShare(13_000)).toBe(1);
		expect(farFieldShare(20_000)).toBe(1);
	});

	it('ramps monotonically with no gaps or double-draw at the seam', () => {
		let prev = 0;
		for (let agl = 9000; agl <= 13_000; agl += 250) {
			const v = farFieldShare(agl);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
		expect(prev).toBe(1);
	});

	it('stands down on non-finite input rather than poisoning paint', () => {
		expect(farFieldShare(NaN)).toBe(0);
		expect(farFieldShare(Infinity)).toBe(0);
	});
});
