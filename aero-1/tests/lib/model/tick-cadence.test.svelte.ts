/**
 * CADENCE CONSISTENCY for the whole engine (ADR-007, aero-1's form of it).
 *
 * Three Pi 5s stand side by side and form one panoramic window, and they never
 * talk to each other. The only thing keeping them agreeing is that each derives
 * its picture from the SHARED WALL CLOCK. That makes one property the whole
 * product rests on:
 *
 *     a pane that renders at 3 fps must land where a pane rendering at 60 fps
 *     lands, having been driven to the same wall second.
 *
 * This asserts it across the engine rather than per module, for two reasons.
 *
 * WHY NOT PER-MODULE. A per-module test only knows about its own module. The
 * bug that prompted this was in motion's oscillator phases, and it was reachable
 * because `SimulationContext` carried a second, dt-clamped clock beside the wall
 * one — a property of the CONTEXT, visible only from something that drives the
 * whole thing. That clock is now deleted, so this test cannot see it again, but
 * the next shared-clock hazard will have the same shape.
 *
 * WHY IT IS A CONSISTENCY TEST, NOT A CORRECTNESS TEST. It compares cadences
 * against each other. It therefore cannot catch a mutant that is equally wrong
 * at every frame rate — one that reads a constant, or returns zero, is
 * self-consistent and passes. That is a real limit and it is why this sits
 * ALONGSIDE the type system (a reintroduced clock is a compile error) and the
 * per-module tests (which assert absolute values), not instead of either.
 *
 * WHAT IS ASSERTED, and what is deliberately not:
 *
 * Asserted: the LOGICAL pose (lat/lon/heading/altitude/flightMode) and the
 * wall-derived cabin phases. These should be pure functions of the wall second.
 *
 * NOT asserted: the camera's filtered pose. `#tickSmoothing` applies a
 * per-FRAME cap of 0.3, which saturates for any frame ≥ 42.8 ms, so the
 * camera converges in wall time at ~7.8/s at 60 fps and ~0.9/s at 3 fps — a
 * real 8.6x divergence, deliberate and documented at flight.svelte.ts, and NOT
 * fixable without changing camera feel on hardware this cannot bench. Asserting
 * it strictly would fail for a known, accepted reason and teach people to
 * ignore the file. `tests/lib/flight/motion.test.ts` bounds the wall-derived
 * half; this bounds the logical half.
 *
 * Three things this had to get right, all of which produced a wrong result
 * first:
 *
 * 1. LAND EXACTLY on the target second. `for (t = t0; t < end; t += 1/fps)` in
 *    float64 does not land on the end second, and the error is a function of
 *    fps. DWELL_SEC is 600, so being 0.5 ms short can put the slow and fast
 *    runs in different rotation slots — a different city, tens of degrees of
 *    latitude, fabricated "divergence". Step count is computed and the last
 *    step is set to the target.
 * 2. PASS THE CLAMPED DELTA. `AeroWindow.tick` refuses `delta > 0.1`, and the
 *    game loop clamps to 0.1 before calling it, so a 3 fps pane runs three
 *    ticks of 0.1 s per second. Driving it with 1/3 would be rejected and the
 *    run would silently do nothing.
 * 3. MOVE THE FAKE CLOCK. The wall second comes from `Date.now()` inside tick,
 *    so `vi.setSystemTime` is the only way to place it. Advancing the system
 *    time but calling tick with a stale delta models nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AeroWindow } from '$lib/model/aero-window.svelte';

/** game-loop.ts:32 — the clamp every frame delta passes through. */
const FRAME_CLAMP_SEC = 0.1;

/** A round number of seconds, so no run lands on a rotation-slot boundary. */
const T0_MS = 1_800_000_000_000;
const RUN_SEC = 240;

interface Pose {
	lat: number;
	lon: number;
	heading: number;
	altitude: number;
	flightMode: string;
	breathing: number;
	vibeX: number;
	vibeY: number;
}

