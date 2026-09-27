/**
 * tickVantage — the controlled-random night-city flyover beat.
 *
 * Gates verified: leader-only, orbit-only, night-only (nightFactor gate),
 * passenger-altitude cancels, bounded params come straight from config, and
 * the beat never fires the same frame as a location change (location wins).
 * directorReset() zeroes the module-level vantage timer between cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { directorTick, directorReset } from '$lib/director/autopilot.svelte';
import type { SimulationContext } from '$lib/types';

function makeCtx(overrides: Partial<SimulationContext> = {}): SimulationContext {
	return {
		time: 0, wallTimeSec: 0, wallDeltaSec: 0, lat: 17, lon: 78, altitude: 35000, heading: 0, pitch: 0,
		bankAngle: 0, weather: 'clear', skyState: 'night',
		nightFactor: 1, dawnDuskFactor: 0, locationId: 'hyderabad',
		userAdjustingAltitude: false, userAdjustingTime: false, userAdjustingAtmosphere: false,
		cloudDensity: 0.5, cloudSpeed: 0.4, haze: 0.1, warpFactor: 0,
		turbulenceLevel: 'light',
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		camera: {} as any,
		director: {
			autopilot: {
				enabled: true,
				initialMinDelay: 1, initialMaxDelay: 1,
				subsequentMinDelay: 1, subsequentMaxDelay: 1,
				weatherChangeChance: 0,
				weatherPool: ['clear'],
				// Huge location interval so tickDirector never fires during these
				// tests (except the mutual-exclusion case which overrides it).
				directorMinInterval: 9999, directorMaxInterval: 9999,
				nightLitCitiesOnly: false,
				vantage: {
					enabled: true,
					minNightFactor: 0.6,
					minIntervalSec: 1, maxIntervalSec: 1,   // deterministic interval
					durationSec: 45, pitchDeg: -60, altitudeFt: 9000,
				},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
			ambient: {
				cloudDensityShift: 0.1, cloudDensityMin: 0, cloudDensityMax: 1,
				cloudSpeedShift: 0.1, cloudSpeedMin: 0, cloudSpeedMax: 1,
				hazeShift: 0.05, hazeMin: 0, hazeMax: 1,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
			daylight: { syncIntervalMs: 1000 },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any,
		isOrbitMode: true,
		isLeader: true,
		pickNextLocation: () => 'dubai',
		...overrides,
	};
}

/** Seed the lazy timer (tick 0), then fire past the 1s interval (tick 5). */
function seedThenFire(ctx: SimulationContext) {
	directorTick(0, ctx);
	return directorTick(5, { ...ctx, wallDeltaSec: 5 });
}

beforeEach(() => directorReset(makeCtx()));

describe('tickVantage — night-city flyover beat', () => {
	it('fires on the leader at night once the interval lapses', () => {
		const patch = seedThenFire(makeCtx());
		expect(patch.vantageBeat).toBeDefined();
		expect(patch.vantageBeat).toEqual({ durationMs: 45_000, pitchDeg: -60, altitudeFt: 9000 });
	});

	it('does not fire before the interval lapses', () => {
		const patch = directorTick(0, makeCtx());   // only the lazy-seed tick
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('never fires on a follower (leader gate)', () => {
		const patch = seedThenFire(makeCtx({ isLeader: false }));
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('never fires outside orbit mode', () => {
		const patch = seedThenFire(makeCtx({ isOrbitMode: false }));
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('does not fire in daytime (nightFactor at/under the gate)', () => {
		const patch = seedThenFire(makeCtx({ nightFactor: 0.3 }));
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('holds while a passenger is adjusting altitude', () => {
		const patch = seedThenFire(makeCtx({ userAdjustingAltitude: true }));
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('never fires the same frame as a location change (location wins)', () => {
		// directorMinInterval=1 so the location director fires this frame.
		const liveCtx = () => makeCtx({
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			director: { ...makeCtx().director,
				autopilot: { ...(makeCtx().director as any).autopilot, directorMinInterval: 1, directorMaxInterval: 1 },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} as any,
		});
		directorReset(liveCtx());
		const patch = seedThenFire(liveCtx());
		expect(patch.nextLocation).toBeDefined();
		expect(patch.vantageBeat).toBeUndefined();
	});

	it('does not fire when the vantage config is disabled', () => {
		const ctx = makeCtx();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(ctx.director as any).autopilot.vantage.enabled = false;
		directorReset(ctx);
		const patch = seedThenFire(ctx);
		expect(patch.vantageBeat).toBeUndefined();
	});
});
