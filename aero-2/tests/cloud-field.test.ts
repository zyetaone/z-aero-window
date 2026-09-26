import { describe, it, expect } from 'vitest';
import {
	buildCloudField,
	CLOUD_BRIGHTNESS,
	CLOUD_POOLS,
	CIRRUS_POOLS,
	CLOUD_PROXIMITY,
	cirrusCountFor,
	distantCountFor,
	nearCountFor,
	pickTexSlot,
	WEATHER_COVERAGE
} from '#lib/display/world/cloud-field.js';
import { mulberry32 } from '#lib/display/flight/flight-path.js';
import type { Weather } from '#lib/display/flight/view.js';

const WEATHERS: Weather[] = ['clear', 'cloudy', 'rain', 'overcast', 'storm'];

function field(seed: number, weather: Weather, coverage?: number) {
	const cov = coverage ?? WEATHER_COVERAGE[weather];
	return buildCloudField({
		rand: mulberry32(seed),
		weather,
		brightBase: CLOUD_BRIGHTNESS[weather],
		nearRadius: 1 - 0.45 * (CLOUD_PROXIMITY[weather] ?? 0),
		distantCount: distantCountFor(0.75, 1, cov),
		nearCount: nearCountFor(0.75, 1, cov),
		cirrusCount: cirrusCountFor(0.75, 1, cov)
	});
}

describe('weather tables', () => {
	it('orders coverage clear < cloudy < rain < overcast < storm', () => {
		const vals = WEATHERS.map((w) => WEATHER_COVERAGE[w]);
		expect([...vals].sort((a, b) => a - b)).toEqual(vals);
	});

	it('keeps clear skies emptier than storms in every tier', () => {
		for (const fn of [distantCountFor, nearCountFor]) {
			expect(fn(0.75, 1, WEATHER_COVERAGE.clear)).toBeLessThan(fn(0.75, 1, WEATHER_COVERAGE.storm));
		}
	});

	it('thins cirrus as the deck thickens (lid, not more of everything)', () => {
		expect(cirrusCountFor(0.75, 1, WEATHER_COVERAGE.clear)).toBeGreaterThan(
			cirrusCountFor(0.75, 1, WEATHER_COVERAGE.storm)
		);
	});

	it('never deals smoke on clear, never deals white on storm', () => {
		expect(CLOUD_POOLS.clear).not.toContain(2);
		expect(CLOUD_POOLS.storm).not.toContain(0);
		expect(CIRRUS_POOLS.clear).toEqual([0]);
	});

	it('floors every tier at one cluster — empty reads as broken', () => {
		expect(distantCountFor(0, 0.5, 0.3)).toBeGreaterThanOrEqual(1);
		expect(nearCountFor(0, 0.5, 0.3)).toBeGreaterThanOrEqual(1);
		expect(cirrusCountFor(0, 0.5, 0.3)).toBeGreaterThanOrEqual(1);
	});
});

describe('pickTexSlot', () => {
	it('consumes no draw on single-texture pools (the undefined-map guard)', () => {
		let draws = 0;
		const counting = () => {
			draws++;
			return 0.5;
		};
		expect(pickTexSlot(1, counting)).toBe(0);
		expect(draws).toBe(0);
	});

	it('biases toward the pool head without ever leaving it', () => {
		const rng = mulberry32(99);
		for (let k = 0; k < 200; k++) {
			const s = pickTexSlot(4, rng);
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThan(4);
		}
		const heads = Array.from({ length: 200 }, () => pickTexSlot(4, mulberry32(7)));
		expect(heads.filter((s) => s === 0).length).toBeGreaterThan(100);
	});
});

describe('buildCloudField determinism (3-Pi seam)', () => {
	it('same seed → identical deck on every pane', () => {
		for (const w of WEATHERS) {
			expect(field(4242, w)).toEqual(field(4242, w));
		}
	});

	it('lighter coverage is a strict prefix per tier off the shared stream', () => {
		const light = field(4242, 'cloudy', 0.8);
		const heavy = field(4242, 'cloudy', 1.2);
		const lightDistant = distantCountFor(0.75, 1, 0.8);
		expect(heavy.slice(0, lightDistant)).toEqual(light.slice(0, lightDistant));
	});

	it('stays inside authored ranges', () => {
		for (const cluster of field(4242, 'storm')) {
			expect(cluster.sprites.length).toBeGreaterThanOrEqual(1);
			expect(cluster.sprites.length).toBeLessThanOrEqual(14);
			expect(Math.abs(cluster.shear)).toBeLessThanOrEqual(0.125 + 1e-12);
			for (const s of cluster.sprites) {
				expect(s.brightness).toBeGreaterThanOrEqual(0.6);
				expect(s.brightness).toBeLessThanOrEqual(0.75);
				expect(s.opacity).toBeGreaterThanOrEqual(0.34);
				expect(s.opacity).toBeLessThanOrEqual(0.64 + 1e-9);
				expect(s.texSlot).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

describe('draw-order contract', () => {
	it('texSlot never escapes its pool (the undefined-map guard)', () => {
		// `1 + floor(rand() * (len - 1))` is index 1 on a one-texture pool —
		// Three warns once, then draws a flat untextured card. The length
		// guard in pickTexSlot is what stands between a cirrus veil and grey
		// quadrilaterals, so every weather's every sprite is checked.
		for (const w of WEATHERS) {
			const pool = CLOUD_POOLS[w];
			const cirrus = CIRRUS_POOLS[w];
			const f = field(777, w);
			f.forEach((cluster, ci) => {
				const len = cluster.tier === 2 ? cirrus.length : pool.length;
				for (const s of cluster.sprites) {
					expect(s.texSlot, `${w} cluster ${ci}`).toBeLessThan(len);
				}
			});
		}
	});

	it('anchor sprites sit exactly at the cluster centre', () => {
		// The anchor is the guaranteed bright core; accumulation geometry
		// needs it centred, not merely nearby. sprites[0] is the anchor.
		const f = field(4242, 'cloudy');
		expect(f.length).toBeGreaterThan(0);
		for (const cluster of f) {
			const anchor = cluster.sprites[0];
			expect(anchor.ox).toBe(cluster.cx);
			expect(anchor.oy).toBe(cluster.ch);
			expect(anchor.oz).toBe(cluster.cz);
		}
	});
});
