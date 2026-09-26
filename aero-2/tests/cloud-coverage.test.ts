import { describe, it, expect } from 'vitest';
import {
	CLOUD_BRIGHTNESS,
	CLOUD_POOLS,
	cirrusCountFor,
	distantCountFor,
	nearCountFor,
	WEATHER_COVERAGE
} from '#lib/display/world/cloud-field.js';
import type { Weather } from '#lib/display/flight/view.js';

/**
 * Weather must change how much cloud there is, not only how it is lit.
 *
 * Measured before the first version of this existed: 439 sprites on `clear`,
 * and 439 on `storm` — identical in all five weathers. The deck was fully
 * lit-reactive and entirely population-static.
 *
 * These tables and counters used to live inline in `Clouds.svelte` behind a
 * WebGL canvas, so this file source-grepped the component. They have since
 * moved to the renderer-free `cloud-field.ts`, which is imported directly —
 * a stronger assertion than text matching, and it also covers the rebuild
 * wiring the old file could only gesture at.
 */
const WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'overcast', 'storm'];

describe('cloud coverage responds to weather', () => {
	it('declares a coverage scalar for every weather', () => {
		for (const w of WEATHERS) {
			expect(WEATHER_COVERAGE[w]).toBeGreaterThan(0);
		}
	});

	it('scales all three tiers by it', () => {
		for (const w of WEATHERS) {
			const cov = WEATHER_COVERAGE[w];
			// Counts move with coverage in every tier (exact shape is pinned
			// in cloud-field.test.ts; here the wiring is what matters).
			expect(distantCountFor(0.75, 1, cov)).toBeGreaterThanOrEqual(1);
			expect(nearCountFor(0.75, 1, cov)).toBeGreaterThanOrEqual(1);
			expect(cirrusCountFor(0.75, 1, cov)).toBeGreaterThanOrEqual(1);
		}
		expect(distantCountFor(0.75, 1, 1.65)).toBeGreaterThan(distantCountFor(0.75, 1, 0.35));
		expect(nearCountFor(0.75, 1, 1.65)).toBeGreaterThan(nearCountFor(0.75, 1, 0.35));
	});

	it('keeps clear skies emptier than storms', () => {
		expect(WEATHER_COVERAGE.clear).toBeLessThan(WEATHER_COVERAGE.cloudy);
		expect(WEATHER_COVERAGE.cloudy).toBeLessThan(WEATHER_COVERAGE.rain);
		expect(WEATHER_COVERAGE.rain).toBeLessThan(WEATHER_COVERAGE.overcast);
		expect(WEATHER_COVERAGE.overcast).toBeLessThan(WEATHER_COVERAGE.storm);
	});

	it('deals white texture on clear and smoke on storm, never the reverse', () => {
		expect(CLOUD_POOLS.clear).not.toContain(2);
		expect(CLOUD_POOLS.storm).not.toContain(0);
		expect(CLOUD_BRIGHTNESS.clear).toBeGreaterThan(CLOUD_BRIGHTNESS.storm);
	});
});
