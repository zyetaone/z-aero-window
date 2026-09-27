/**
 * The vector night road grid — the ODbL replacement for the CartoDB raster.
 *
 * The GL is untestable here, so these cover what is easy to get wrong and
 * impossible to see in a diff: the ground offset, class handling, and the
 * altitude behaviour that decides whether cruise reads as a grid or as haze.
 *
 * The night CURVE itself is NOT retested here — roadMaskAlpha lives in
 * imagery.ts and keeps its own coverage; the point of this layer is that it
 * reuses that function rather than growing a second one.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import {
	polylinesFromGeojson,
	roadClassAlpha,
	roadLampIndex,
	roadFlicker,
	roadBinPhase,
	roadViirsScaleForPolyline,
	roadViirsSamplePoint,
	ROAD_CLASSES,
	ROAD_LAMPS,
} from '$lib/world/roads-geojson';
import { groundAltM } from '$content/locations';
import { roadMaskAlpha } from '$lib/world/imagery';

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const road = (cls?: unknown, coords?: unknown) => ({
	type: 'Feature',
	properties: cls === undefined ? {} : { class: cls },
	geometry: {
		type: 'LineString',
		coordinates: coords ?? [[78.48, 17.38], [78.49, 17.39]],
	},
});

describe('roads sit on the ground, not the ellipsoid', () => {
	it('lifts every line to the city ground altitude', () => {
		// Same silent failure as buildings: at sea level Denver's grid is ~1600 m
		// inside the mountain and the city reads as having no roads at all,
		// which is indistinguishable from "the layer failed to load".
		const [r] = polylinesFromGeojson(fc([road('primary')]), 'denver');
		expect(r.altM).toBeGreaterThan(groundAltM('denver'));
		expect(r.altM).toBeLessThan(groundAltM('denver') + 50);
	});

	it('puts a high-altitude city above a low one', () => {
		const [den] = polylinesFromGeojson(fc([road()]), 'denver');
		const [dub] = polylinesFromGeojson(fc([road()]), 'dubai');
		expect(den.altM).toBeGreaterThan(dub.altM);
	});

	it('scales the ground by vertical exaggeration so roads track terrain', () => {
		// verticalExaggeration stretches TERRAIN but not primitives, so an
		// unscaled altitude leaves the grid floating above or buried under the
		// ground it is painted on.
		const [flat] = polylinesFromGeojson(fc([road()]), 'denver', 1);
		const [tall] = polylinesFromGeojson(fc([road()]), 'denver', 2);
		expect(tall.altM - flat.altM).toBeCloseTo(groundAltM('denver'));
	});

	it('lifts clear of the terrain rather than sitting exactly on it', () => {
		// A line at exactly terrain height z-fights into a dashed shimmer.
		const [r] = polylinesFromGeojson(fc([road()]), 'dubai');
		expect(r.altM).toBeGreaterThan(groundAltM('dubai'));
	});
});

describe('class handling is total', () => {
	it('keeps every class the packager emits', () => {
		for (const cls of ROAD_CLASSES) {
			const [r] = polylinesFromGeojson(fc([road(cls)]), 'dubai');
			expect(r?.cls, cls).toBe(cls);
		}
	});

	it('styles an unknown or missing class instead of dropping the road', () => {
		// A road tagged in a way we did not anticipate should still light up,
		// quietly. Dropping it would silently thin the grid as OSM tagging drifts.
		for (const bad of [undefined, 'unclassified', 42, null, '']) {
			const out = polylinesFromGeojson(fc([road(bad)]), 'dubai');
			expect(out, String(bad)).toHaveLength(1);
			expect(out[0].cls, String(bad)).toBe('residential');
		}
	});
});

describe('malformed features degrade instead of blanking the grid', () => {
	it('drops repeated vertices rather than collapsing the line to nothing', () => {
		// PolylineGeometry removes duplicates itself and returns UNDEFINED when
		// fewer than two survive — which surfaces as a missing road, not an error.
		const dup = road('primary', [[78.48, 17.38], [78.48, 17.38], [78.49, 17.39]]);
		const [r] = polylinesFromGeojson(fc([dup]), 'dubai');
		expect(r.coords).toEqual([78.48, 17.38, 78.49, 17.39]);
	});

	it('skips a line whose vertices are all the same point', () => {
		const degenerate = road('primary', [[78.48, 17.38], [78.48, 17.38]]);
		expect(polylinesFromGeojson(fc([degenerate]), 'dubai')).toHaveLength(0);
	});

	it('skips out-of-range coordinates rather than wrapping the globe', () => {
		const bogus = road('primary', [[999, 2], [3, 400]]);
		expect(polylinesFromGeojson(fc([bogus]), 'dubai')).toHaveLength(0);
	});

	it('ignores non-LineString geometry', () => {
		const poly = {
			type: 'Feature',
			properties: { class: 'primary' },
			geometry: { type: 'Polygon', coordinates: [[[1, 2], [3, 4], [5, 6]]] },
		};
		expect(polylinesFromGeojson(fc([poly]), 'dubai')).toHaveLength(0);
	});

	it('returns empty for junk input rather than throwing into the render loop', () => {
		for (const junk of [null, undefined, {}, { features: 'nope' }, 42]) {
			expect(polylinesFromGeojson(junk, 'dubai')).toEqual([]);
		}
	});
});

describe('per-class alpha keeps the grid legible at cruise', () => {
	const CRUISE = 34_000;

	it('never exceeds the curve it is scaling', () => {
		for (const cls of ROAD_CLASSES) {
			for (const alt of [1_000, 5_000, 28_000, CRUISE]) {
				const a = roadClassAlpha(cls, 1, alt);
				expect(a, `${cls}@${alt}`).toBeLessThanOrEqual(1);
				expect(a, `${cls}@${alt}`).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('keeps arteries brighter than side streets', () => {
		// The whole reason for per-class primitives. Flat weighting reads as a
		// uniform grey mesh with no city structure in it.
		expect(roadClassAlpha('motorway', 1, 28_000)).toBeGreaterThan(
			roadClassAlpha('residential', 1, 28_000),
		);
	});

	it('fades residential with altitude, and only residential', () => {
		// Residential is ~80% of the features (2,749 of Hyderabad's 3,447).
		// Polyline width is CONSTANT SCREEN SPACE, so unlike the raster it
		// replaced, these do not attenuate on their own — at cruise they alias
		// into a haze that buries the arteries.
		expect(roadClassAlpha('residential', 1, CRUISE)).toBeLessThan(
			roadClassAlpha('residential', 1, 5_000),
		);
		expect(roadClassAlpha('motorway', 1, CRUISE)).toBeCloseTo(
			roadClassAlpha('motorway', 1, 5_000),
		);
	});

	it('goes fully dark when the night curve does', () => {
		for (const cls of ROAD_CLASSES) expect(roadClassAlpha(cls, 0, 28_000)).toBe(0);
	});
});

describe('the road cache does not outlive its viewer', () => {
	it('reports nothing loaded after a reset', async () => {
		const { hasOfflineRoads, resetOfflineRoads } = await import('$lib/world/roads-geojson');
		resetOfflineRoads();
		expect(hasOfflineRoads('denver')).toBe(false);
	});

	it('is reached by the teardown contract, not merely available', async () => {
		// Fifth occurrence of this bug class in this repo. Exporting the reset is
		// useless if the lifecycle never calls it, so the registration is what
		// gets pinned — and initRoads must clear on remount too.
		const { readFile } = await import('node:fs/promises');
		const src = await readFile('src/lib/world/roads-geojson.ts', 'utf8');
		expect(src).toContain("registerViewerTeardown('roads-geojson', resetOfflineRoads)");
		const init = src.slice(src.indexOf('export function initRoads'));
		expect(init.slice(0, init.indexOf('\n}'))).toContain('resetOfflineRoads()');
	});
});

/**
 * `data/roads` is tracked as of the CARTO removal — ~48 MB of ODbL centrelines
 * (per-class Overpass radii; arterials to 40 km), and now the ONLY source for
 * the night street grid. Same reasoning as data/buildings: git pull is the
 * deploy mechanism, so an ignored path is one the fleet can never receive.
 *
 * The guard stays anyway. It costs one syscall and keeps the file honest on a
 * checkout where the exception has been reverted, rather than failing with
 * ENOENT — which is exactly how the buildings version took main red.
 *
 * The skip announces itself. A silently-skipped test reads as a passing one.
 */
