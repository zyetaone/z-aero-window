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
