import { describe, it, expect } from 'vitest';
import {
	capPolygons,
	circleRing,
	destPoint,
	NIGHT_BANDS,
	nightOverlay,
	splitRing
} from '#lib/display/world/terminator.js';
import { antipodeOf, subSolarPoint } from '#lib/display/world/sun.js';

describe('destPoint', () => {
	it('walks the equator and the meridian correctly', () => {
		const e = destPoint({ lat: 0, lng: 0 }, 90, 90);
		expect(e.lat).toBeCloseTo(0, 9);
		expect(e.lng).toBeCloseTo(90, 9);
		const n = destPoint({ lat: 0, lng: 0 }, 0, 90);
		expect(n.lat).toBeCloseTo(90, 9);
	});

	it('never returns NaN, even through the poles', () => {
		for (const b of [0, 45, 90, 180, 270]) {
			const p = destPoint({ lat: 89.9, lng: 0 }, b, 5);
			expect(Number.isFinite(p.lat) && Number.isFinite(p.lng)).toBe(true);
		}
	});
});

describe('circleRing', () => {
	it('closes and holds its radius', () => {
		const ring = circleRing({ lat: 10, lng: 20 }, 30);
		expect(ring.length).toBe(73);
		const first = ring[0];
		const last = ring[ring.length - 1];
		expect(last.lat).toBeCloseTo(first.lat, 9);
		// Angular distance from the centre ≈ 30° for every vertex.
		for (const p of ring) {
			const dLat = ((p.lat - 10) * Math.PI) / 180;
			const dLng = ((p.lng - 20) * Math.PI) / 180;
			const approx = Math.sqrt(dLat * dLat + dLng * dLng) * (180 / Math.PI);
			expect(Math.abs(approx - 30)).toBeLessThan(6);
		}
	});
});

describe('splitRing', () => {
	it('leaves a non-crossing ring as exactly one part', () => {
		const parts = splitRing(circleRing({ lat: 10, lng: 20 }, 30));
		expect(parts.length).toBe(1);
		expect(parts[0].length).toBe(73);
	});

	it('cuts a crossing ring into in-range parts', () => {
		const parts = splitRing(circleRing({ lat: 0, lng: 170 }, 25));
		expect(parts.length).toBeGreaterThan(1);
		for (const part of parts) {
			expect(part.length).toBeGreaterThanOrEqual(4);
			for (const p of part) {
				expect(p.lng).toBeGreaterThanOrEqual(-180);
				expect(p.lng).toBeLessThanOrEqual(180);
			}
			// Closed.
			const first = part[0];
			const last = part[part.length - 1];
			expect(last).toEqual(first);
		}
	});
});

