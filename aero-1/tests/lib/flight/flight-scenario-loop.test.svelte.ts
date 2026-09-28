/**
 * Scenario loop-flip — per-loop seed mixing.
 *
 * The regression these pin: on each loop wrap the engine re-created its rng
 * with the SAME seed (daySeed() ^ hashString(locationId)), so the direction
 * flip (first draw) and the scenario re-pick (second draw) returned identical
 * results on every loop — the "randomly flip direction on each loop" comment
 * was wrong. The fix mixes the loop counter into the seed
 * (^ Math.imul(loopCount, 0x9E3779B9)); the counter is deterministic per
 * day, so all 3 Pis still compute the same sequence.
 *
 * The date is pinned with fake timers because daySeed() derives from the UTC
 * day — the flip sequence below is verified for this date, and determinism
 * across two same-seed engines holds for any date.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlightSimEngine } from '$lib/flight/flight.svelte';
import { camera as cameraConfig, director as directorConfig } from '$lib/model/config-tree.svelte';
import { LOCATION_IDS } from '$content/locations';
import type { SimulationContext } from '$lib/types';

const [HOME] = [...LOCATION_IDS];

function makeCtx(): SimulationContext {
	return {
		// `wallTimeSec` is REQUIRED on SimulationContext, and this factory casts
		// through `as unknown as`, so the compiler never checked it — which is why
		// the two `?? ctx.time` fallbacks in flight.svelte.ts existed and were
		// load-bearing: a context reaching the orbit maths without a wall clock
		// produced NaN and silently froze the scenario loop. Supplied here, and
		// `time` is gone, so the wall clock is the only one there is.
		wallTimeSec: 0, wallDeltaSec: 0, lat: 0, lon: 0, altitude: 35000, heading: 45, pitch: 60, bankAngle: 0,
		weather: 'clear', skyState: 'day', nightFactor: 0, dawnDuskFactor: 0,
		locationId: HOME,
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.5, haze: 0.07, warpFactor: 0,
		turbulenceLevel: 'light',
		camera: cameraConfig,
		director: directorConfig,
		isLeader: true,
	} as unknown as SimulationContext;
}

/** Tick the engine at 10 Hz for `seconds` of sim time, sampling travelSign. */
function run(engine: FlightSimEngine, ctx: SimulationContext, seconds: number): number[] {
	const dt = 0.1;
	const signs: number[] = [];
	for (let t = 0; t < seconds; t += dt) {
		engine.tick(dt, ctx);
		// The wall clock is the only clock now, so this loop advances it. It used
		// to advance `ctx.time` and leave `wallTimeSec` pinned at 0 — which is why
		// this test needed the `?? ctx.time` fallbacks in flight.svelte.ts to get
		// anything at all.
		ctx.wallTimeSec = t + dt;
		ctx.wallDeltaSec = dt;
		signs.push(engine.travelSign);
	}
	return signs;
}

describe('scenario loop-flip seed mixing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 5, 15));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('varies the travel direction across loops', () => {
		const engine = new FlightSimEngine();
		engine.setLocationWithSky(HOME, 'day');
		const ctx = makeCtx();
		// A loop is now the SUM OF ITS AUTHORED DURATIONS in seconds (~215 s
		// for dubai-cruise). It used to be ~60 s because the raw 4.0 speed knob
		// was multiplied into the progress rate — that 4x compression is the
		// bug this window previously encoded. 500 s covers the first two loop
		// boundaries (and their flips) but stops before SCENARIO_MAX_LOOPS
		// clears the scenario back to the orbit.
		const signs = run(engine, ctx, 500);
		expect(new Set(signs)).toEqual(new Set([1, -1]));
	});

	it('is deterministic across two same-seed engines through the flips', () => {
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(HOME, 'day');
		b.setLocationWithSky(HOME, 'day');
		const ctx = makeCtx();
		const dt = 0.1;
		// 800s covers all SCENARIO_MAX_LOOPS loops and the hand-back to orbit
		// at the corrected (authored-seconds) playback rate.
		for (let t = 0; t < 800; t += dt) {
			a.tick(dt, ctx);
			b.tick(dt, ctx);
			ctx.wallTimeSec = t + dt;
			ctx.wallDeltaSec = dt;
			expect(b.lat).toBe(a.lat);
			expect(b.lon).toBe(a.lon);
			expect(b.heading).toBe(a.heading);
			expect(b.travelSign).toBe(a.travelSign);
		}
	});
});