const packagedData = existsSync('data/roads');
if (!packagedData) {
	console.info('[roads-geojson] data/roads absent — packaged-data checks skipped');
}

describe.runIf(packagedData)('every city that should have a street grid has one packaged', () => {
	it('covers each hasBuildings location in the catalogue', async () => {
		// hasBuildings doubles as "is a city": the eight locations with a skyline
		// are exactly the eight with a road extract. ponytail: no second
		// catalogue flag for a set that is identical — add hasRoads only if a
		// location ever needs one without the other.
		const { LOCATIONS } = await import('$content/locations');
		const missing = LOCATIONS
			.filter((l) => l.hasBuildings)
			.map((l) => l.id)
			.filter((id) => !existsSync(`data/roads/${id}.geojson`));
		expect(
			missing,
			`catalogue cities with no packaged road extract: ${missing.join(', ')}. `
				+ 'Run tools/tile-packager for the new city, or set hasBuildings:false.',
		).toEqual([]);
	});

	it('ships no extract that no location asks for', async () => {
		// These files are in git now, so dead weight is permanent weight.
		const { LOCATIONS } = await import('$content/locations');
		const wanted = new Set(LOCATIONS.filter((l) => l.hasBuildings).map((l) => l.id));
		const stray = readdirSync('data/roads')
			.filter((f) => f.endsWith('.geojson'))
			.map((f) => f.replace(/\.geojson$/, ''))
			.filter((id) => !wanted.has(id as never));
		expect(stray, `packaged extracts no catalogue location uses: ${stray.join(', ')}`).toEqual([]);
	});
});

