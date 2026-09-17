import { describe, it, expect } from 'vitest';
import { GRADE_COOL_MAX, GRADE_WARM_MAX, gradeWash } from '#lib/display/cabin/grade.js';

describe('gradeWash', () => {
	it('is transparent by day', () => {
		expect(gradeWash(0, 30)).toEqual({ warm: 0, cool: 0 });
	});

	it('warms through twilight and cools at night', () => {
		// Sun on the horizon: inside the dusk band, night barely started.
		const dusk = gradeWash(0.1, -2);
		expect(dusk.warm).toBeGreaterThan(0);
		expect(dusk.warm).toBeLessThanOrEqual(GRADE_WARM_MAX);
		// Deep night: dusk band gone, cool wash at full weight.
		const night = gradeWash(1, -30);
		expect(night.warm).toBe(0);
		expect(night.cool).toBe(GRADE_COOL_MAX);
	});

	it('stays inside its caps and returns zeros on garbage', () => {
		for (const elev of [-30, -10, -2, 0, 10, 40]) {
			const w = gradeWash(0.7, elev);
			expect(w.warm).toBeGreaterThanOrEqual(0);
			expect(w.warm).toBeLessThanOrEqual(GRADE_WARM_MAX);
			expect(w.cool).toBeGreaterThanOrEqual(0);
			expect(w.cool).toBeLessThanOrEqual(GRADE_COOL_MAX);
		}
		expect(gradeWash(NaN, 0)).toEqual({ warm: 0, cool: 0 });
		expect(gradeWash(0.5, NaN)).toEqual({ warm: 0, cool: 0 });
	});
});