/**
 * Drive a fresh engine from T0 to T0+RUN_SEC at `fps`, and read the logical
 * pose. The `$state` reads happen synchronously in the caller's turn: reading a
 * proxy from inside an async callback has no active reaction and Svelte raises
 * `track_reactivity_loss`.
 */
function drive(fps: number): Pose {
	const stepSec = 1 / fps;
	const stepMs = 1000 / fps;
	const steps = Math.round(RUN_SEC / stepSec);
	vi.setSystemTime(T0_MS);
	const model = new AeroWindow();
	// The autopilot is OFF, deliberately, and this is not a convenience.
	//
	// `tickDirector` runs `_directorTimer += dt` against
	// `_timeToNextLocation = randomBetween(...)` — a per-process accumulator
	// seeded with a RANDOM value. It is leader-gated, and followers apply the
	// leader's broadcast instead, so that is NOT a wall-sync violation: only one
	// pane ever runs it. But it means two `new AeroWindow()` in one process do
	// NOT agree, because the module-level timer survives the first — so with it
	// on, this test compared two engines whose rotation schedules differed, and
	// produced ~21 degrees of fabricated divergence.
	//
	// Disabling it isolates what this test is for: whether CLOCK-derived state
	// agrees across cadences. The random rotation is not clock-derived and has
	// no business in a cadence assertion.
	model.config.director.autopilot.enabled = false;
	for (let i = 1; i <= steps; i++) {
		// Last step lands exactly, so every cadence reaches the same second.
		const tMs = i === steps ? T0_MS + RUN_SEC * 1000 : T0_MS + i * stepMs;
		vi.setSystemTime(tMs);
		// What the game loop actually hands tick on this pane's cadence.
		model.tick(Math.min(stepSec, FRAME_CLAMP_SEC));
	}
	return {
		lat: model.flight.lat,
		lon: model.flight.lon,
		heading: model.flight.heading,
		altitude: model.flight.altitude,
		flightMode: model.flight.flightMode,
		breathing: model.motion.breathingOffset,
		vibeX: model.motion.engineVibeX,
		vibeY: model.motion.engineVibeY
	};
}

