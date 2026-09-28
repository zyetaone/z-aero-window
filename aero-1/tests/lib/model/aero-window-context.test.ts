/**
 * Per-frame context assembly.
 *
 * The marshalling is mechanical; the wall-clock handling is not, and it was
 * previously buried mid-class where it could only be reached through a whole
 * AeroWindow. Both of its clamps exist because of a real failure, and both
 * fail SILENTLY when wrong — the consumers are integrators (orbitAngle,
 * scenarioProgress), so a bad delta doesn't throw, it just parks the scene in
 * a slow recovery nobody can explain.
 */
import { describe, it, expect } from 'vitest';
import {
	wallDeltaSec,
	SimulationContextBuilder,
	type ContextSource,
} from '$lib/model/aero-window-context';
import { camera, director } from '$lib/model/config-tree.svelte';
import type { SimulationContext } from '$lib/types';

describe('wallDeltaSec', () => {
	it('measures an ordinary frame gap in seconds', () => {
		expect(wallDeltaSec(1_000_500, 1_000_000)).toBeCloseTo(0.5);
	});

	it('reports 0 on the very first frame', () => {
		// lastMs === 0 means "no previous instant", not "the epoch" — measuring
		// from 1970 would hand the integrators a 56-year delta.
		expect(wallDeltaSec(1_700_000_000_000, 0)).toBe(0);
	});

	it('caps a resumed tab instead of teleporting the orbit', () => {
		// A backgrounded tab (or a stalled Pi compositor) resumes with an
		// arbitrarily large gap.
		expect(wallDeltaSec(1_000_000 + 600_000, 1_000_000)).toBe(5);
	});

	it('floors an NTP step BACKWARD at zero', () => {
		// The fleet has no RTC, so a backward step at boot is ordinary. A
		// negative delta drives the integrators far negative rather than
		// merely pausing them.
		expect(wallDeltaSec(1_000_000, 1_003_600_000)).toBe(0);
	});

	it('never returns NaN, whatever it is handed', () => {
		for (const [now, last] of [[NaN, 1], [1, NaN], [Infinity, 1]] as const) {
			expect(Number.isFinite(wallDeltaSec(now, last)), `${now}/${last}`).toBe(true);
		}
	});
});

function source(over: Partial<ContextSource> = {}): ContextSource {
	return {
		flight: { lat: 17.4, lon: 78.3, altitude: 32_000, heading: 90, pitch: 2, warpFactor: 0 },
		motion: { bankAngle: 5 },
		weather: 'storm',
		skyState: 'night',
		nightFactor: 0.8,
		dawnDuskFactor: 0.1,
		location: 'dubai',
		userAdjustingAltitude: false,
		userAdjustingTime: false,
		userAdjustingAtmosphere: false,
		config: { atmosphere: { clouds: { density: 0.6, speed: 1.2 }, haze: { amount: 0.07 } } },
		...over,
	} as ContextSource;
}

const seed = { camera, director } as unknown as Pick<SimulationContext, 'camera' | 'director'>;

describe('SimulationContextBuilder', () => {
	it('copies model state onto the context', () => {
		const c = new SimulationContextBuilder(seed).build(source(), 1_000_000);
		expect(c.altitude).toBe(32_000);
		expect(c.locationId).toBe('dubai');
		expect(c.nightFactor).toBe(0.8);
		expect(c.cloudSpeed).toBe(1.2);
		// `time` is gone: the context carries one clock, and nowMs is the only input.
		expect(c.wallTimeSec).toBe(1_000);
	});

	it('derives turbulence from the weather recipe rather than storing it twice', () => {
		const c = new SimulationContextBuilder(seed).build(source({ weather: 'storm' }), 1_000);
		expect(c.turbulenceLevel).toBe('severe');
	});

	it('reuses ONE object across frames', () => {
		// Deliberate: allocating a context at 60 Hz on a Pi is real GC pressure,
		// and every consumer reads it synchronously in-frame. If this ever stops
		// holding, the aliasing assumption behind that choice is gone.
		const b = new SimulationContextBuilder(seed);
		expect(b.build(source(), 1_000)).toBe(b.build(source(), 2_000));
	});

	it('advances the wall cursor between frames', () => {
		const b = new SimulationContextBuilder(seed);
		b.build(source(), 1_000_000);
		expect(b.build(source(), 1_002_000).wallDeltaSec).toBeCloseTo(2);
	});

	it('reports zero delta on its first frame only', () => {
		const b = new SimulationContextBuilder(seed);
		expect(b.build(source(), 1_000_000).wallDeltaSec).toBe(0);
		expect(b.build(source(), 1_000_500).wallDeltaSec).toBeCloseTo(0.5);
	});
});
