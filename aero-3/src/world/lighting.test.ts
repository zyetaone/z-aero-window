import { expect, test } from 'bun:test';
import { lightingAt, moonlightAt } from './lighting.ts';

const knobs = { sky: 1.7, lift: 8, lamps: 1, carpet: 1, moonlight: 0.4 };
const mix = { haze: 0.12, glow: 0.35 };

test('day is lit by the sun alone: no lamps, no glow, no haze', () => {
	const l = lightingAt(40, knobs, mix, 1, 1, false);
	expect(l.dark).toBe(0);
	expect([l.emissive, l.haze, l.lampAlpha, l.glow, l.stars]).toEqual([0, 0, 0, 0, 0]);
	expect(l.glowOn).toBe(false);
	expect(l.exposure).toBe(knobs.sky);
});

test('at night the exposure lift is divided back out of every emissive gain', () => {
	const l = lightingAt(-30, knobs, mix, 1.4, 1, false);
	expect(l.dark).toBe(1);
	expect(l.emissive * l.exposure).toBeCloseTo(knobs.lamps); // what reaches the screen is the gain itself
	expect(l.haze * l.exposure).toBeCloseTo(mix.haze * 1.4);
	expect(l.glowOn).toBe(true);
});

test('additive lamps never reach alpha 1 (the opaque-pass trap), and a hot Pi sheds haze and bloom', () => {
	expect(lightingAt(-30, { ...knobs, lamps: 50 }, mix, 1, 1.15, false).lampAlpha).toBeLessThan(1);
	const hot = lightingAt(-30, knobs, mix, 1, 1, true);
	expect([hot.haze, hot.glowOn]).toEqual([0, false]);
});

test('moonlight: a new or set moon keeps a skyglow floor from overhead; a full high moon is four times it', () => {
	const set = moonlightAt({ x: 1, y: -0.2, z: 0, illumination: 1, elevationDeg: -10 }, 1, 0.4);
	expect(set.intensity).toBeCloseTo(0.1);
	expect(set.direction[1]).toBeCloseTo(-1); // straight down
	const full = moonlightAt({ x: 0, y: 1, z: 0, illumination: 1, elevationDeg: 60 }, 1, 0.4);
	expect(full.intensity).toBeCloseTo(0.4);
	expect(moonlightAt({ x: 0, y: 1, z: 0, illumination: 1, elevationDeg: 60 }, 0, 0.4).intensity).toBe(0); // daytime
});
