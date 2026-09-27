import { describe, it, expect } from 'vitest';
import { GRADE_WARM_MAX, gradeWarm } from '#lib/display/cabin/grade.js';

describe('gradeWarm', () => {
	it('is transparent by day', () => {
		expect(gradeWarm(0, 30)).toBe(0);
	});

	it('warms through twilight and is gone again at deep night', () => {
		// Sun on the horizon: inside the dusk band, night barely started.
		const dusk = gradeWarm(0.1, -2);
		expect(dusk).toBeGreaterThan(0);
		expect(dusk).toBeLessThanOrEqual(GRADE_WARM_MAX);

		/**
		 * Deep night is ZERO, and that is the whole point of the assertion.
		 *
		 * This used to read `night.cool === GRADE_COOL_MAX` under the heading
		 * "warms through twilight and cools at night" — asserting, under a name
		 * that promised the opposite, that the night wash was off. The blue
		 * wash it covered lifted the night floor to navy and was deleted; see
		 * `gradeWarm`. A test whose name contradicts its assertion is how a
		 * dead knob survived long enough to need a paragraph.
		 */
		expect(gradeWarm(1, -30)).toBe(0);
	});

	it('stays inside its cap and returns zero on garbage', () => {
		for (const elev of [-30, -10, -2, 0, 10, 40]) {
			const w = gradeWarm(0.7, elev);
			expect(w).toBeGreaterThanOrEqual(0);
			expect(w).toBeLessThanOrEqual(GRADE_WARM_MAX);
		}
		expect(gradeWarm(NaN, 0)).toBe(0);
		expect(gradeWarm(0.5, NaN)).toBe(0);
	});

	it('does not depend on the night scalar — one input, one ramp', () => {
		/**
		 * `night` is only a NaN guard now. A dusk wash that also scaled with
		 * darkness would double-count: `duskHorizonMix` already falls to zero
		 * as the sun drops, and the ground, hillshade and VIIRS each own their
		 * own night ramp. Two ramps on one wash is one seam waiting to open.
		 */
		for (const night of [0, 0.5, 1]) {
			expect(gradeWarm(night, -2)).toBe(gradeWarm(0, -2));
		}
	});
});
