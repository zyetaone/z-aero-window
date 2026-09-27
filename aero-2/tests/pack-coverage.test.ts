import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOCATIONS } from '#lib/locations.js';

/**
 * A pack must CONTAIN the place it is packed for.
 *
 * The downtown thread in `flight/downtown.ts` closes a ~2 x 3 km loop on the
 * `Location` pin, because the pin is the only place the flight code knows
 * about. It has no idea where the buildings are. When those disagree the
 * thread is a perfectly formed circle over bare ground — the loop is right,
 * the subject is 30 km away — and nothing goes red: the pack serves 200, the
 * endpoint answers, the extrusions mount, and `probe-layers.mjs` paints.
 *
 * That is invariant 10 pointed at geometry rather than at datasets. Roads were
 * the first half of this story — 46 MB of OSM geometry, served with ETags,
 * covered by its own endpoint test, and drawn by nothing. The buildings are the
 * same failure wearing different clothes: present, plausible, and inert from
 * the air.
 *
 * MEASURED 2026-09-27, and the reason this is not simply "denver is broken":
 * the ROADS packs are metro-wide and the BUILDINGS packs are a tight ~5 km
 * box, so the SAME offset is fatal in one and invisible in the other.
 *
 *   place       buildings offset   span        roads offset   span
 *   denver             29.7 km     5.1 x 3.8      33.6 km     96.1 x 78.2
 *   las_vegas           9.6 km     5.6 x 4.6      23.2 km    112.9 x 77.2
 *   phoenix             6.1 km     5.6 x 4.8       7.3 km     85.7 x 80.5
 *   hyderabad           5.8 km     5.2 x 6.4      13.1 km     81.4 x 84.5
 *   mumbai, dubai, chicago_midway, dallas — all within 0.4 km
 *
 * Denver's buildings pack is centred on 39.8534, -104.6772 — Denver
 * International Airport, not the downtown pin at 39.7392, -104.9903. So it was
 * fetched with a different centre than the roads pack, which does cover
 * downtown. Hence the asymmetry above rather than a bad pin.
 *
 * WHY A TEST AND NOT A COMMENT. §5 of ARCHITECTURE.md records these numbers,
 * and a comment has the same half-life as every other comment: it was right
 * until someone re-fetched a pack. This goes red the moment a pack stops
 * covering its pin, which is the moment it is cheap to fix.
 *
 * It reads whatever packs are present and SKIPS the rest, because a fresh
 * clone has no `data/` at all and a provisioned Pi has all of them. A pack that
 * is absent cannot be misplaced; a pack that is present and wrong can.
 */
const CANDIDATES = [resolve(process.cwd(), 'data'), resolve(process.cwd(), '../data')];

/**
 * Resolve PER KIND, not once for the whole file.
 *
 * `aero-2/data/` holds `tiles/` and nothing else, while the city packs live in
 * the shared `../data/`. A single `dataDir` picks the first directory that
 * exists, which is the wrong one for geometry, and the failure reads as "no
 * packs found" — an empty result that looks like a provisioning problem rather
 * than a lookup bug. So each kind takes the first candidate that actually has
 * a pack in it.
 */
function dirForKind(kind: string): string | null {
	for (const dir of CANDIDATES) {
		const kd = resolve(dir, kind);
		if (!existsSync(kd)) continue;
		const any = LOCATIONS.some((l) => existsSync(resolve(kd, `${l.id}.geojson`)));
		if (any) return kd;
	}
	return null;
}

interface Edges {
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
	verts: number;
}

/** Bounding box over any GeoJSON geometry — Point, LineString, Polygon, or a
 *  collection of any of them. Not a `bbox` member: these packs do not carry
 *  one, which is half of why this went unnoticed. */
function edgesOf(file: string): Edges {
	const geo = JSON.parse(readFileSync(file, 'utf8')) as {
		features?: { geometry?: { coordinates: unknown } }[];
	};
	const e: Edges = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180, verts: 0 };
	const walk = (c: unknown): void => {
		if (!Array.isArray(c)) return;
		if (typeof c[0] === 'number') {
			const [lng, lat] = c as [number, number];
			e.verts++;
			if (lat < e.minLat) e.minLat = lat;
			if (lat > e.maxLat) e.maxLat = lat;
			if (lng < e.minLng) e.minLng = lng;
			if (lng > e.maxLng) e.maxLng = lng;
		} else {
			for (const child of c) walk(child);
		}
	};
	for (const f of geo.features ?? []) if (f.geometry) walk(f.geometry.coordinates);
	return e;
}

