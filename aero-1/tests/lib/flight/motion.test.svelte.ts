/**
 * Motion — first-tick bank regression.
 *
 * The regression these pin: `_prevHeading` initialised to 0 against the 45°
 * boot heading, so the very first tick measured a 45°/delta turn and slammed
 * `bankAngle` to `bankAngleMax` for ~1s. The fix is a null sentinel seeded
 * from `ctx.heading` on the first tick (the file's existing lazy-init
 * pattern, cf. `_nextBump`).
 *
 * The motion module is a process singleton, so each test re-imports it after
 * `vi.resetModules()` to get a fresh first tick.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { camera as cameraConfig, director as directorConfig } from '$lib/model/config-tree.svelte';
import type { SimulationContext } from '$lib/types';

const BOOT_HEADING = 45; // FlightSimEngine's boot heading

function makeCtx(heading: number, wallDeltaSec: number = 1 / 60): SimulationContext {
	return {
		time: 0, wallTimeSec: 0, lat: 0, lon: 0, altitude: 35000, heading, pitch: 60, bankAngle: 0,
		weather: 'clear', skyState: 'day', nightFactor: 0, dawnDuskFactor: 0,
		locationId: 'dubai',
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.5, haze: 0.07, warpFactor: 0,
		turbulenceLevel: 'light',
		camera: cameraConfig,
		director: directorConfig,
		isLeader: true,
		wallDeltaSec,
	} as unknown as SimulationContext;
}

describe('motion first tick', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('produces zero bank at the boot heading — no first-frame slam', async () => {
		const { motion, motionStep } = await import('$lib/flight/motion.svelte');
		motionStep(1 / 60, makeCtx(BOOT_HEADING));
		expect(motion.bankAngle).toBe(0);
	});

	it('keeps zero bank while the heading holds steady', async () => {
		const { motion, motionStep } = await import('$lib/flight/motion.svelte');
		const ctx = makeCtx(BOOT_HEADING);
		for (let i = 0; i < 120; i++) {
			motionStep(1 / 60, ctx);
			ctx.time += 1 / 60;
		}
		expect(motion.bankAngle).toBe(0);
	});

	it('banks when the heading actually changes after the first tick', async () => {
		const { motion, motionStep } = await import('$lib/flight/motion.svelte');
		const ctx = makeCtx(BOOT_HEADING);
		motionStep(1 / 60, ctx); // seeds _prevHeading
		ctx.heading = BOOT_HEADING + 2;
		motionStep(1 / 60, ctx);
		expect(motion.bankAngle).toBeGreaterThan(0);
	});

	it('motionReset clears the retained heading — a remount does not slam the bank', async () => {
		const { motion, motionStep, motionReset } = await import('$lib/flight/motion.svelte');
		motionStep(1 / 60, makeCtx(BOOT_HEADING)); // previous model's last heading
		// Contrast: without a reset, the next model's first tick measures a
		// phantom turn from the retained heading.
		motionStep(1 / 60, makeCtx(BOOT_HEADING + 90));
		expect(motion.bankAngle).toBeGreaterThan(0);

		motionReset(); // what the AeroWindow constructor does on remount
		motionStep(1 / 60, makeCtx(BOOT_HEADING + 90));
		expect(motion.bankAngle).toBe(0);
	});

	it('uses wallDeltaSec for turn rate so a slow Pi does not over-bank', async () => {
		// Same sim delta + heading step: smaller wall Δt → higher turn rate →
		// more bank. Flight advances heading on wall clock; bank must share it.
		// (0.1 vs 0.4 with bankSmoothing 2.5 coincidentally equal after one step.)
		const { motion, motionStep, motionReset } = await import('$lib/flight/motion.svelte');
		const headingStep = 4;

		motionStep(0.1, makeCtx(BOOT_HEADING, 0.05));
		motionStep(0.1, makeCtx(BOOT_HEADING + headingStep, 0.05));
		const bankFast = Math.abs(motion.bankAngle);

		motionReset();
		motionStep(0.1, makeCtx(BOOT_HEADING, 1.0));
		motionStep(0.1, makeCtx(BOOT_HEADING + headingStep, 1.0));
		const bankSlow = Math.abs(motion.bankAngle);

		expect(bankSlow).toBeLessThan(bankFast);
	});
});

/**
 * Frame-rate independence of the oscillator phases.
 *
 * The regression these pin: every `sin(t * ...)` in motion.svelte.ts read
 * `ctx.time`, which is `#time = (#time + delta) % 3600` in AeroWindow where
 * `delta` is the game-loop's CLAMPED frame delta (`Math.min(dt, 0.1)`). The
 * clamp is correct in itself — it stops a stalled frame flinging the sim forward
 * — but it means `ctx.time` is not the wall clock. On a pane at 3 fps it
 * advances 0.1 s per 0.33 s of real time, so it runs at 0.3x: the 22 s
 * breathing cycle took 73 wall seconds, and the engine vibe, nominally 7 Hz, ran
 * at 2.1 Hz.
 *
 * Not merely "slow". Every pane runs at its OWN rate, so three panes at
 * different frame rates breathe out of phase and the cabin motion does not line
 * up across the seam — the product's central claim, failing on the hardware the
 * fleet actually runs (aero-window.svelte.ts says 2-4 fps).
 *
 * The assertion is the PROPERTY, not the implementation: the same wall second
 * must give the same pose, whatever frame delta got us there.
 */