describe.runIf(packagedData)('the packaged data this layer depends on is real', () => {
	it('parses the shipped city files into usable polylines', async () => {
		// Guards the layer end-to-end short of the GPU: if the packager output
		// ever changes shape, this fails here rather than as a dark city on a Pi.
		const { readFile } = await import('node:fs/promises');
		for (const city of ['hyderabad', 'dubai', 'denver'] as const) {
			const raw = JSON.parse(await readFile(`data/roads/${city}.geojson`, 'utf8'));
			const out = polylinesFromGeojson(raw, city);
			expect(out.length, city).toBeGreaterThan(0);
			expect(out.every((r) => r.coords.length >= 4), city).toBe(true);
			expect(out.every((r) => r.altM > 0), city).toBe(true);
			// The arteries are what carry the city; an extract of nothing but
			// residential lanes means the packager filter regressed.
			expect(out.some((r) => r.cls !== 'residential'), city).toBe(true);
		}
	});
});

describe('lamp colour is varied but fleet-deterministic', () => {
	// THE fleet requirement. Three Pis render three slices of ONE window; a
	// colour rolled with Math.random() makes the same street orange on the left
	// screen and blue in the middle. Same class of bug as the ambient-jitter
	// desync, which shipped and was visible on the wall.
	it('gives the same road the same lamp every time it is asked', () => {
		const coords = [78.4812, 17.3841, 78.4899, 17.3902];
		const first = roadLampIndex(coords);
		for (let i = 0; i < 50; i++) expect(roadLampIndex(coords)).toBe(first);
	});

	it('depends only on the coordinates, not on call order or insertion', () => {
		// A counter- or index-based assignment would pass the test above and
		// still desync, because the three Pis do not load features in lockstep.
		const a = [78.4812, 17.3841, 78.49, 17.39];
		const b = [78.5001, 17.4102, 78.51, 17.42];
		const forward = [roadLampIndex(a), roadLampIndex(b)];
		const backward = [roadLampIndex(b), roadLampIndex(a)].reverse();
		expect(forward).toEqual(backward);
	});

	it('always returns a real lamp', () => {
		for (let i = 0; i < 2000; i++) {
			const idx = roadLampIndex([78 + i * 0.0013, 17 + i * 0.0007]);
			expect(Number.isInteger(idx)).toBe(true);
			expect(ROAD_LAMPS[idx]).toBeDefined();
		}
	});

	it('actually spreads across the palette instead of collapsing to one bin', () => {
		// A hash that degenerates would silently undo the whole point: one
		// colour everywhere, which is what the flat #ffd9a0 looked like.
		const seen = new Set<number>();
		for (let i = 0; i < 2000; i++) seen.add(roadLampIndex([78 + i * 0.0013, 17 + i * 0.0007]));
		expect(seen.size).toBeGreaterThan(1);
	});

	it('keeps sodium the majority and LED the minority', () => {
		// Real cities are mostly sodium/warm with an LED minority. An even split
		// reads as a colour test card, not a city.
		const counts = [0, 0, 0];
		for (let i = 0; i < 3000; i++) counts[roadLampIndex([78 + i * 0.0013, 17 + i * 0.0007])]++;
		expect(counts[0]).toBeGreaterThan(counts[2]);
	});
});

