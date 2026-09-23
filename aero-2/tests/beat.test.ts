import { describe, it, expect } from 'vitest';
import { slowBeat, quantize } from '#lib/display/world/beat.js';

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
