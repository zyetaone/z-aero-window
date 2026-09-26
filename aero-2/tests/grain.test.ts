import { describe, it, expect } from 'vitest';
import { GRAIN_SIZE, grainPng, grainValue } from '#lib/server/grain.js';

describe('grainPng', () => {
	it('is byte-identical across calls (the wall must agree)', () => {
		expect(Buffer.from(grainPng()).equals(Buffer.from(grainPng()))).toBe(true);
	});

	it('parses as a 256x256 8-bit grey PNG', () => {
		const png = grainPng();
		expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		const dv = new DataView(png.buffer, png.byteOffset);
		expect(dv.getUint32(16)).toBe(GRAIN_SIZE);
		expect(dv.getUint32(20)).toBe(GRAIN_SIZE);
		expect(png[24]).toBe(8); // bit depth
		expect(png[25]).toBe(0); // grey
	});

	it('has tooth, not a flat field', () => {
		let lo = 255;
		let hi = 0;
		for (let y = 0; y < GRAIN_SIZE; y += 7) {
			for (let x = 0; x < GRAIN_SIZE; x += 7) {
				const v = grainValue(x, y);
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		expect(hi - lo).toBeGreaterThan(40);
	});

	it('wraps without a seam (tileable)', () => {
		let diff = 0;
		for (let y = 0; y < GRAIN_SIZE; y += 4) {
			diff += Math.abs(grainValue(0, y) - grainValue(GRAIN_SIZE - 1, y));
			diff += Math.abs(grainValue(y, 0) - grainValue(y, GRAIN_SIZE - 1));
		}
		const n = (GRAIN_SIZE / 4) * 2;
		expect(diff / n).toBeLessThan(6);
	});
});
