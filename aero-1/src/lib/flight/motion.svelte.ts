/**
 * Motion — turbulence, banking, breathing, engine vibration.
 *
 * Converted from MotionEngine class to module: six reactive outputs live
 * as fields on the exported `motion` object; four private timers are
 * module-local `let`. The app has one motion producer (singleton) — no
 * multi-instance use case exists, so the class was ceremony.
 *
 * AeroWindow.motion returns this module's `motion` object (a getter, not
 * a field), keeping `model.motion.x` callsites untouched across
 * Pane.svelte + compose.ts.
 *
 * All feel parameters are read from `ctx.camera.motion` (CameraConfig.MotionConfig).
 */

import { untrack } from 'svelte';
import { clamp, shortestAngleDelta, randomBetween } from '$lib/utils';
import type { SimulationContext } from '$lib/types';

// ── Reactive outputs ────────────────────────────────────────────────────────

// `$state`, deliberately NOT `$state.raw`, even though every field is rewritten
// each frame. The usual argument for `.raw` in a hot path is proxy overhead —
// measured here, that is 0.65 us per frame for these 7 fields against a frame
// budget of ~333 000 us at the Pi's observed 3 fps. Noise.
//
// The reactivity, by contrast, is load-bearing: `Pane.svelte` reads
// `motion.motionOffsetX` and `motion.breathingOffset` through `$derived` to
// drive the cabin-sway transform. `$state.raw` would replace the object rather
// than track field writes, so those deriveds would stop updating and the sway
// would freeze — a silent visual regression traded for an unmeasurable win.
export const motion = $state({
	motionOffsetX: 0,
	motionOffsetY: 0,
	bankAngle: 0,
	breathingOffset: 0,
	engineVibeX: 0,
	engineVibeY: 0,
	warpZoom: 0,
});

// ── Internal timer state (not reactive) ─────────────────────────────────────

// Null until the first tick seeds it from ctx.heading (same lazy-init
// pattern as _nextBump below). Initialising to 0 against the 45° boot
// heading read as a 45°/delta first-frame turn and slammed the bank to
// bankAngleMax for ~1s.
let _prevHeading: number | null = null;
let _rawBankAngle = 0;
let _bumpTimer = 0;
// Lazy-init on first tick from ctx.camera.motion.bumpMin/MaxInterval (live
// config). Earlier this was seeded at module load with hardcoded (30, 120) —
// same fleet-sync class of bug as the autopilot init seeds: every Pi
// imported the module at roughly the same boot moment and (V8's RNG aside)
// could pick correlated first-bump times. Now sampled on first real tick
// against the live config window, so admin tuning is honored and every
// device picks its own.
let _nextBump: number | null = null;
let _bumpElapsed = -1;
let _bumpSign = 1;

// ── Remount reset ───────────────────────────────────────────────────────────

/**
 * Reset all module state to first-tick values (null sentinels included).
 * Called by the AeroWindow constructor: this module is a process singleton,
 * the AeroWindow is not, so on remount (HMR, page nav, liveness reload) the
 * retained `_prevHeading` made the first tick derive a heading delta from the
 * PREVIOUS model's last heading — the boot-slam the null sentinel exists to
 * prevent. The reactive `motion` outputs are not touched: every field is
 * rewritten on the next tick anyway.
 */
export function motionReset(): void {
	_prevHeading = null;
	_rawBankAngle = 0;
	_bumpTimer = 0;
	_nextBump = null;
	_bumpElapsed = -1;
	_bumpSign = 1;
}

// ── Tick ────────────────────────────────────────────────────────────────────

export function motionStep(delta: number, ctx: SimulationContext): void {
	untrack(() => tickInternal(delta, ctx));
}