describe('nightOverlay', () => {
	/**
	 * The caps nest, so the feature opacities are INCREMENTAL: each is the
	 * extra alpha needed on top of everything outside it. The table's numbers
	 * are what a reader should be able to check, so check them -- composite the
	 * stack back up and require the band table, exactly.
	 */
	it('stacks incremental alphas that composite to the band table', () => {
		const noon = Date.UTC(2026, 5, 21, 12, 0, 0) / 1000;
		const fc = nightOverlay(noon);
		expect(fc.features.length).toBe(NIGHT_BANDS.length);
		let covered = 0;
		fc.features.forEach((f, i) => {
			expect(f.properties.band).toBe(i);
			covered = 1 - (1 - covered) * (1 - f.properties.opacity);
			expect(covered, `band ${i}`).toBeCloseTo(NIGHT_BANDS[i].opacity, 9);
			expect(f.geometry.coordinates.length).toBeGreaterThan(0);
			for (const poly of f.geometry.coordinates) {
				for (const ring of poly) {
					for (const [lng, lat] of ring) {
						expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
						expect(lng).toBeGreaterThanOrEqual(-180);
						expect(lng).toBeLessThanOrEqual(180);
						expect(Math.abs(lat)).toBeLessThanOrEqual(90);
					}
				}
			}
		});
	});

	it('centres the dark cap opposite the sun', () => {
		const t = Date.UTC(2026, 5, 21, 12, 0, 0) / 1000;
		const anti = antipodeOf(subSolarPoint(t));
		const fc = nightOverlay(t);
		const cap = fc.features[fc.features.length - 1];
		// Vertex-centroid latitude is NOT the invariant for a 72° cap (a
		// sphere circle's vertices bunch poleward) — angular distance from
		// the antisolar point is: every vertex sits on the 72° small circle,
		// EXCEPT the ones closing the ring over a pole or along the map edge,
		// which belong to the rendering, not to the geometry.
		const D2R = Math.PI / 180;
		const alat = anti.lat * D2R;
		const alng = anti.lng * D2R;
		let n = 0;
		for (const poly of cap.geometry.coordinates) {
			for (const [lng, lat] of poly[0]) {
				if (Math.abs(lat) === 90 || Math.abs(lng) === 180) continue;
				const phi = lat * D2R;
				const lam = lng * D2R;
				const cosd =
					Math.sin(alat) * Math.sin(phi) + Math.cos(alat) * Math.cos(phi) * Math.cos(lam - alng);
				const d = Math.acos(Math.max(-1, Math.min(1, cosd))) / D2R;
				expect(Math.abs(d - 72)).toBeLessThan(3);
				n++;
			}
		}
		expect(n).toBeGreaterThan(0);
	});

	/**
	 * The shape a cap takes depends only on the sun's declination, and all
	 * three occur in an ordinary year: a plain disk, a disk that winds around
	 * a pole (83% of the year at 90 deg), and a cap holding BOTH poles (the
	 * 96 deg cap, 17% of the year, around the equinoxes). None may produce a
	 * degenerate polygon.
	 */
	it('builds every band all year, in all three shapes', () => {
		// Aggregate, then assert: per-vertex expects here cost ~3M
		// assertions and timed the worker out under load. Same properties.
		let days = 0;
		let minBands = Infinity;
		let minRing = Infinity;
		let allFinite = true;
		for (let day = 0; day < 365; day += 1) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 41_000;
			const features = nightOverlay(t).features;
			if (features.length < minBands) minBands = features.length;
			for (const f of features) {
				if (f.geometry.coordinates.length < 1) minBands = -1;
				for (const poly of f.geometry.coordinates) {
					if (poly[0].length < minRing) minRing = poly[0].length;
					for (const [lng, lat] of poly[0]) {
						if (!Number.isFinite(lng) || !Number.isFinite(lat)) allFinite = false;
					}
				}
			}
			days++;
		}
		expect(days).toBe(365);
		expect(minBands).toBeGreaterThan(0);
		expect(minRing).toBeGreaterThanOrEqual(4);
		expect(allFinite).toBe(true);
	});
});

/**
 * Coverage, checked against the band table rather than against the shapes.
 *
 * Every structural test above asserts on the PIECES -- ring counts, split
 * counts, winding, closure. All of them passed while the bands were wrong for
 * most of every day, because they were exercised at antisolar longitude 0,
 * where a cap never reaches the antimeridian and splits into exactly one part.
 * Same trap as `composed-clock.test.ts` asserting the two suns agree at the
 * Himalayas: a thorough suite anchored at the one input where it is easy.
 *
 * This asks the only question a well-formed but wrong polygon cannot satisfy:
 * at a given point, is the drawn darkness the one the band table says? Angular
 * distance is computed independently, so a change to the geometry cannot drag
 * the expectation along with it.
 *
 * WHAT THIS DOES NOT PROVE. The caps nest and are composited by the renderer,
 * so the check below composites them itself, with the same
 * `1 - (1 - a)(1 - b)` a fill layer applies. That MapLibre actually composites
 * overlapping features in one layer is read out of `webgl/draw/draw_fill.ts`
 * -- the translucent pass uses a tile-clipping stencil and read-only depth,
 * with no per-feature dedup -- and is NOT verified here. The geometry half is.
 */