describe('motion oscillator phases are a function of the wall second', () => {
	/** game-loop.ts:32 — the clamp that makes `ctx.time` diverge from the wall. */
	const GAME_LOOP_CLAMP_SEC = 0.1;

	/**
	 * Drive the module from wall second 0 to `totalWallSec` at `frameSec` per
	 * frame, and read the cabin pose at the end.
	 *
	 * Two things this has to get right, both learned the hard way:
	 *
	 * 1. BOTH clocks are modelled, and that is the entire point. wallTimeSec
	 *    advances by the true frame while `time` accumulates the CLAMPED delta.
	 *    A first draft set `ctx.time = w`, making the two identical — and the
	 *    test then passed with the bug PRESENT *and* with the fix reverted,
	 *    because it had nothing to discriminate. At 3 fps the clamp is exactly
	 *    what makes them diverge: 0.333 s of wall becomes 0.1 s of `time`.
	 *
	 * 2. The `$state` proxy is read synchronously, in the same turn as the
	 *    last motionStep. Reading it from inside an async callback has no
	 *    active reaction and Svelte raises `track_reactivity_loss`.
	 */
	async function drive(frameSec: number, totalWallSec = 60) {
		const mod = await import('$lib/flight/motion.svelte');
		mod.motionReset();
		const ctx = makeCtx(BOOT_HEADING, frameSec);
		let simTime = 0;
		for (let w = frameSec; w <= totalWallSec + 1e-9; w += frameSec) {
			simTime = (simTime + Math.min(frameSec, GAME_LOOP_CLAMP_SEC)) % 3600;
			ctx.wallTimeSec = w;
			ctx.wallDeltaSec = frameSec;
			ctx.time = simTime;
			mod.motionStep(frameSec, ctx);
		}
		return {
			breathing: mod.motion.breathingOffset,
			vibeX: mod.motion.engineVibeX,
			vibeY: mod.motion.engineVibeY
		};
	}

	it('lands the same cabin motion at 3 fps as at 60 fps over the same wall time', async () => {
		const slow = await drive(1 / 3);
		const fast = await drive(1 / 60);
		expect(slow.breathing).toBeCloseTo(fast.breathing, 6);
		expect(slow.vibeX).toBeCloseTo(fast.vibeX, 6);
		expect(slow.vibeY).toBeCloseTo(fast.vibeY, 6);
	});

	it('and at 2 fps, where the clamp bites hardest', async () => {
		const slow = await drive(1 / 2);
		const fast = await drive(1 / 60);
		expect(slow.breathing).toBeCloseTo(fast.breathing, 6);
		expect(slow.vibeX).toBeCloseTo(fast.vibeX, 6);
		expect(slow.vibeY).toBeCloseTo(fast.vibeY, 6);
	});
});
