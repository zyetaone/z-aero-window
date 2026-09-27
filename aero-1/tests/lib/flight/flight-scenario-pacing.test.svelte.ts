/**
 * Scenario playback pacing.
 *
 * Waypoint `duration` values are authored as SECONDS. The engine used to
 * multiply the raw `flightSpeed` knob (default 6.0) into the progress rate, so
 * every authored leg ran 4x fast: dubai-approach's 225 s circuit finished in
 * 56 s and bled 28,000 -> 6,000 ft in about 25 s — roughly 53,000 ft/min,
 * against ~2,000 ft/min for a real airliner. The waypoints were plausible;
 * the playback rate was eating them.
 *
 * These pin the physical outcome rather than a specific scenario, so they hold
 * whichever one the day-seed picks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlightSimEngine, DEFAULT_FLIGHT_SPEED } from '$lib/flight/flight.svelte';
import { camera as cameraConfig, director as directorConfig } from '$lib/model/config-tree.svelte';
import type { SimulationContext } from '$lib/types';

/** Cities have the low-altitude approach scenarios, so they set the worst case. */
const CITY = 'dubai';

function makeCtx(): SimulationContext {
	return {
		time: 0, wallTimeSec: 0, wallDeltaSec: 0.1,
		lat: 0, lon: 0, altitude: 28000, heading: 45, pitch: 60, bankAngle: 0,
		weather: 'clear', skyState: 'dusk', nightFactor: 0, dawnDuskFactor: 0,
		locationId: CITY,
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.5, haze: 0.07, warpFactor: 0,
		turbulenceLevel: 'light',
		camera: cameraConfig,
		director: directorConfig,
		isLeader: true,
	} as unknown as SimulationContext;
}

/**
 * Sustained vertical rate over a run, ft/min, as the 99th percentile of
 * per-tick rates.
 *
 * NOT the max: a scenario loop wrap and the hand-back to orbit both step the
 * altitude discontinuously, and a single such frame reads as millions of
 * ft/min. Those are teleports between authored points, not descents — p99
 * ignores the handful of jump frames while still catching a genuinely steep
 * leg, which is what this is measuring.
 */
function sustainedVerticalRateFtPerMin(seconds: number): number {
	const engine = new FlightSimEngine();
	engine.setLocationWithSky(CITY, 'dusk');
	const ctx = makeCtx();
	const dt = 0.1;
	let prevAlt = engine.altitude;
	const rates: number[] = [];
	for (let t = 0; t < seconds; t += dt) {
		engine.tick(dt, ctx);
		ctx.time += dt;
		ctx.wallTimeSec += dt;
		rates.push((Math.abs(engine.altitude - prevAlt) / dt) * 60);
		prevAlt = engine.altitude;
	}
	rates.sort((a, b) => a - b);
	return rates[Math.floor(rates.length * 0.99)];
}

describe('scenario playback pacing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 5, 15));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('does not fly airliner descents at rocket rates', () => {
		const peak = sustainedVerticalRateFtPerMin(600);
		// Measured over this 600 s run (p99 of per-tick rates):
		//   raw 4.0 knob (pre-fix):  80,442 ft/min
		//   normalised (current):    20,715 ft/min
		// — the 3.9x drop is the speed factor being removed, as expected.
		//
		// 30,000 leaves headroom for scenario-pick variation while still
		// failing loudly if the raw knob ever comes back.
		expect(peak).toBeLessThan(30_000);
		// Guard against passing vacuously on a scenario that never changes
		// altitude: pre-fix p50 was 1 ft/min precisely because the circuit
		// finished so fast that the run sat in level orbit for most of it.
		expect(peak).toBeGreaterThan(1_000);
	});

	it('resets scenario progress on flyTo so arrival does not resume mid-leg', () => {
		// Regression: #initScenario zeroed waypoint index but left
		// #scenarioProgress mid-leg after a prior cruise/warp, so orbit
		// resumed with a Catmull-Rom jump after every city change.
		const engine = new FlightSimEngine();
		engine.setLocationWithSky(CITY, 'dusk');
		const ctx = makeCtx();
		// Advance into a scenario leg.
		for (let t = 0; t < 5; t += 0.1) {
			engine.tick(0.1, ctx);
			ctx.time += 0.1;
			if (ctx.wallTimeSec !== undefined) ctx.wallTimeSec += 0.1;
		}
		const latBeforeFly = engine.lat;
		// Cruise to another city; departure must NOT race the scenario path.
		engine.flyTo('mumbai', 'dusk');
		expect(engine.flightMode).toBe('cruise_departure');
		for (let t = 0; t < 3; t += 0.1) {
			engine.tick(0.1, ctx);
			ctx.time += 0.1;
		}
		// Path frozen during warp: still at the pre-fly coordinates.
		expect(engine.lat).toBeCloseTo(latBeforeFly, 5);
		// Force arrival path: setLocationWithSky (what locationArrived does)
		// must start the new scenario at progress 0 — first tick after arrive
		// stays continuous with the seeded orbit, not a mid-leg jump.
		engine.setLocationWithSky('mumbai', 'dusk');
		const lat0 = engine.lat;
		const lon0 = engine.lon;
		engine.tick(0.1, ctx);
		// One tick at progress≈0 stays near the orbit seed (small scenario step),
		// not a multi-leg wrap jump of many km.
		const dLat = Math.abs(engine.lat - lat0);
		const dLon = Math.abs(engine.lon - lon0);
		expect(dLat + dLon).toBeLessThan(0.05);
	});

	it('scales linearly with the speed knob, normalised so default = authored seconds', () => {
		// Two engines, one at default and one at double, sampled at instants
		// that should map to the same point on the authored path.
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(CITY, 'dusk');
		b.setLocationWithSky(CITY, 'dusk');
		b.flightSpeed = DEFAULT_FLIGHT_SPEED * 2;

		const ctxA = makeCtx();
		const ctxB = makeCtx();
		// Absolute progress uses wallTimeSec; keep wall clocks explicit.
		ctxA.wallTimeSec = 0;
		ctxB.wallTimeSec = 0;
		// b covers the same authored distance in half the wall time.
		for (let t = 0; t < 40; t += 0.1) {
			a.tick(0.1, ctxA);
			ctxA.time += 0.1;
			ctxA.wallTimeSec = (ctxA.wallTimeSec ?? 0) + 0.1;
		}
		for (let t = 0; t < 20; t += 0.1) {
			b.tick(0.1, ctxB);
			ctxB.time += 0.1;
			ctxB.wallTimeSec = (ctxB.wallTimeSec ?? 0) + 0.1;
		}

		// 2dp ≈ 1 km. Not tighter: sine jitter is keyed to wallT (different
		// elapsed wall times at the same progress by construction).
		expect(b.lat).toBeCloseTo(a.lat, 2);
		expect(b.lon).toBeCloseTo(a.lon, 2);
	});
});