function tickInternal(_delta: number, ctx: SimulationContext): void {
	// `t` is the WALL SECOND, not `ctx.time`. This was `time: t`, and it is the
	// most consequential `ctx.time` consumer in the tree: every sin() below —
	// turbulence, breathing, engine vibe, chatter — is a function of it, and
	// those reach the audience as the whole-scene CSS transform in Pane.svelte.
	//
	// `ctx.time` is `#time = (#time + delta) % 3600` in AeroWindow, where
	// `delta` is the game-loop's CLAMPED frame delta (Math.min(dt, 0.1)). The
	// clamp is right — it stops a stalled frame flinging the sim forward — but it
	// means `ctx.time` is not the wall clock. On a pane at 3 fps, which is what
	// aero-window.svelte says the Pi panel actually runs at, `ctx.time` advances
	// 0.1 s per 0.33 s of real time: 0.3x. The 22 s breathing cycle then takes
	// 73 wall seconds, and the engine vibe, nominally 7 Hz, runs at 2.1 Hz.
	//
	// Worse than slow: each pane runs at ITS OWN rate, so three panes at
	// different frame rates breathe out of phase and the cabin motion does not
	// line up across the seam. The product's central claim, failing on the
	// hardware the fleet actually runs.
	//
	// The line below already fixed this class for the OTHER time input in this
	// function ("flight advances heading on wallDeltaSec, so bank turnRate must
	// use the same clock"). The oscillator phases were left on the accumulator.
	// Deriving from the clock also removes the `% 3600` hour-boundary pop, since
	// 3600 is not a multiple of breathingPeriod (22).
	const t = ctx.wallTimeSec;
	const { heading, altitude, turbulenceLevel, camera, warpFactor } = ctx;
	const m = camera.motion;
	const turbMult = m.turbulenceMultipliers[turbulenceLevel];
	// Wall-clock step when available (same class as orbit/director): flight
	// advances heading on wallDeltaSec, so bank turnRate must use the same
	// clock or a slow Pi (dt clamped 0.1 s, wall ~0.3 s) over-banks.
	const dt = ctx.wallDeltaSec;

	const altFactor = altitude > 40000
		? clamp(1 - (altitude - 40000) / 10000, 0.05, 1)
		: 1;

	// Multi-octave sin noise for organic turbulence feel
	const noiseY = (
		Math.sin(t * 0.53) * 0.10 +
		Math.sin(t * 1.17) * 0.07 +
		Math.sin(t * 2.31) * 0.03
	) * turbMult;

	const noiseX = (
		Math.sin(t * 0.41) * 0.08 +
		Math.sin(t * 0.97) * 0.05 +
		Math.sin(t * 1.83) * 0.02
	) * turbMult;

	const chatterY = (
		Math.sin(t * 15.7) * 0.03 +
		Math.sin(t * 23.3) * 0.02
	) * turbMult;

	const chatterX = (
		Math.sin(t * 13.2) * 0.01 +
		Math.sin(t * 20.7) * 0.008
	) * turbMult;

	if (_nextBump === null) {
		_nextBump = randomBetween(m.bumpMinInterval, m.bumpMaxInterval) / turbMult;
	}

	let bumpValue = 0;
	_bumpTimer += dt;

	if (_bumpElapsed >= 0) {
		_bumpElapsed += dt;
		const onset = 1 - Math.exp(-8 * _bumpElapsed);
		bumpValue = _bumpSign * m.bumpAmplitude * turbMult
			* Math.exp(-m.bumpDecay * _bumpElapsed)
			* Math.sin(m.bumpRingFreq * _bumpElapsed)
			* onset;
		if (_bumpElapsed > 1.5) _bumpElapsed = -1;
	} else if (_bumpTimer > _nextBump) {
		_bumpTimer = 0;
		_bumpElapsed = 0;
		// Deliberate Math.random(): bump sign is per-pane visual noise, not
		// scene state — the panorama invariant covers geometry, not turbulence.
		_bumpSign = Math.random() > 0.5 ? 1 : -1;
		_nextBump = randomBetween(m.bumpMinInterval, m.bumpMaxInterval) / turbMult;
	}

	motion.motionOffsetY = (noiseY * m.turbulenceOffsetY + chatterY + bumpValue) * altFactor;
	// X deliberately derives from the Y scalar: one turbulence budget, scaled
	// down laterally (0.3) — not a missing turbulenceOffsetX config key.
	motion.motionOffsetX = (noiseX * m.turbulenceOffsetY * 0.3 + chatterX) * altFactor;

	// First tick: no previous heading, so report zero turn rather than a
	// phantom swing from the sentinel to the boot heading.
	const hDelta = _prevHeading === null ? 0 : shortestAngleDelta(_prevHeading, heading);
	const turnRate = dt > 0 ? hDelta / dt : 0;
	const targetBank = clamp(turnRate * 0.45, -m.bankAngleMax, m.bankAngleMax);
	_rawBankAngle += (targetBank - _rawBankAngle) * Math.min(m.bankSmoothing * dt, 1);
	motion.bankAngle = _rawBankAngle;
	_prevHeading = heading;

	motion.breathingOffset = Math.sin(t * (2 * Math.PI / m.breathingPeriod));

	motion.engineVibeX = Math.sin(t * m.engineVibeFreqX) * m.engineVibeAmp;
	motion.engineVibeY = Math.sin(t * m.engineVibeFreqY) * m.engineVibeAmp;

	// Cinematic warp zoom — subtle push-in as speed ramps
	motion.warpZoom = warpFactor * 0.05;
}
