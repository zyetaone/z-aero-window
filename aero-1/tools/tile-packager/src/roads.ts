/**
 * OSM road extraction — the generator `data/roads/` never had.
 *
 * The night street grid ships as ODbL vector GeoJSON (world/roads-geojson,
 * served by /api/roads/:city). Those files were in the repo but NOTHING in this
 * packager produced them: the only road-shaped code here was `viirs-roads`,
 * which composites the CARTO raster and is dead by licence. So the shipped data
 * had no reproducible generator, which is how it ended up at a radius nobody
 * chose on purpose.
 *
 * ─── ⚠ RADIUS IS PER CLASS, AND THAT IS THE WHOLE DESIGN ────────────────────
 * The extracts this replaces were a uniform ~5-8 km (denver: 4.2 x 2.3 km, 128
 * features). At the 28-34k ft night band the visible ground is ~100 km across,
 * so a uniform patch reads as a bright postage stamp of streets in an otherwise
 * bare VIIRS blur.
 *
 * The naive fix — one big radius — is unaffordable: area scales quadratically,
 * so 7 km -> 40 km is ~30x the data, and it is ~30x mostly RESIDENTIAL, which
 * is 80% of feature count and is faded to nothing by altitudeDetailMix at
 * exactly the altitude where the wide radius would matter. Paying 30x to render
 * alpha 0.01 is the worst possible trade.
 *
 * So each class gets the radius its own visibility curve justifies:
 *
 *   motorway/trunk/primary   40 km   carries structure at cruise; a small
 *                                    minority of features, so cheap to widen
 *   secondary/tertiary       12 km   mid-band detail
 *   residential               6 km   near-field only; invisible above ~20k ft
 *
 * That buys most of the visible-band structure for a small fraction of the
 * uniform-bump cost, because arterials are rare and side streets are not.
 */

