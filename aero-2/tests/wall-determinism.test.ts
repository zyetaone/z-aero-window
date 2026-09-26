import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { Location } from '#lib/locations.js';

/**
 * Invariant #2 is "the world is a pure function of (wall clock, place, daySeed)"
 * and it is what makes a three-Pi wall one window rather than three.
 *
 * The existing guard SCANS SOURCE for `Math.random` and `+= dt`. That catches
 * the two shapes that have bitten, and it cannot catch a third: any hidden
 * dependence on process state, call order, or how many times a value has been
 * read. So exercise the actual contract instead of the source text.
 */
const pose = (v: ReturnType<typeof calculateCameraView>) =>
	`${v.lat.toFixed(9)},${v.lon.toFixed(9)},${v.aglM.toFixed(6)},` +
	`${v.planeHeadingDeg.toFixed(9)},${v.bankDeg.toFixed(9)},` +
	`${v.cameraBearingDeg.toFixed(9)},${v.cameraPitchDeg.toFixed(9)}`;

const params = (id: string, extra: Record<string, unknown> = {}) =>
	({
		place: Location.byId(id),
		floorM: 400,
		ceilingM: 13_000,
		azimuthDeg: 0,
		pitchDeg: -10,
		...extra
	}) as never;

describe('the wall cannot drift', () => {
	const WALL = 1_770_000_000;

	it('gives the same pose for the same second, no matter the call order', () => {
		const a = pose(calculateCameraView(WALL, params('denver')));
		// Interleave other work: other places, other seconds, many times.
		for (let i = 0; i < 50; i++) {
			calculateCameraView(WALL + i * 991, params('dubai'));
			calculateCameraView(WALL - i * 37, params('mumbai'));
		}
		const b = pose(calculateCameraView(WALL, params('denver')));
		expect(b, 'a second read of the same second drifted').toBe(a);
	});

	it('agrees across the three panes except for the yaw each pane owns', () => {
		const solo = calculateCameraView(WALL, params('denver', { fleetRole: 'solo' }));
		const left = calculateCameraView(WALL, params('denver', { fleetRole: 'left' }));
		const right = calculateCameraView(WALL, params('denver', { fleetRole: 'right' }));

		// Same aircraft: position, altitude, attitude must be identical.
		for (const [name, v] of [
			['left', left],
			['right', right]
		] as const) {
			expect(v.lat, `${name} flew a different aircraft (lat)`).toBe(solo.lat);
			expect(v.lon, `${name} flew a different aircraft (lon)`).toBe(solo.lon);
			expect(v.aglM, `${name} flew a different altitude`).toBe(solo.aglM);
			expect(v.planeHeadingDeg, `${name} had a different heading`).toBe(solo.planeHeadingDeg);
			expect(v.bankDeg, `${name} banked differently`).toBe(solo.bankDeg);
		}

		// Only the window direction differs, and by the declared arc.
		const delta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
		expect(delta(left.cameraBearingDeg, solo.cameraBearingDeg)).toBeCloseTo(24, 6);
		expect(delta(right.cameraBearingDeg, solo.cameraBearingDeg)).toBeCloseTo(24, 6);
	});

	it('is reproducible from a cold module, second by second', () => {
		// A run of consecutive seconds, twice, compared element-wise. Any state
		// that accumulates between calls shows up as a divergence partway in.
		const run = () => {
			const out: string[] = [];
			for (let s = 0; s < 120; s++) out.push(pose(calculateCameraView(WALL + s, params('denver'))));
			return out;
		};
		const first = run();
		const second = run();
		const diverged = first.findIndex((p, i) => p !== second[i]);
		expect(diverged, `diverged at second ${diverged}`).toBe(-1);
	});

	it('never returns a pose below the floor or above the ceiling', () => {
		for (const id of ['denver', 'dubai', 'mumbai', 'ocean', 'himalayas']) {
			const place = Location.byId(id);
			// The envelope is a FACT ABOUT THE PLACE, not a free setting:
			// `setPlace` assigns floor/ceiling from it, and the docstring says the
			// floor must clear local peaks. Passing a flat 400 m (as an earlier
			// version of this test did) puts the aircraft 110 m under Denver's
			// declared floor and into the Front Range.
			for (let s = 0; s < 400; s++) {
				const v = calculateCameraView(
					WALL + s * 7,
					params(id, { floorM: place.climbFloorM, ceilingM: place.climbCeilingM })
				);
				expect(Number.isFinite(v.aglM), `${id} produced a non-finite altitude`).toBe(true);
				expect(v.aglM, `${id} sank below its floor`).toBeGreaterThanOrEqual(place.climbFloorM - 1);
				expect(v.aglM, `${id} climbed past its ceiling`).toBeLessThanOrEqual(
					place.climbCeilingM + 1
				);
			}
		}
	});
});
