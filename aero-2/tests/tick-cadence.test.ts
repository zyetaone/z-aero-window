/**
 * FRAME-RATE INVARIANCE — the product invariant, tested as a property.
 *
 * ADR-007 says three panes form one window and never talk to each other: every
 * pane derives its picture from the wall clock alone, so a pane that renders at
 * 3 fps must land on the same image as one rendering at 60 fps, and a pane that
 * stalls must not fall behind. That is a PROPERTY of the tick, and this is the
 * only test that states it directly.
 *
 * WHY IT EXISTS — it is a direct replacement for a hole in the source-scanning
 * guard. `tests/integration.test.ts` asserts "integrates no frame deltas" with
 *
 *     /(\w+)\s*\+=\s*[^;\n]*\b(dt|delta|deltaMs|elapsed|frameTime)\b/
 *
 * which only matches the `+=` FORM. The clearance integrator that 5a9c97f2
 * replaced was written as
 *
 *     return prev + (goal - prev) * step;
 *
 * — a return, not `+=`. Reintroducing that exact bug, in that exact shape,
 * leaves the guard PASSING (verified: 1 passed, 0 failed). So the automated
 * wall-sync guard was blind to the very bug class it exists to prevent, and
 * only tests/clearance.test.ts stood behind it. A new module with no dedicated
 * test would have integrated frame deltas with nothing to catch it.
 *
 * This test does not care what shape the code is. It drives the tick at two
 * cadences to the same wall second and compares what came out. `+= dt`,
 * `return a + (b - a) * k`, an accumulator in a class field, a private clock
 * smuggled past the scanner — all of them fail this, whatever they are called.
 *
 * LIMITATIONS, stated rather than discovered later.
 *
 * 1. It does not cover the STAGE path. It drives `AeroDisplay.advanceTo`, which
 *    covers the flight model, director, sun, weather and phase — the largest
 *    wall-sync surface. It does NOT reach the terrain/burial path, because
 *    `clearance.ts` is fed by the Stage querying a MapLibre map, and that needs
 *    a GL context. Verified: reintroducing an accumulator into `clearance.ts`
 *    leaves THIS test green. `tests/clearance.test.ts` is what catches that, and
 *    the widened scanner in `tests/integration.test.ts` is the backstop.
 * 2. A cadence dependence that happened to cancel over the sampled window would
 *    pass. Hence one dwell (600 s) and a cadence set that spans 60x.
 * 3. It compares the final state, not every intermediate frame.
 *
 * So: it is a strong new signal for the path it covers and no substitute for
 * the per-module tests. It sits ALONGSIDE both, not instead of them.
 */
import { describe, it, expect } from 'vitest';
import { AeroDisplay } from '#lib/display/display.svelte.js';
import { createSettings } from '#lib/settings/settings.svelte.js';

/**
 * Every field that is supposed to be a pure function of the wall second.
 *
 * Read off `CameraView` in flight/view.ts. The first draft of this test
 * invented field names — `altitude`, `heading`, `pitch`, `roll` — that do not
 * exist; the real ones are `aglM`, `planeHeadingDeg`, `bankDeg`,
 * `cameraBearingDeg`, `cameraPitchDeg`, `distanceM`, `timeOfDay`. Those
 * invented names read as `undefined`, and `toEqual(undefined, undefined)`
 * PASSES, so four of the eight comparisons were vacuous. `Object.entries` on a
 * hand-written list is exactly as trustworthy as the list; read the interface.
 */
function snapshot(d: AeroDisplay): Record<string, number | string> {
	const v = d.view;
	return {
		lat: v.lat,
		lon: v.lon,
		aglM: v.aglM,
		planeHeadingDeg: v.planeHeadingDeg,
		bankDeg: v.bankDeg,
		cameraBearingDeg: v.cameraBearingDeg,
		cameraPitchDeg: v.cameraPitchDeg,
		targetLat: v.targetLat,
		targetLon: v.targetLon,
		distanceM: v.distanceM,
		timeOfDay: v.timeOfDay,
		phase: d.phase,
		weather: d.weather,
		solarSec: d.solarSec
	};
}