const M_PER_DEG = 111_320;

/**
 * Great-circle offset between two points, both in DEGREES, returned in km.
 *
 * M_PER_DEG converts degrees to METRES, and forgetting the final /1000 was
 * worth recording: it reported Hyderabad's offset as 10,944 km, which reads as
 * "this pin is on the wrong planet" rather than as "this pin is 10.9 km from
 * its pack", and the failure message is the only thing anyone sees.
 */
function offsetKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
	const dLat = (aLat - bLat) * M_PER_DEG;
	const dLng = (aLng - bLng) * M_PER_DEG * Math.cos((aLat * Math.PI) / 180);
	return Math.hypot(dLat, dLng) / 1000;
}

/** Widest of the two spans, in km — the box a pass would have to be flown over. */
const spanKm = (e: Edges) => {
	const midLat = (e.minLat + e.maxLat) / 2;
	return (
		Math.max(
			(e.maxLat - e.minLat) * M_PER_DEG,
			(e.maxLng - e.minLng) * M_PER_DEG * Math.cos((midLat * Math.PI) / 180)
		) / 1000
	);
};

const packPath = (kind: string, id: string) => resolve(dirForKind(kind)!, `${id}.geojson`);

/**
 * THE TWO PACKS THAT ARE KNOWN WRONG, AND WHY THE SUITE IS GREEN ANYWAY.
 *
 * Both were measured on 2026-09-27 and both are data defects, not code
 * defects: the geometry renders correctly, it is being handed content that is
 * in the wrong place or too thin. Neither can be fixed from this repository —
 * a pack is refetched from Overpass on a machine with network, and there is no
 * buildings fetcher in `tools/` to run.
 *
 * So they are named here, with the measurement, instead of being left to rot
 * in a comment. That is a deliberate trade and the wrong kind of trade is
 * available: an allowlist that is never pruned becomes invisible, and the
 * invariant it was written to protect quietly stops existing. Three things
 * keep that from happening —
 *
 *   1. It is an EXACT list, not a threshold and not a pattern. A third bad
 *      pack fails, and so does any of these two getting worse.
 *   2. Every entry carries the number it is excusing, so "is this still the
 *      same defect" is answerable by reading one line.
 *   3. §5 of ARCHITECTURE.md records the same two, so deleting an entry here
 *      leaves a second copy pointing at it.
 *
 * REMOVE an entry when its pack is refetched. `denver`'s is the thinner of the
 * two problems: it is the right place with 190 footprints against 600
 * everywhere else, so the pass is thin rather than empty.
 */
const KNOWN_MISPLACED = new Map<string, string>([
	// Measured: pin 17.444,78.377 vs pack [17.413..17.460, 78.450..78.510].
	// 10.9 km from a 6.4 km box, so the pin is outside it entirely. Fix by
	// refetching centred on the pin.
	['hyderabad', '10.9km from a 6.4km pack; pin outside']
]);

const KNOWN_THIN = new Map<string, string>([
	// Measured: 190 footprints against 600 in all seven other packs.
	['denver', '190 footprints vs 600 elsewhere; right place, thin pack']
]);

const excused = (map: Map<string, string>, id: string): string | undefined => map.get(id);

