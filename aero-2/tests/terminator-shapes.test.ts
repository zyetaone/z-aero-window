import { describe, it, expect } from 'vitest';
import { NIGHT_BANDS, capPolygons, nightOverlay } from '#lib/display/world/terminator.js';
import { antipodeOf, subSolarPoint } from '#lib/display/world/sun.js';

/**
 * WHICH SHAPES THE CODE ACTUALLY REACHES.
 *
 * `capPolygons` dispatches on the sun's declination into three shapes: a plain
 * disk, a pole-winding region, and a cap holding BOTH poles. The other tests
 * in `terminator.test.ts` assert the drawn darkness, and they pass whatever
 * shape comes back — the right level for them, the wrong level for this one.
 *
 * The question here is whether all three arms are ever taken. A dead arm is
 * this repo's recurring failure in a different costume: `bothPolesCap` is the
 * most delicate geometry in the file, and if declination never puts the
 * antisolar point in range then none of it has ever run and none of it is
 * tested. Invariant 10 is that rule pointed at datasets — a producer with no
 * consumer — and this is the geometric equivalent.
 *
 * Antisolar latitude is the negation of the subsolar latitude, so a cap holds
 * both poles exactly when its radius exceeds `90 + |anti.lat|`. The bands run
 * 96..72, so only the 96 deg cap can, and only within about 16 days of an
 * equinox — the narrow window a `day += 11` stride steps over.
 */
const coversBothPoles = (anti: { lat: number }, radiusDeg: number) =>
	90 - anti.lat < radiusDeg && 90 + anti.lat < radiusDeg;

const winding = (anti: { lat: number }, radiusDeg: number): 1 | -1 | 0 => {
	const inNorth = 90 - anti.lat < radiusDeg;
	const inSouth = 90 + anti.lat < radiusDeg;
	if (inNorth === inSouth) return 0;
	return inNorth ? 1 : -1;
};

type Shape = 'bothPoles' | 'north' | 'south' | 'plain';

function shapeAt(anti: { lat: number }, radiusDeg: number): Shape {
	if (coversBothPoles(anti, radiusDeg)) return 'bothPoles';
	const w = winding(anti, radiusDeg);
	return w === 1 ? 'north' : w === -1 ? 'south' : 'plain';
}

/** The widest band, by radius — the list is ordered by DARKNESS, not by size. */
const WIDEST = NIGHT_BANDS.reduce((a, b) => (b.outer > a.outer ? b : a));

describe('capPolygons shape dispatch', () => {
	it('reaches all three arms across a year of daily instants', () => {
		const seen = new Set<Shape>();
		for (let day = 0; day < 365; day++) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 41_000;
			const anti = antipodeOf(subSolarPoint(t));
			for (const band of NIGHT_BANDS) seen.add(shapeAt(anti, band.outer));
		}
		// Both poles, and both pole-winding directions, or a whole arm of the
		// geometry is unreachable and therefore untested.
		expect([...seen].sort()).toEqual(['bothPoles', 'north', 'plain', 'south']);
	});

	it('reaches the both-poles arm only on the widest band', () => {
		const perBand = new Map<number, Set<Shape>>();
		for (let day = 0; day < 365; day++) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 41_000;
			const anti = antipodeOf(subSolarPoint(t));
			for (const band of NIGHT_BANDS) {
				if (!perBand.has(band.outer)) perBand.set(band.outer, new Set());
				perBand.get(band.outer)!.add(shapeAt(anti, band.outer));
			}
		}
		for (const [radius, shapes] of perBand) {
			if (shapes.has('bothPoles')) {
				expect(radius, 'only the widest band can hold both poles').toBe(WIDEST.outer);
			}
		}
		expect([...perBand.values()].some((s) => s.has('bothPoles'))).toBe(true);
	});

	it('builds two abutting closed pieces on the both-poles arm', () => {
		/**
		 * Reachability is not correctness. The both-poles arm returns TWO
		 * polygons — the complement cut along the disk's extreme longitudes —
		 * and they must abut. Sharing the link is what stops a gap showing
		 * through and an overlap double-darkening, and that is checkable here
		 * without a renderer because each piece is the unique cap holding one
		 * pole.
		 */
		let checked = 0;
		for (let day = 0; day < 365 && checked < 8; day++) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 41_000;
			const anti = antipodeOf(subSolarPoint(t));
			if (!coversBothPoles(anti, WIDEST.outer)) continue;
			checked++;
			const polys = capPolygons(anti, WIDEST.outer);
			expect(polys.length, 'a both-poles cap is two pieces').toBe(2);
			for (const poly of polys) {
				expect(poly.length).toBe(1);
				const ring = poly[0];
				expect(ring.length).toBeGreaterThanOrEqual(4);
				for (const [lng, lat] of ring) {
					expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
					expect(Math.abs(lng)).toBeLessThanOrEqual(180);
					expect(Math.abs(lat)).toBeLessThanOrEqual(90);
				}
				expect(ring[0], 'ring must close').toEqual(ring[ring.length - 1]);
			}
			// One piece holds the north pole and one the south, so they are
			// never the same ring.
			expect(polys[0][0]).not.toEqual(polys[1][0]);
		}
		expect(checked, 'no day in the year took the both-poles arm').toBeGreaterThan(0);
	});

	it('never cuts an edge across the map between two real points', () => {
		/**
		 * The failure mode is a band drawn across the whole world: a ring whose
		 * longitudes jump far between consecutive vertices, which triangulates
		 * as a horizontal chord.
		 *
		 * A 360 deg jump BETWEEN POLE VERTICES IS NOT THAT CASE, and asserting
		 * it is was a mistake worth recording. `poleCapRing` closes a
		 * pole-winding region through `[{90, 180}, {90, -180}]` — and at a pole
		 * longitude is undefined, so those are the SAME point wearing two
		 * representations. The segment has zero length on the sphere and lies at
		 * lat 90, which Web Mercator clamps away entirely. The other tests in
		 * this file already skip pole and edge vertices for the same reason.
		 *
		 * So the invariant is about jumps between points that are DISTINCT, and
		 * the step is ~5 deg, so anything near 360 is a seam.
		 */
		let worst = 0;
		let worstAt = '';
		for (let day = 0; day < 365; day += 3) {
			const t = Date.UTC(2026, 0, 1) / 1000 + day * 86_400 + 41_000;
			nightOverlay(t).features.forEach((f, bi) => {
				for (const poly of f.geometry.coordinates) {
					for (const ring of poly) {
						for (let i = 1; i < ring.length; i++) {
							const [lngA, latA] = ring[i - 1];
							const [lngB, latB] = ring[i];
							// Same point, two representations: the pole singularity.
							const samePoint =
								latA === latB && Math.abs(latA) === 90 && Math.abs(lngA - lngB) === 360;
							if (samePoint) continue;
							const jump = Math.abs(lngB - lngA);
							if (jump > worst) {
								worst = jump;
								worstAt = `day ${day} band ${bi}(r=${NIGHT_BANDS[bi].outer}): [${lngA},${latA}] -> [${lngB},${latB}]`;
							}
						}
					}
				}
			});
		}
		expect(worst, worstAt).toBeLessThan(90);
	});
});
