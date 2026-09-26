import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveLocalHours, subSolarPoint, sunPosition } from '#lib/display/world/sun.js';

/**
 * One scene, one sun.
 *
 * `clockOffsetH` is how a preset says "show me Dubai at midnight" while it is
 * really lunchtime, and it is not cosmetic: `sunPosition` folds it into the
 * utcOffset argument, which feeds `hourAngle` and therefore real solar
 * ELEVATION. Ground grading, sky colour, VIIRS opacity and wing lighting all
 * follow it.
 *
 * Anything asking a GLOBAL question -- "where is the sub-solar point?" -- takes
 * no utcOffset, so it has nothing to fold the offset into and silently answers
 * for real now. `Terminator` and `SunMoon` each sampled a private `Date.now()`
 * and did exactly that: measured at `?preset=alpine-ridge`, the ground and sky
 * were lit for a +14.4 deg sun while the night bands and the sun disc were
 * placed for the real one at -39.5 deg. Two suns, 54 deg apart, in one frame,
 * and 556 passing tests saw none of it.
 */
describe('the composed clock', () => {
	/**
	 * The identity `AeroDisplay.solarSec` rests on. If this ever stops holding,
	 * shifting the instant and shifting the utcOffset stop agreeing, and the
	 * global drawers silently diverge from `display.sun` again.
	 */
	it('shifting the instant equals shifting the utcOffset', () => {
		const t = 1_757_700_000;
		for (const offsetH of [-11.5, -6, -0.25, 0, 0.25, 6, 11.5]) {
			expect(resolveLocalHours(t + offsetH * 3600, 5.75)).toBeCloseTo(
				resolveLocalHours(t, 5.75 + offsetH),
				9
			);
		}
	});

	it('moves the sub-solar point, so global drawers follow the scene', () => {
		const t = 1_757_700_000;
		const real = subSolarPoint(t);
		const composed = subSolarPoint(t + 6 * 3600);
		// Six hours is a quarter turn: ~90 deg of longitude, not a rounding wobble.
		const dLng = Math.abs(((composed.lng - real.lng + 540) % 360) - 180);
		expect(dLng).toBeGreaterThan(80);
	});

	/**
	 * The measured case, as an assertion rather than an anecdote: a composed
	 * scene lit by a sun well above the horizon must not be handed a sub-solar
	 * point that puts the same place in deep night.
	 */
	it('agrees with display.sun on whether it is day', () => {
		const t = 1_757_700_000;
		const lat = 28.06;
		const lng = 86.52;
		const offsetH = 4.25;
		const composedSec = t + offsetH * 3600;

		const scene = sunPosition(t, lat, 5.75 + offsetH);
		const sub = subSolarPoint(composedSec);
		const d2r = Math.PI / 180;
		const globalElev =
			Math.asin(
				Math.sin(lat * d2r) * Math.sin(sub.lat * d2r) +
					Math.cos(lat * d2r) * Math.cos(sub.lat * d2r) * Math.cos((lng - sub.lng) * d2r)
			) / d2r;

		expect(Math.sign(globalElev)).toBe(Math.sign(scene.elevationDeg));
		expect(Math.abs(globalElev - scene.elevationDeg)).toBeLessThan(10);
	});
});

/**
 * The two components that ask the global question. A behavioural test cannot
 * reach them -- one lives in a MapLibre custom WebGL render callback, the other
 * behind a 60 s timer -- so this is a source scan, the same technique
 * regressions.test.ts already uses for the frame loop and upstream hosts.
 */
describe('no renderer keeps a private solar clock', () => {
	const GLOBAL_SOLAR_DRAWERS = [
		'src/lib/display/world/Terminator.svelte',
		'src/lib/display/world/SunMoon.svelte'
	];

	it.each(GLOBAL_SOLAR_DRAWERS)('%s reads the composed clock', (file) => {
		const code = readFileSync(file, 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^\s*(\/\/|\s\*).*$/gm, '');

		expect(code, 'must not sample its own clock').not.toMatch(/Date\.now\s*\(/);
		expect(code, 'must read display.solarSec').toMatch(/\bsolarSec\b/);
	});
});