/** Classes we keep, in the order world/roads-geojson styles them. */
export const ROAD_CLASSES = [
	'motorway',
	'trunk',
	'primary',
	'secondary',
	'tertiary',
	'residential',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/**
 * Per-class extraction radius in metres.
 *
 * ⚠ These are paired with world/roads-geojson's ROAD_STYLE alpha weights and
 * with altitudeDetailMix. Widening `residential` without also changing its
 * altitude fade just buys data that never draws; narrowing `motorway` puts the
 * postage-stamp problem straight back.
 */
export const ROAD_RADIUS_M: Record<RoadClass, number> = {
	motorway: 40_000,
	trunk: 40_000,
	primary: 40_000,
	secondary: 12_000,
	tertiary: 12_000,
	residential: 6_000,
};

/** Distinct radii, largest first — one Overpass query per radius, not per class. */
export function radiusGroups(): Array<{ radius: number; classes: RoadClass[] }> {
	const byRadius = new Map<number, RoadClass[]>();
	for (const cls of ROAD_CLASSES) {
		const r = ROAD_RADIUS_M[cls];
		const list = byRadius.get(r);
		if (list) list.push(cls);
		else byRadius.set(r, [cls]);
	}
	return [...byRadius.entries()]
		.sort((a, b) => b[0] - a[0])
		.map(([radius, classes]) => ({ radius, classes }));
}

/**
 * ⚠ OVERPASS 406s A REQUEST WITH NO User-Agent, AND IT LOOKS LIKE A RATE LIMIT.
 *
 * `curl` sets one automatically; `fetch` (bun/node/undici) does not. The result
 * is a flat HTTP 406 "Not Acceptable" on every request, while /api/status
 * cheerfully reports free slots and the identical query pasted into curl
 * returns 200 — which reads exactly like being throttled, and sends you off
 * adding backoff that cannot possibly help. Cost an entire batch run.
 *
 * Identifying the client is also just the polite thing to do against a free
 * public mirror we are asking for 5 MB at a time.
 */
export const OVERPASS_HEADERS = {
	'Content-Type': 'application/x-www-form-urlencoded',
	'User-Agent': 'z-aero-window-tile-packager/1.0 (+https://github.com/zyetaone)',
} as const;

export const ROADS_CONFIG = {
	storagePath: (city: string) => `../data/roads/${city}.geojson`,
	/**
	 * One query per radius group. `out geom` returns coordinates inline so we
	 * never need a second pass to resolve node ids — same reason BUILDINGS_CONFIG
	 * does it.
	 *
	 * `[link]?` catches motorway_link / primary_link etc: slip roads are what
	 * make an interchange read as an interchange instead of two crossing lines.
	 */
	buildOverpassQuery: (lat: number, lon: number, radius: number, classes: readonly RoadClass[]) =>
		`[out:json][timeout:180];`
		+ `(way["highway"~"^(${classes.join('|')})(_link)?$"](around:${radius},${lat},${lon}););`
		+ `out geom tags;`,
	/**
	 * Mirrors, tried in order. This list is MIRRORED — but not identical — in
	 * aero-2's tools/fetch-buildings.py (ENDPOINTS), and the two have
	 * deliberately diverged. Read that list's comment before editing either:
	 * fetch-buildings measured `overpass.private.coffee` at a 504 after 79 s
	 * (flaky) and dropped it for maps.mail.ru, while this list still carries
	 * it — not re-measured for the roads workload. The failure policy diverged
	 * too: fetch-buildings raises on 400/413/422 (a malformed query no mirror
	 * can fix), while fetchRoadGroupFeatures treats any `!res.ok` as "try the
	 * next mirror", which turns a malformed query into a wasted 3 x N cycle
	 * before the real message surfaces.
	 */
	endpoints: [
		'https://overpass-api.de/api/interpreter',
		'https://overpass.kumi.systems/api/interpreter',
		'https://overpass.private.coffee/api/interpreter',
	] as const,
} as const;

export interface RoadFeature {
	type: 'Feature';
	properties: { class: RoadClass };
	geometry: { type: 'LineString'; coordinates: number[][] };
}

/** `motorway_link` and friends are styled as their parent class. */
export function normaliseClass(highway: string | undefined): RoadClass | null {
	if (!highway) return null;
	const base = highway.endsWith('_link') ? highway.slice(0, -5) : highway;
	return (ROAD_CLASSES as readonly string[]).includes(base) ? (base as RoadClass) : null;
}

/**
 * Overpass ways → slim LineString GeoJSON.
 *
 * Deliberately slim: `class` and geometry, nothing else. Names, refs, surface
 * and lanes are ~4x the bytes for data the renderer cannot use — it draws
 * coloured lines, it does not label them.
 *
 * `seen` carries across radius groups so a motorway inside the 6 km residential
 * query is not emitted twice. Without it the overlapping rings would duplicate
 * every arterial near the centre, which is exactly the geometry that gets drawn
 * brightest and would composite to double alpha.
 */
export function overpassToRoadGeoJson(
	overpassJson: {
		elements: Array<{
			type: string;
			id?: number;
			geometry?: Array<{ lat: number; lon: number }>;
			tags?: Record<string, string>;
		}>;
	},
	seen: Set<number> = new Set(),
): { type: 'FeatureCollection'; features: RoadFeature[] } {
	const features: RoadFeature[] = [];
	for (const el of overpassJson.elements) {
		if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
		if (el.id !== undefined) {
			if (seen.has(el.id)) continue;
			seen.add(el.id);
		}
		const cls = normaliseClass(el.tags?.['highway']);
		if (!cls) continue;

		// Round to ~1 m. OSM carries 7 decimal places; at 1 m the shape is
		// visually identical at 28,000 ft and the file is roughly a third
		// smaller, which matters because this rides `git pull` to the fleet.
		const coordinates: number[][] = [];
		for (const g of el.geometry) {
			const lon = Math.round(g.lon * 1e5) / 1e5;
			const lat = Math.round(g.lat * 1e5) / 1e5;
			const prev = coordinates[coordinates.length - 1];
			if (prev && prev[0] === lon && prev[1] === lat) continue;
			coordinates.push([lon, lat]);
		}
		if (coordinates.length < 2) continue;

		features.push({
			type: 'Feature',
			properties: { class: cls },
			geometry: { type: 'LineString', coordinates },
		});
	}
	return { type: 'FeatureCollection', features };
}

const ROAD_GROUP_ATTEMPTS = 3;
const ROAD_GROUP_RETRY_MS = 2_000;

/**
 * One Overpass radius-group query with endpoint failover and linear backoff.
 * Returns null when every attempt fails — caller must not write partial output.
 */
export async function fetchRoadGroupFeatures(
	lat: number,
	lon: number,
	radius: number,
	classes: readonly RoadClass[],
	seen: Set<number>,
): Promise<RoadFeature[] | null> {
	const query = ROADS_CONFIG.buildOverpassQuery(lat, lon, radius, classes);
	for (let attempt = 1; attempt <= ROAD_GROUP_ATTEMPTS; attempt++) {
		for (const endpoint of ROADS_CONFIG.endpoints) {
			try {
				const res = await fetch(endpoint, {
					method: 'POST',
					headers: OVERPASS_HEADERS,
					body: `data=${encodeURIComponent(query)}`,
				});
				if (!res.ok) continue;
				const json = (await res.json()) as Parameters<typeof overpassToRoadGeoJson>[0];
				return overpassToRoadGeoJson(json, seen).features;
			} catch {
				// try next endpoint
			}
		}
		if (attempt < ROAD_GROUP_ATTEMPTS) {
			await new Promise((r) => setTimeout(r, ROAD_GROUP_RETRY_MS * attempt));
		}
	}
	return null;
}