describe('roadViirsScaleForPolyline — VIIRS gates lamp brightness', () => {
	const coords = [78.48, 17.38, 78.49, 17.39];
	const field = {
		sample: () => 0,
		sampleBilinear: () => 0,
	};
	const brightField = {
		sample: () => 1,
		sampleBilinear: () => 1,
	};

	it('dims lamps in dark VIIRS cells but keeps a floor', () => {
		const dark = roadViirsScaleForPolyline(coords, field);
		expect(dark).toBeGreaterThanOrEqual(0.15);
		expect(dark).toBeLessThan(0.25);
	});

	it('brightens lamps over lit cores', () => {
		expect(roadViirsScaleForPolyline(coords, brightField)).toBeGreaterThan(
			roadViirsScaleForPolyline(coords, field),
		);
	});

	it('uses a mid fallback when the field is not ready', () => {
		const fallback = roadViirsScaleForPolyline(coords, null);
		expect(fallback).toBeGreaterThan(0.15);
		expect(fallback).toBeLessThan(1);
	});

	it('samples VIIRS at the polyline midpoint, not an endpoint', () => {
		// Dark at start, bright at end — midpoint should read bright.
		const long = [78.48, 17.38, 78.49, 17.39, 78.50, 17.40];
		expect(roadViirsSamplePoint(long)).toEqual({ lon: 78.49, lat: 17.39 });
		const gradient = {
			sample: () => 0,
			sampleBilinear: (lat: number, lon: number) =>
				lon === 78.48 && lat === 17.38 ? 0 : 1,
		};
		expect(roadViirsScaleForPolyline(long, gradient)).toBeGreaterThan(0.5);
		expect(roadViirsScaleForPolyline([78.48, 17.38], gradient)).toBeLessThan(0.25);
	});
});

describe('cityRoadsAwaitingViirs', () => {
	it('tracks cities that loaded before VIIRS was ready', async () => {
		const { cityRoadsAwaitingViirs, resetOfflineRoads } = await import('$lib/world/roads-geojson');
		resetOfflineRoads();
		// Seeded by loadOfflineRoads when field is null — export is the seam.
		expect(cityRoadsAwaitingViirs('dubai')).toBe(false);
	});
});

describe('flicker breathes without reading as a rendering bug', () => {
	it('stays within a few percent of unity', () => {
		for (let phase = 0; phase < 18; phase++) {
			for (let t = 1_700_000_000; t < 1_700_000_600; t += 0.37) {
				const f = roadFlicker(phase, t);
				expect(f).toBeGreaterThan(0.9);
				expect(f).toBeLessThan(1.1);
			}
		}
	});

	it('is a pure function of the SYNCED clock, so all three Pis agree', () => {
		// A local dt accumulator would pass "it varies" and still drift the wall
		// apart within minutes. Same input must give the same output, always.
		for (const t of [0, 1_700_000_000, 1_700_000_000.25, 1_759_000_000]) {
			expect(roadFlicker(3, t)).toBe(roadFlicker(3, t));
		}
	});

	it('gives a bin the same phase regardless of load order', () => {
		// THE order-dependence bug: phase was the bin's insertion index, so any
		// difference in parse order between the three Pis gave the same bin a
		// different phase and the wall breathed out of step. Identity-derived
		// phase is immune, and this is what proves it.
		const pairs: Array<[typeof ROAD_CLASSES[number], number]> = [
			['motorway', 0], ['residential', 2], ['tertiary', 1],
		];
		const forward = pairs.map(([c, l]) => roadBinPhase(c, l));
		const shuffled = [...pairs].reverse().map(([c, l]) => roadBinPhase(c, l)).reverse();
		expect(forward).toEqual(shuffled);
	});

	it('gives every distinct bin a distinct phase', () => {
		const seen = new Set<number>();
		for (const c of ROAD_CLASSES) {
			for (let l = 0; l < ROAD_LAMPS.length; l++) seen.add(roadBinPhase(c, l));
		}
		expect(seen.size).toBe(ROAD_CLASSES.length * ROAD_LAMPS.length);
	});

	it('does not put every bin in lockstep', () => {
		// Bins breathing together is just a global brightness wobble, which
		// reads as the whole layer pulsing rather than as lamps varying.
		const t = 1_700_000_022.4;
		const vals = Array.from({ length: 8 }, (_, p) => roadFlicker(p, t));
		expect(new Set(vals.map((v) => v.toFixed(4))).size).toBeGreaterThan(4);
	});

	it('actually varies over time', () => {
		// One frame apart at 60 Hz must already differ — the old hours-based
		// input only moved once a minute, so the lamps froze between ticks.
		const vals = Array.from({ length: 40 }, (_, i) => roadFlicker(1, 1_700_000_000 + i / 60));
		expect(new Set(vals.map((v) => v.toFixed(4))).size).toBeGreaterThan(3);
	});
});