describe('the bands cover what the band table says', () => {
	/** Even-odd containment in lng/lat, matching how the fill is triangulated. */
	const inRing = (pt: [number, number], ring: number[][]): boolean => {
		let inside = false;
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
			const [xi, yi] = ring[i];
			const [xj, yj] = ring[j];
			if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
		return inside;
	};

	/** What the whole stack paints at a point, composited as the layer would. */
	const drawnWith = (
		features: ReturnType<typeof nightOverlay>['features'],
		pt: [number, number]
	): number => {
		let covered = 0;
		for (const f of features) {
			let hit = false;
			for (const poly of f.geometry.coordinates) {
				for (const ring of poly) if (inRing(pt, ring)) hit = !hit;
			}
			if (hit) covered = 1 - (1 - covered) * (1 - f.properties.opacity);
		}
		return covered;
	};

	/** Single-point convenience: builds the overlay for one instant. */
	const drawn = (pt: [number, number], wallSec: number): number =>
		drawnWith(nightOverlay(wallSec).features, pt);

	const angularDeg = (a: { lat: number; lng: number }, pt: [number, number]): number => {
		const d = Math.PI / 180;
		const c =
			Math.sin(a.lat * d) * Math.sin(pt[1] * d) +
			Math.cos(a.lat * d) * Math.cos(pt[1] * d) * Math.cos((a.lng - pt[0]) * d);
		return Math.acos(Math.min(1, Math.max(-1, c))) / d;
	};

	/** The table's own answer: the innermost cap that reaches this far out. */
	const expectedAt = (deg: number): number => {
		let out = 0;
		for (const b of NIGHT_BANDS) if (deg < b.outer) out = b.opacity;
		return out;
	};

	/**
	 * The assertion that needs no tolerance: a disc contains its own centre.
	 * This is what failed before the split fix, at every longitude where the
	 * cap straddled the antimeridian.
	 */
	it('the solid cap contains the antisolar point, at every longitude', () => {
		const solid = NIGHT_BANDS[NIGHT_BANDS.length - 1].opacity;
		for (let h = 0; h < 24; h++) {
			const t = 1_789_300_000 + h * 3600;
			const anti = antipodeOf(subSolarPoint(t));
			expect(
				drawn([anti.lng, anti.lat], t),
				`hour ${h}, antisolar lng ${anti.lng.toFixed(1)}`
			).toBeCloseTo(solid, 9);
		}
	});

	/**
	 * The pole is the case the old annulus geometry could not represent at all,
	 * and the one that leaked a flat 0.11 onto ground nowhere near it. Both
	 * poles, every hour: whatever the table says for that distance, and nothing
	 * else.
	 */
	it('paints the poles themselves correctly, all day', () => {
		for (let h = 0; h < 24; h++) {
			const t = 1_789_300_000 + h * 3600;
			const anti = antipodeOf(subSolarPoint(t));
			for (const lat of [89.99, -89.99]) {
				const deg = angularDeg(anti, [0, lat]);
				if (NIGHT_BANDS.some((b) => Math.abs(deg - b.outer) < 1.5)) continue;
				expect(drawn([0, lat], t), `hour ${h}, lat ${lat}`).toBeCloseTo(expectedAt(deg), 9);
			}
		}
	});

	it('draws the right darkness over every catalogue place, all day', () => {
		const PLACES: [string, number, number][] = [
			['hyderabad', 17.44, 78.38],
			['dallas', 32.78, -96.8],
			['denver', 39.86, -104.67],
			['dubai', 25.2, 55.27],
			['himalayas', 27.99, 86.93],
			['ocean', 21.31, -157.86]
		];
		// The overlay is built once per instant and shared across places:
		// rebuilding it per (place, minute) cost 500 constructions and
		// timed the worker out under load. Same instants, same points.
		for (let m = 0; m < 1440; m += 17) {
			const t = 1_789_300_000 + m * 60;
			const features = nightOverlay(t).features;
			const anti = antipodeOf(subSolarPoint(t));
			for (const [name, lat, lng] of PLACES) {
				const deg = angularDeg(anti, [lng, lat]);
				// A 5 deg chord legitimately disagrees with an exact angular
				// test within a degree or so of a band edge.
				if (NIGHT_BANDS.some((b) => Math.abs(deg - b.outer) < 1.5)) continue;
				expect(
					drawnWith(features, [lng, lat]),
					`${name} +${m}min, ${deg.toFixed(1)}deg from antisolar`
				).toBeCloseTo(expectedAt(deg), 9);
			}
		}
	});

	/**
	 * A year of equinox-to-solstice sweeps at a grid of points. The shape a cap
	 * takes changes with declination, so a suite pinned to one week proves only
	 * that week -- the bug this file exists for survived exactly that way.
	 */
	it('holds over a whole year, on a global grid', () => {
		// One overlay per day shared across the grid: per-point rebuilds
		// cost 5,500 constructions and timed the worker out under load.
		// Same days, same points, same tolerance.
		let worst = 0;
		let worstAt = '';
		let checked = 0;
		for (let day = 0; day < 365; day += 11) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 37_000;
			const features = nightOverlay(t).features;
			const anti = antipodeOf(subSolarPoint(t));
			for (let lat = -80; lat <= 80; lat += 20) {
				for (let lng = -170; lng <= 170; lng += 20) {
					const deg = angularDeg(anti, [lng, lat]);
					if (NIGHT_BANDS.some((b) => Math.abs(deg - b.outer) < 1.5)) continue;
					const got = drawnWith(features, [lng, lat]);
					const want = expectedAt(deg);
					const err = Math.abs(got - want);
					if (err > worst) {
						worst = err;
						worstAt = `day ${day}, ${lat},${lng} (${deg.toFixed(1)}deg out): got ${got}, want ${want}`;
					}
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(worst, worstAt).toBeLessThan(0.5e-9);
	});
});
