import { describe, it, expect } from 'vitest';
import { slowBeat, quantize, shiftDash } from '#lib/display/world/beat.js';

describe('slowBeat', () => {
	it('stays in [-1, 1] and is pure in the wall clock', () => {
		for (let t = 0; t < 2000; t += 7.3) {
			const v = slowBeat(t, 97, 151);
			expect(Math.abs(v)).toBeLessThanOrEqual(1);
			expect(slowBeat(t, 97, 151)).toBe(v);
		}
	});
	it('does not repeat inside an hour on coprime periods', () => {
		const a = Array.from({ length: 60 }, (_, i) => slowBeat(i * 60, 97, 151).toFixed(3));
		expect(new Set(a).size).toBeGreaterThan(50);
	});
});

describe('quantize', () => {
	it('rounds to the step so equal inputs collapse', () => {
		expect(quantize(0.123456)).toBe(0.12);
		expect(quantize(0.129)).toBe(0.13);
		expect(quantize(0.5, 0.1)).toBe(0.5);
	});
});

describe('shiftDash', () => {
	const P = [1, 4, 0.6, 7];
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	it('keeps the period and starts with a dash', () => {
		for (let o = 0; o < 12.6; o += 0.35) {
			const d = shiftDash(P, o);
			expect(sum(d)).toBeCloseTo(sum(P), 6);
			expect(d.length % 2).toBe(0);
			expect(d.every((v) => v >= 0)).toBe(true);
		}
	});
	it('is the identity at zero offset and wraps at the period', () => {
		expect(shiftDash(P, 0)).toEqual(P);
		expect(sum(shiftDash(P, 12.6))).toBeCloseTo(12.6, 6);
	});
	it('opens with a zero dash when the cut lands in a gap', () => {
		expect(shiftDash(P, 2)[0]).toBe(0);
		expect(shiftDash(P, 0.5)[0]).toBeCloseTo(0.5);
	});
});
