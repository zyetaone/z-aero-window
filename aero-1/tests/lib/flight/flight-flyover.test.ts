/**
 * Flight flyover-altitude override — the beat drives the camera down to a low
 * altitude (overriding the location's nightAltitude), clamped to camera bounds,
 * and releases cleanly. Deterministic (no random) so all 3 Pis descend
 * identically. Two engines at the same override must stay lock-step.
 */
import { describe, it, expect } from 'vitest';
import { FlightSimEngine } from '$lib/flight/flight.svelte';
import type { SimulationContext } from '$lib/types';

const ALT = { default: 35000, min: 10000, max: 65000 };

function ctx(overrides: Partial<SimulationContext> = {}): SimulationContext {
	return {
		time: 0, wallTimeSec: 0, wallDeltaSec: 0.1, lat: 17, lon: 78, altitude: 35000, heading: 0, pitch: 0,
		bankAngle: 0, weather: 'clear', skyState: 'night',
		nightFactor: 1, dawnDuskFactor: 0, locationId: 'hyderabad',
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.4, haze: 0.1, warpFactor: 0,
		turbulenceLevel: 'light',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		camera: { altitude: ALT } as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		director: {} as any,
		isOrbitMode: true, isLeader: true,
		...overrides,
	};
}

/** Run N ticks of ~1s so the altitude lerp has time to converge. */
function run(e: FlightSimEngine, n: number) {
	for (let i = 0; i < n; i++) e.tick(0.1, ctx());
}

describe('FlightSimEngine flyover altitude override', () => {
	it('descends toward the flyover altitude, overriding nightAltitude', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky('hyderabad', 'night');
		e.altitude = 35000;
		e.setFlyoverAltitude(9000);
		run(e, 300);
		expect(e.altitude).toBeLessThan(11000);   // descended past nightAltitude toward the 9k target (clamped to 10k min)
	});

	it('clamps the override to camera.altitude.min', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky('hyderabad', 'night');
		e.altitude = 35000;
		e.setFlyoverAltitude(1);                   // absurdly low
		run(e, 300);
		expect(e.altitude).toBeGreaterThanOrEqual(ALT.min - 1);
	});

	it('release restores normal altitude logic', () => {
		const e = new FlightSimEngine();
		e.setLocationWithSky('hyderabad', 'night');
		e.altitude = 35000;
		e.setFlyoverAltitude(9000);
		run(e, 200);
		const low = e.altitude;
		e.clearFlyoverAltitude();
		run(e, 400);
		expect(e.altitude).toBeGreaterThan(low);   // climbs back toward the location's nightAltitude
	});

	it('two engines with the same override stay lock-step (3-Pi safety)', () => {
		const a = new FlightSimEngine();
		const b = new FlightSimEngine();
		for (const e of [a, b]) { e.setLocationWithSky('hyderabad', 'night'); e.altitude = 35000; e.setFlyoverAltitude(9000); }
		run(a, 120); run(b, 120);
		expect(a.altitude).toBeCloseTo(b.altitude, 6);
	});
});
