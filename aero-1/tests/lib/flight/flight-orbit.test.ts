/**
 * Flight orbit determinism — the per-location orbit (bearing, start angle,
 * rotation direction) must be IDENTICAL across two engine instances at the
 * same location on the same day. This is what keeps a 3-Pi panorama
 * position-locked: each Pi runs its own FlightSimEngine, and if the orbit
 * seed diverged the three cameras would sit at different positions and the
 * panorama wouldn't tile.
 *
 * Previously this used raw Math.random() — these tests pin the daySeed()-
 * seeded replacement so a regression back to Math.random() fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { FlightSimEngine } from '$lib/flight/flight.svelte';
import { LOCATION_IDS } from '$content/locations';
import type { SimulationContext } from '$lib/types';

const FIRST_LOCATION = [...LOCATION_IDS][0];
const SECOND_LOCATION = [...LOCATION_IDS][1];

/**
 * Tick context with explicit wall-clock fields. The panorama position-lock
 * invariant needs orbit/scenario motion to be a function of WALL time
 * (wallTimeSec/wallDeltaSec), not ctx.time/delta: delta is clamped to 100 ms,
 * so a 3 fps Pi accumulates sim time at ~0.3× wall clock and a 5 fps Pi at
 * ~0.5× — boot-relative sim time decorrelated the panes within minutes.
 */
/**
 * The `time` parameter this used to take is gone with the field.
 *
 * It was the whole point of the test: a boot-relative second (312.7) beside a
 * wall second (1_750_000), so that any consumer reading the wrong one produced
 * a visibly different orbit. That distinction is now structural — the context
 * has exactly one clock and it is the wall one — so the argument has no way to
 * express itself. Kept as this comment because "the wall clock is not
 * interchangeable with a sim clock" is still the property worth protecting; it
 * just cannot be violated through this helper any more.
 */
function tickCtx(wallTimeSec: number, wallDeltaSec: number): SimulationContext {
	return {
		wallTimeSec, wallDeltaSec,
		lat: 17, lon: 78, altitude: 35000, heading: 0, pitch: 0,
		bankAngle: 0, weather: 'clear', skyState: 'night',
		nightFactor: 1, dawnDuskFactor: 0, locationId: 'hyderabad',
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.4, haze: 0.1, warpFactor: 0,
		turbulenceLevel: 'light',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		camera: {
			altitude: { default: 35000, min: 10000, max: 65000 },
			orbit: { breathePeriod: 180, majorMin: 0.08, majorMax: 0.25, driftRate: 0.01 },
		} as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		director: {} as any,
		isOrbitMode: true, isLeader: true,
	};
}

describe('FlightSimEngine orbit determinism', () => {
	it('two engines at the same location get an identical orbit', () => {
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(FIRST_LOCATION, 'day');
		b.setLocationWithSky(FIRST_LOCATION, 'day');
		expect(a.orbitBearing).toBe(b.orbitBearing);
		expect(a.orbitAngle).toBe(b.orbitAngle);
		expect(a.orbitDirection).toBe(b.orbitDirection);
	});

	it('orbitDirection is always +1 or -1', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky(FIRST_LOCATION, 'day');
		expect([1, -1]).toContain(e.orbitDirection);
	});

	it('different locations can yield different orbits (seed varies by location)', () => {
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(FIRST_LOCATION, 'day');
		b.setLocationWithSky(SECOND_LOCATION, 'day');
		// At least one orbit parameter should differ — the location hash feeds
		// the seed, so two different locations don't share the same orbit.
		const differs =
			a.orbitBearing !== b.orbitBearing ||
			a.orbitAngle !== b.orbitAngle ||
			a.orbitDirection !== b.orbitDirection;
		expect(differs).toBe(true);
	});

	it('re-seeding the same location is stable (idempotent within a day)', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky(FIRST_LOCATION, 'day');
		const dir1 = e.orbitDirection;
		const bear1 = e.orbitBearing;
		e.setLocationWithSky(SECOND_LOCATION, 'day');
		e.setLocationWithSky(FIRST_LOCATION, 'day');
		expect(e.orbitDirection).toBe(dir1);
		expect(e.orbitBearing).toBe(bear1);
	});
});

describe('FlightSimEngine wall-clock position lock', () => {
	it('same wall instant, different sim time/delta → identical position', () => {
		// A 60 fps pane (small delta, large boot-relative time) and a 3 fps Pi
		// (clamped 100 ms delta, tiny sim time) at the SAME wall instant must
		// compute the same orbit position. Regression pin: breathe/wander used
		// ctx.time and the angle integrated the clamped delta, so the panes
		// decorrelated within minutes.
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(FIRST_LOCATION, 'day');
		b.setLocationWithSky(FIRST_LOCATION, 'day');

		a.tick(0.016, tickCtx(/*wallTimeSec*/ 1_750_000, /*wallDeltaSec*/ 0.4));
		b.tick(0.1, tickCtx(/*wallTimeSec*/ 1_750_000, /*wallDeltaSec*/ 0.4));

		expect(a.lat).toBe(b.lat);
		expect(a.lon).toBe(b.lon);
		expect(a.heading).toBe(b.heading);
	});

	it('different wall instants → different positions (wall time actually drives)', () => {
		// Companion to the above: proves the tick reads the wall fields at all,
		// so the first test can't pass vacuously.
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		a.setLocationWithSky(FIRST_LOCATION, 'day');
		b.setLocationWithSky(FIRST_LOCATION, 'day');

		a.tick(0.1, tickCtx(1_750_000, 0.1));
		b.tick(0.1, tickCtx(1_750_000 + 90, 0.1));   // 90 wall-seconds later

		const differs = a.lat !== b.lat || a.lon !== b.lon || a.heading !== b.heading;
		expect(differs).toBe(true);
	});
});