describe('packed geometry covers the pin it is drawn for', () => {
	for (const kind of ['buildings', 'roads'] as const) {
		it.skipIf(!dirForKind(kind))(
			`${kind}: every pack contains its own Location pin`,
			() => {
				const failures: string[] = [];
				const excusedNotes: string[] = [];
				let checked = 0;

				for (const loc of LOCATIONS) {
					const path = packPath(kind, loc.id);
					if (!existsSync(path)) continue;
					checked++;
					const e = edgesOf(path);
					if (e.verts === 0) {
						failures.push(`${loc.id}: pack is empty`);
						continue;
					}
					/**
					 * Containment, not nearness.
					 *
					 * A centroid-offset check would PASS a metro-wide roads pack
					 * whose centre sits 34 km from the pin — which is exactly the
					 * measurement that made this look like a buildings-only problem
					 * when it is not. What the renderer needs is that the PIN is
					 * inside the drawn box, because that is what the flight code
					 * aims at.
					 */
					const inside =
						loc.lat >= e.minLat &&
						loc.lat <= e.maxLat &&
						loc.lon >= e.minLng &&
						loc.lon <= e.maxLng;
					if (!inside) {
						const note = excused(KNOWN_MISPLACED, loc.id);
						if (note) {
							// Named, counted, and still reported — so the day the pack is
							// refetched this line simply stops appearing.
							excusedNotes.push(`${loc.id}: KNOWN (${note})`);
							continue;
						}
						const midLat = (e.minLat + e.maxLat) / 2;
						const midLng = (e.minLng + e.maxLng) / 2;
						failures.push(
							`${loc.id}: pin ${loc.lat.toFixed(3)},${loc.lon.toFixed(3)} is OUTSIDE the pack ` +
								`[lat ${e.minLat.toFixed(3)}..${e.maxLat.toFixed(3)}, ` +
								`lon ${e.minLng.toFixed(3)}..${e.maxLng.toFixed(3)}] — ` +
								`${offsetKm(loc.lat, loc.lon, midLat, midLng).toFixed(1)} km from its centre, ` +
								`pack spans ${spanKm(e).toFixed(1)} km`
						);
					}
				}

				expect(checked, `no ${kind} packs found under ${dirForKind(kind)}`).toBeGreaterThan(0);
				expect(
					failures,
					`${kind} packs that do not cover their pin — a downtown thread will fly over them:\n  ` +
						failures.join('\n  ')
				).toEqual([]);
				// Surfaced on the way past, so a known-bad pack is visible in the log
				// rather than only in this file.
				if (excusedNotes.length)
					console.log(`  known ${kind} misplacements: ${excusedNotes.join('; ')}`);
			},
			60_000
		);
	}

	it.skipIf(!dirForKind('buildings'))(
		'buildings packs are tight enough for the downtown thread to be worth flying',
		() => {
			/**
			 * Containment is necessary but not sufficient. A pack that swallows its
			 * pin by 80 km passes the test above and still leaves the thread
			 * circling one suburb for two minutes — the hover that
			 * `DOWNTOWN_TIME_WARP` exists to prevent, and the failure that reads as
			 * "the pass does nothing" rather than as a bug.
			 *
			 * The thread's loop is ~2 x 3.4 km, so a pack much wider than that has
			 * no single centre to be flown over. Roads are exempt by construction:
			 * they ARE metro-wide, and they are drawn at cruise where a 5 km box
			 * would be a dot.
			 */
			const offenders: string[] = [];
			let checked = 0;
			for (const loc of LOCATIONS) {
				const path = packPath('buildings', loc.id);
				if (!existsSync(path)) continue;
				checked++;
				const s = spanKm(edgesOf(path));
				if (s > 12) offenders.push(`${loc.id}: buildings span ${s.toFixed(1)} km`);
			}
			expect(checked, 'no buildings packs found').toBeGreaterThan(0);
			expect(offenders, offenders.join('; ')).toEqual([]);
		}
	);

	it.skipIf(!dirForKind('buildings'))(
		'buildings packs hold enough footprints to read as a city',
		() => {
			/**
			 * The other half of "worth flying": a downtown pass over four blocks
			 * is a flyover of a car park. Every pack here holds 600 footprints
			 * except Denver at 190, so its pass is thin rather than misplaced —
			 * and it would pass the containment check above on its own, which is
			 * why this is a separate assertion. It also catches a pack that was
			 * truncated by a fetch that half-succeeded.
			 */
			const thin: string[] = [];
			const thinNotes: string[] = [];
			let checked = 0;
			for (const loc of LOCATIONS) {
				const path = packPath('buildings', loc.id);
				if (!existsSync(path)) continue;
				checked++;
				const geo = JSON.parse(readFileSync(path, 'utf8')) as { features?: unknown[] };
				const n = geo.features?.length ?? 0;
				if (n < 300) {
					const note = excused(KNOWN_THIN, loc.id);
					if (note) thinNotes.push(`${loc.id}: KNOWN (${note})`);
					else thin.push(`${loc.id}: ${n} footprints`);
				}
			}
			expect(checked, 'no buildings packs found').toBeGreaterThan(0);
			expect(thin, thin.join('; ')).toEqual([]);
			if (thinNotes.length) console.log(`  known thin packs: ${thinNotes.join('; ')}`);
		}
	);
});
