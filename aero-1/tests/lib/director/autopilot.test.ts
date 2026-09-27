/**
 * Coverage for directorTick's gates: followers never randomise (leader
 * gate) and randomisation fires on the leader once the interval lapses.
 * (The Move-2 show-precedence guard that used to live here was deleted
 * with the show timeline runner — Jul-13 council.)
 */
import { describe, it, expect } from 'vitest';
import { directorTick } from '$lib/director/autopilot.svelte';
import type { SimulationContext } from '$lib/types';

function makeCtx(overrides: Partial<SimulationContext> = {}): SimulationContext {
	return {
		time: 0, wallTimeSec: 0, wallDeltaSec: 0, lat: 17, lon: 78, altitude: 35000, heading: 0, pitch: 0,
		bankAngle: 0, weather: 'cloudy', skyState: 'day',
		nightFactor: 0, dawnDuskFactor: 0, locationId: 'hyderabad',
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
				weatherChangeChance: 1,
				weatherPool: ['clear'],
				directorMinInterval: 1, directorMaxInterval: 1,
				nightLitCitiesOnly: false,
				// vantage must exist (required config key) — disabled here so the
				// beat never fires during randomisation coverage.
				vantage: { enabled: false },
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

describe('directorTick — gates', () => {
	it('returns empty patch when not leader', () => {
		const patch = directorTick(makeCtx({ isLeader: false, wallDeltaSec: 100 }));
		expect(patch.configs).toBeUndefined();
		expect(patch.nextLocation).toBeUndefined();
	});

	it('runs randomisation on the leader once the interval lapses', () => {
		// Two ticks: first seeds lazy timers, second fires past the (1s) interval.
		directorTick(makeCtx());
		const patch = directorTick(makeCtx({ wallDeltaSec: 5 }));
		expect(patch.configs).toBeDefined();
		expect(patch.configs!.length).toBeGreaterThan(0);
	});
});
