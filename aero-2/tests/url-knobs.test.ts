import { describe, it, expect } from 'vitest';
import { readSettings, KNOB_RANGE } from '#lib/settings/settings.svelte.js';
import { FlightTrack } from '#lib/display/flight/flight-path.js';

const read = (qs: string) => readSettings(new URL(`http://pane/?${qs}`));

describe('URL knobs vs KNOB_RANGE', () => {
	it('clamps a floor far below the ground', () => {
		const s = read('place=denver&floor=-999999');
		expect(s.floorM).toBeGreaterThanOrEqual(KNOB_RANGE.floorM[0]);
	});

	it('clamps a pitch past straight down', () => {
		const s = read('pitch=-9999');
		expect(s.pitchDeg).toBeGreaterThanOrEqual(KNOB_RANGE.pitchDeg[0]);
	});

	it('clamps speed to something a window can be watched at', () => {
		const s = read('speed=100000');
		expect(s.speed).toBeLessThanOrEqual(KNOB_RANGE.speed[1]);
	});

	it('clamps a clock offset outside a day', () => {
		const s = read('clock=99');
		expect(s.clockOffsetH).toBeLessThanOrEqual(KNOB_RANGE.clockOffsetH[1]);
	});

	it('clamps terrain exaggeration', () => {
		const s = read('exaggeration=500');
		expect(s.exaggeration).toBeLessThanOrEqual(KNOB_RANGE.exaggeration[1]);
	});
});

describe('clamping must not disturb legitimate values', () => {
	it('passes in-range params through untouched', () => {
		const s = read('place=denver&pitch=-12&speed=3.5&clock=-5&exaggeration=1.4&cloudDensity=0.8');
		expect(s.pitchDeg).toBe(-12);
		expect(s.speed).toBe(3.5);
		expect(s.clockOffsetH).toBe(-5);
		expect(s.exaggeration).toBe(1.4);
		expect(s.cloudDensity).toBe(0.8);
	});

	it('tunes wing yaw from the URL like its pitch sibling', () => {
		const s = read('place=denver&wingYaw=-20');
		expect(s.wingYawDeg).toBe(-20);
	});

	it('clamps wing yaw to its knob range', () => {
		const s = read('place=denver&wingYaw=9999');
		expect(s.wingYawDeg).toBeLessThanOrEqual(KNOB_RANGE.wingYawDeg[1]);
	});

	it('still falls back when a param is absent or unparseable', () => {
		const s = read('place=denver&pitch=banana');
		expect(Number.isFinite(s.pitchDeg)).toBe(true);
		expect(s.pitchDeg).toBeLessThanOrEqual(KNOB_RANGE.pitchDeg[1]);
	});

	it('keeps the place-derived envelope when no floor is given', () => {
		const s = read('place=denver');
		expect(s.floorM).toBe(3000);
	});
});

/**
 * The climb band is a PAIR, and per-knob clamping cannot see a pair.
 *
 * Every value below is individually legal — floor and ceiling share the same
 * [0, 20_000] range — so KNOB_RANGE passes them all. Inverted, `altitudeAt`
 * computes a negative band and its `min(ceiling, max(floor, …))` lets the
 * ceiling win, silently discarding the floor. The floor is the safety number:
 * over the Himalayas it is what holds the camera above Everest.
 */
describe('climb band ordering', () => {
	it('does not let a URL ceiling discard the floor', () => {
		const s = read('place=himalayas&floor=4600&ceiling=1000');
		expect(s.floorM).toBeLessThanOrEqual(s.ceilingM);
		// The floor is the safety bound, so it is the one that must survive.
		expect(s.floorM).toBe(4600);
	});

	it('keeps the camera above the summit with an inverted URL band', () => {
		const s = read('place=himalayas&floor=4600&ceiling=1000');
		const track = new FlightTrack(s.place.lat, s.place.lon, s.floorM, s.ceilingM, 1, 0.5);
		let minAgl = Infinity;
		for (let t = 0; t < 3000; t += 1) minAgl = Math.min(minAgl, track.altitudeAt(t));
		// Camera sits at the mean ground plus AGL; Everest is 8,849 m.
		expect(s.place.groundElevationM + minAgl).toBeGreaterThan(8_849);
	});

	it('lets the moved slider win so a drag does not snap back', () => {
		const s = read('place=denver');
		s.set('ceilingM', 2_000); // dragged below the 3,000 floor
		expect(s.floorM).toBeLessThanOrEqual(s.ceilingM);
		expect(s.ceilingM).toBe(2_000);

		s.set('floorM', 9_000); // now dragged above the ceiling
		expect(s.floorM).toBeLessThanOrEqual(s.ceilingM);
		expect(s.floorM).toBe(9_000);
	});

	it('leaves an ordinary band untouched', () => {
		const s = read('place=denver&floor=3000&ceiling=13000');
		expect(s.floorM).toBe(3_000);
		expect(s.ceilingM).toBe(13_000);
	});
});