describe('the grid survives the night-show altitude band', () => {
	// THE regression this section exists for, caught in a real-GPU frame:
	// roadMaskAlpha was calibrated for a raster imagery layer. nightLightGain
	// caps it at 0.40 at the default scale and altitude drags it to 0.267 by
	// 30,000 ft. On a raster that still reads; on a glow polyline it vanished
	// completely, leaving only building blobs — the exact failure this whole
	// layer exists to prevent.
	//
	// These assert the OUTPUT is visible, not that some constant equals 2.6, so
	// the mask, the gain and the class weights can all be retuned freely as
	// long as the city still reads at cruise.
	const NIGHT_BAND = [28_000, 30_000, 32_000, 34_000];
	const SCALE = 2.0; // the shipped default

	it('keeps arteries clearly visible at every night-band altitude', () => {
		// 0.2 is not arbitrary: below roughly this the glow stroke stops reading
		// against the graded ground. Verified in real-GPU frames over Hyderabad
		// at 30,000 ft — the shipped curve lands motorways at ~0.27 here and the
		// city is legible. A change that drops these below 0.2 is a regression
		// even if every other test still passes.
		for (const alt of NIGHT_BAND) {
			const base = roadMaskAlpha(1, SCALE, alt);
			expect(roadClassAlpha('motorway', base, alt), `motorway@${alt}`).toBeGreaterThan(0.2);
		}
	});

	it('still lets side streets fill in on approach', () => {
		// The other half of the contract: low and slow should show the full grid,
		// not just the arteries.
		const low = roadMaskAlpha(1, SCALE, 4_000);
		const cruise = roadMaskAlpha(1, SCALE, 34_000);
		expect(roadClassAlpha('residential', low, 4_000)).toBeGreaterThan(
			roadClassAlpha('residential', cruise, 34_000) * 8,
		);
	});

	it('fades side streets out by cruise so they cannot alias into haze', () => {
		const high = roadMaskAlpha(1, SCALE, 34_000);
		expect(roadClassAlpha('residential', high, 34_000)).toBeLessThan(0.1);
	});

	it('keeps the class hierarchy intact at the night band', () => {
		const base = roadMaskAlpha(1, SCALE, 30_000);
		const a = ROAD_CLASSES.map((c) => roadClassAlpha(c, base, 30_000));
		for (let i = 1; i < a.length; i++) {
			expect(a[i], `${ROAD_CLASSES[i]} vs ${ROAD_CLASSES[i - 1]}`).toBeLessThanOrEqual(a[i - 1]);
		}
	});

	it('never drives any class past opaque, at any knob position', () => {
		// nightLightScale is an operator-facing slider that has historically been
		// left at 4.6-6.8, so the clamp is load-bearing rather than defensive.
		for (const scale of [0.5, 1, 2, 3.5, 5, 6.8]) {
			for (const alt of [1_000, 4_000, 15_000, 30_000, 40_000]) {
				const base = roadMaskAlpha(1, scale, alt);
				for (const c of ROAD_CLASSES) {
					const v = roadClassAlpha(c, base, alt);
					expect(v, `${c}@${alt}/${scale}`).toBeLessThanOrEqual(1);
					expect(v, `${c}@${alt}/${scale}`).toBeGreaterThanOrEqual(0);
				}
			}
		}
	});
});