/**
 * Drive a fresh Display from t0 to tEnd, landing EXACTLY on tEnd.
 *
 * `for (let t = t0 + step; t <= tEnd; t += step)` is wrong here, and it is
 * wrong in a way that fabricates a spectacular bug. Accumulating `t += 1/60`
 * 36,000 times in float64 lands 0.57 ms short of tEnd, while `t += 1` or
 * `t += 0.25` land exactly on it. DWELL_SEC is 600, so 0.57 ms short means the
 * 60 fps run is still inside the PREVIOUS slot and the slow runs have crossed
 * into the next one — a different destination, and 18.7 degrees of latitude of
 * fabricated "cadence dependence". Which is a real hazard for a 3-Pi wall in
 * its own right, but not one the code has.
 *
 * So the number of steps is computed and the last one is set to tEnd exactly.
 * The engine is right; the harness has to be too.
 */
function runAt(t0: number, tEnd: number, stepSec: number): Record<string, number | string> {
	const d = new AeroDisplay(createSettings());
	d.advanceTo(t0);
	const steps = Math.round((tEnd - t0) / stepSec);
	for (let i = 1; i <= steps; i++) {
		const t = i === steps ? tEnd : t0 + i * stepSec;
		d.advanceTo(t);
	}
	return snapshot(d);
}

const T0 = 1_800_000_000;
const T_END = T0 + 600; // one full dwell, so director slots rotate inside it

describe('frame-rate invariance (ADR-007)', () => {
	// 60, 30, 20, 12, 6, 3, 2, 1 fps. The slow ones are the fielded case: a Pi
	// 5 running the whole scene at 3 fps is the scenario the invariant exists
	// for, and 1 fps is past anything real but costs nothing to assert.
	const cadences = [60, 30, 20, 12, 6, 3, 2, 1];

	// The 60 fps reference is 36,000 advanceTo calls. It was being recomputed
	// inside `it.each`, i.e. eight times, which is 288,000 ticks for a
	// comparison that only needs one reference — and under full-suite load the
	// first case blew the 5 s default timeout. Memoised, and given an explicit
	// budget: this is a property test that genuinely does more work than a
	// unit test, and a flaky timeout would train people to ignore it.
	let reference: Record<string, number | string> | null = null;
	const ref = () => (reference ??= runAt(T0, T_END, 1 / 60));

	it.each(cadences)(
		'lands the same picture at %i fps as at 60 fps',
		(fps) => {
			const reference = ref();
			const actual = runAt(T0, T_END, 1 / fps);

			for (const key of Object.keys(reference)) {
				const a = reference[key];
				const b = actual[key];
				if (typeof a === 'number') {
					// Not exact: float accumulation differs in the last bits, and the
					// point of the invariant is that the PICTURE agrees, not that two
					// different summation orders are bit-identical. A drift big
					// enough to see would be metres, not nanometres.
					expect(Math.abs((a as number) - (b as number)), `${key} @ ${fps}fps`).toBeLessThan(1e-6);
				} else {
					expect(b, `${key} @ ${fps}fps`).toEqual(a);
				}
			}
		},
		60_000
	);

	it('is not merely self-consistent: a cadence-dependent build would fail', () => {
		// Sanity: the comparison above can only be meaningful if it discriminates.
		// Model the classic bug — integrating a clamped frame delta instead of
		// reading the clock — and confirm the two cadences really do diverge.
		const integrate = (stepSec: number) => {
			let v = 0;
			for (let t = T0 + stepSec; t <= T_END + 1e-9; t += stepSec) {
				// A pane clamps its frame delta to 0.1 s; the value then depends on
				// how many frames it drew, which is the ADR-007 violation.
				v += Math.min(stepSec, 0.1) * 0.01;
			}
			return v;
		};
		expect(Math.abs(integrate(1 / 60) - integrate(1 / 3))).toBeGreaterThan(1e-6);
	});
});
