/**
 * Cruise FSM — orbit → cruise_departure → cruise_transit → arrival_hold → orbit.
 *
 * The regression these pin: #tickDeparture ramps warpFactor over
 * `departureDurationSec` but used to EXIT on `transitDurationSec`. Both default
 * to 2.0s, so the mismatch is invisible on the shipped config — and would stay
 * invisible right up until someone retunes the departure feel and gets a
 * warp that snaps instead of eases. A duration knob must gate its own phase,
 * so these tests drive the FSM with DELIBERATELY UNEQUAL durations.
 */
import { describe, it, expect } from 'vitest';
import { FlightSimEngine } from '$lib/flight/flight.svelte';
import { camera as cameraConfig, director as directorConfig } from '$lib/model/config-tree.svelte';
import { LOCATION_IDS } from '$content/locations';
import type { SimulationContext } from '$lib/types';

const [HOME, AWAY] = [...LOCATION_IDS];

/**
 * Minimal context; only the cruise knobs matter for these transitions.
 *
 * The camera config carries methods (effectiveHeading), so it cannot be
 * structuredClone'd. Spread the live object and override just the cruise
 * block — the engine only reads, so sharing the rest is safe.
 */
function makeCtx(departureDurationSec: number, transitDurationSec: number): SimulationContext {
	const cam = {
		...cameraConfig,
		cruise: {
			...cameraConfig.cruise,
			departureDurationSec,
			transitDurationSec,
			arrivalHoldMs: 1000,
		},
	} as typeof cameraConfig;
	return {
		time: 0, wallTimeSec: 0, wallDeltaSec: 1 / 60,
		lat: 0, lon: 0, altitude: 35000, heading: 0, pitch: 0, bankAngle: 0,
		weather: 'clear', skyState: 'day', nightFactor: 0, dawnDuskFactor: 0,
		locationId: HOME,
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.5, haze: 0.07, warpFactor: 0,
		turbulenceLevel: 'light',
		camera: cam,
		director: directorConfig,
		isLeader: true,
	} as unknown as SimulationContext;
}

/** Step the engine at 60 Hz until `pred` holds or we exceed `maxSec`. */
function runUntil(
	engine: FlightSimEngine,
	ctx: SimulationContext,
	pred: () => boolean,
	maxSec = 60,
) {
	const dt = 1 / 60;
	let t = 0;
	const patches = [];
	while (t < maxSec) {
		// The wall clock is the contract now: no fallback to `dt` exists.
		ctx.wallDeltaSec = dt;
		ctx.wallTimeSec = t;
		patches.push(engine.tick(dt, ctx));
		t += dt;
		if (pred()) return { elapsed: t, patches };
	}
	return { elapsed: Infinity, patches };
}

describe('cruise FSM', () => {
	it('completes the full orbit → cruise → arrival → orbit cycle', () => {
		const e = new FlightSimEngine();
		const ctx = makeCtx(2, 2);
		e.setLocationWithSky(HOME, 'day');
		expect(e.flightMode).toBe('orbit');

		e.flyTo(AWAY, 'day');
		expect(e.flightMode).toBe('cruise_departure');

		runUntil(e, ctx, () => e.flightMode === 'cruise_transit');
		expect(e.flightMode).toBe('cruise_transit');

		const { patches } = runUntil(e, ctx, () => e.flightMode === 'arrival_hold');
		expect(e.flightMode).toBe('arrival_hold');
		// Arrival must announce itself so the model can commit the location.
		expect(patches.some((p) => p.locationArrived === AWAY)).toBe(true);
		expect(patches.some((p) => p.blindOpen === true)).toBe(true);

		runUntil(e, ctx, () => e.flightMode === 'orbit');
		expect(e.flightMode).toBe('orbit');
		expect(e.warpFactor).toBe(0);
	});

	it('finishes the departure warp ramp before leaving the phase', () => {
		// departure LONGER than transit — the exact case the old gate broke.
		const e = new FlightSimEngine();
		const ctx = makeCtx(4, 2);
		e.setLocationWithSky(HOME, 'day');
		e.flyTo(AWAY, 'day');

		runUntil(e, ctx, () => e.flightMode !== 'cruise_departure');

		// The smoothstep must have reached its top before the phase handed off;
		// with the old `transitDurationSec` gate this exited at warp ≈ 0.5.
		expect(e.warpFactor).toBeGreaterThan(0.99);
	});

	it('a shorter departure than transit still completes cleanly', () => {
		const e = new FlightSimEngine();
		const ctx = makeCtx(1, 3);
		e.setLocationWithSky(HOME, 'day');
		e.flyTo(AWAY, 'day');

		const { elapsed } = runUntil(e, ctx, () => e.flightMode === 'cruise_transit');
		expect(elapsed).toBeLessThan(2);          // gated by departure (1s), not transit
		expect(e.warpFactor).toBeGreaterThan(0.99);
	});

	it('flyTo to the location already in flight is a no-op', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky(HOME, 'day');
		e.flyTo(AWAY, 'day');
		const mode = e.flightMode;
		e.flyTo(AWAY, 'day');                            // same target again
		expect(e.flightMode).toBe(mode);
	});

	it('flyTo to an unknown location does not enter cruise', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky(HOME, 'day');
		e.flyTo('not-a-real-place' as never, 'day');
		expect(e.flightMode).toBe('orbit');
	});

	it('mid-cruise flyTo must not pollute the restored orbit speed', () => {
		const e = new FlightSimEngine();
		const ctx = makeCtx(2, 2);
		e.setLocationWithSky(HOME, 'day');
		const orbitSpeed = e.flightSpeed;

		// First leg: fly out, get well into cruise (warped speed).
		e.flyTo(AWAY, 'day');
		runUntil(e, ctx, () => e.flightMode === 'cruise_transit');
		expect(e.flightSpeed).toBeGreaterThan(orbitSpeed + 50); // warp engaged

		// Mid-cruise re-target (LocationPicker during transit). The warped
		// flightSpeed must NOT become the new pre-warp snapshot. NB:
		// LOCATION_IDS is a Set — spread it, it is not indexable.
		const THIRD = [...LOCATION_IDS][2];
		e.flyTo(THIRD, 'day');
		expect(e.cruiseTargetId).toBe(THIRD);

		// Ride the second cruise to completion; arrival restores pre-warp speed.
		runUntil(e, ctx, () => e.flightMode === 'arrival_hold');
		expect(e.flightSpeed).toBe(orbitSpeed);

		// And the orbit afterwards runs at that speed, not ~25x.
		runUntil(e, ctx, () => e.flightMode === 'orbit');
		expect(e.flightSpeed).toBe(orbitSpeed);
	});

	it('isTransitioning is true exactly during the cruise phases', () => {
		const e = new FlightSimEngine();
		const ctx = makeCtx(2, 2);
		e.setLocationWithSky(HOME, 'day');
		expect(e.isTransitioning).toBe(false);

		e.flyTo(AWAY, 'day');
		expect(e.isTransitioning).toBe(true);

		runUntil(e, ctx, () => e.flightMode === 'arrival_hold');
		// arrival_hold is a settle, not a transition — the blind is open again.
		expect(e.isTransitioning).toBe(false);
	});
});