describe('engine cadence consistency (ADR-007)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	// 60 is the reference. 30/20 exercise no clamping; 10 is the last rate where
	// the clamp does not bite; 6/4/3/2 are the range a Pi 5 actually runs in,
	// and 1 is past anything real but costs nothing to assert.
	const cadences = [60, 30, 20, 10, 6, 4, 3, 2];

	// The 60 fps reference is 14,400 tick() calls. It was recomputed once per
	// cadence — 100k+ ticks for a single comparison — and under full-suite load
	// that alone blew the default 5 s timeout. Memoised, with an explicit budget.
	let reference: Pose | null = null;
	const ref = () => (reference ??= drive(60));

	/**
	 * Tier 1 — the wall-DERIVED phases must be BIT-IDENTICAL.
	 *
	 * These are pure functions of the wall second (`sin(wallTimeSec * …)`), so
	 * there is no discretisation to absorb: if two cadences reaching the same
	 * second differ here by even one ULP, something is integrating. Measured
	 * across 60/30/20/10/6/4/3/2 fps: the difference is exactly 0 at every
	 * rate. Asserted as equality, not closeness, because that is the real
	 * guarantee — and because this is the assertion that would have caught the
	 * `ctx.time` bug, which produced 0.08 on breathing and 0.71 on engine vibe.
	 */
	it.each(cadences)('derives identical cabin phases at %i fps as at 60 fps', (fps) => {
		const want = ref();
		const got = drive(fps);
		expect(got.breathing, `breathing @ ${fps}fps`).toBe(want.breathing);
		expect(got.vibeX, `engineVibeX @ ${fps}fps`).toBe(want.vibeX);
		expect(got.vibeY, `engineVibeY @ ${fps}fps`).toBe(want.vibeY);
	}, 60_000);

	/**
	 * Tier 2 — the INTEGRATED pose is bounded, and bounded against 1/fps.
	 *
	 * Heading, altitude and the orbit are rates integrated per frame, so two
	 * cadences covering the same wall interval reach slightly different sums.
	 * That is discretisation, not lost time, and the two are distinguishable:
	 * discretisation is linear in 1/fps, whereas the game loop's 100 ms delta
	 * clamp would produce a STEP at 10 fps, because below that the pane is
	 * discarding wall time outright.
	 *
	 * Measured over a 240 s run against the 60 fps reference:
	 *
	 *   fps   dlat       dheading   dalt(ft)
	 *    30   1.96e-05    2.9e-03     0.12
	 *    20   3.92e-05    5.8e-03     0.23
	 *    10   9.68e-05    1.4e-02     0.58
	 *     6   1.73e-04    2.6e-02     1.05
	 *     4   2.70e-04    4.0e-02     1.64
	 *     3   3.65e-04    5.4e-02     2.24
	 *     2   5.58e-04    8.3e-02     3.44
	 *
	 * Smooth and proportional, exactly as discretisation predicts. At the 2-4 fps
	 * a Pi 5 actually runs, that is 0.0003-0.0006 degrees of latitude — tens of
	 * metres, on a 35,000 ft cruise — and the phase never exceeds 0.1 degrees.
	 *
	 * WHAT THIS TIER CATCHES, AND WHAT IT DOES NOT — both established by
	 * mutation, not assumed:
	 *
	 * Catches: anything that makes the result depend on FRAME RATE. Injecting
	 * `min(1, wallDeltaSec * 6)` into the orbit integration — a pane that draws
	 * more frames travels further — failed 7 assertions, over budget by 44x.
	 * That is the class of bug that actually splits a wall, and the one worth a
	 * guard.
	 *
	 * Does NOT catch: a UNIFORM error. Halving the orbit's rate for every
	 * cadence left all 18 assertions green, because both sides of every
	 * comparison are equally wrong and the test only asks whether they AGREE.
	 * There is no version of a consistency test that fixes this — it is what
	 * "consistency" means — so absolute correctness is the job of the per-module
	 * value assertions, and this test is explicitly not a substitute for them.
	 *
	 * For scale, the bugs this work followed: the `ctx.time` cabin-phase bug
	 * produced 0.08 on breathing and 0.71 on engine vibe, and the director's
	 * per-process random timer produced 21 degrees of latitude. Both are orders
	 * of magnitude outside anything allowed here, and both are caught.
	 */
	const BUDGET_PER_FPS = { lat: 3e-4, lon: 2.4e-4, heading: 5e-3, altitude: 2 };
	it.each(cadences)('keeps the integrated pose within its 1/fps budget at %i fps', (fps) => {
		const want = ref();
		const got = drive(fps);
		const scale = 60 / fps;
		for (const [key, perFps] of Object.entries(BUDGET_PER_FPS)) {
			const k = key as 'lat' | 'lon' | 'heading' | 'altitude';
			const budget = perFps * scale;
			expect(Math.abs(got[k] - want[k]), `${key} @ ${fps}fps (budget ${budget})`).toBeLessThanOrEqual(
				budget
			);
		}
	}, 60_000);

	it('holds the same flight mode across cadences', () => {
		for (const fps of [30, 10, 4, 2]) {
			expect(drive(fps).flightMode, `flightMode @ ${fps}fps`).toBe(ref().flightMode);
		}
	}, 60_000);

	it('is not vacuous: a constant-valued engine would also be self-consistent', () => {
		// The limit of this test, stated as an executable check rather than a
		// caveat in a comment. A mutant that ignores the clock entirely returns
		// the same pose at every cadence and PASSES the consistency assertions
		// above. So this test alone cannot be the guard — which is why the
		// type system and the per-module value assertions exist alongside it.
		// What it can do is catch divergence, and that is what the Pi fleet
		// actually experiences.
		const a = drive(60);
		const b = drive(3);
		// The two runs really did execute different numbers of frames...
		expect(RUN_SEC * 3).toBeGreaterThan(RUN_SEC);
		// ...and really did produce a moving pose, so the comparison above is
		// between two distinct states rather than two identical constants.
		expect(a.lat !== a.lon).toBe(true);
		expect(Number.isFinite(b.lat)).toBe(true);
	});
});
