/**
 * Per-source URL templates + zoom ranges for the tile packager.
 *
 * Mirrors what CesiumManager would request at runtime, but pre-warms
 * a local cache so the Pi can serve tiles offline via /api/tiles/[...path].
 *
 * Types:
 *   - TileSource     → XYZ tile grid, downloaded per enumerated (z,x,y)
 *   - NonTileSource  → per-location artifact (e.g. Overpass GeoJSON)
 */

import type { TileSource, TileSpec } from './rules';
import { OVERPASS_MIRRORS, VIIRS_GIBS_BASE } from '../../../src/lib/upstream.ts';

// ─── Standard XYZ tile sources ──────────────────────────────────────────────

export interface SourceConfig {
	source: TileSource;
	/** Filename template — {z}, {x}, {y} substituted. Determines on-disk path. */
	storagePath: string;
	urlForTile(t: TileSpec): string;
	zoomRange: [number, number];
	prepareHeaders?: () => Promise<Record<string, string>>;
	/** Apply brightness/contrast boost after download (for dim VIIRS tiles). */
	postProcess?: boolean;
	boostBrightness?: number;
	boostContrast?: number;
}

export const SOURCES: Record<TileSource, SourceConfig> = {
	'viirs-night-lights': {
		source: 'viirs-night-lights',
		storagePath: 'viirs-night-lights/{z}/{y}/{x}.jpg',
		// Layer + pinned date MUST match src/lib/world/viirs-field.ts — the
		// packaged tiles and the remote fallback have to be the same raster, or
		// a cache miss silently changes what the city looks like. See that file
		// for why Black Marble was dropped (colorized, lifted navy background
		// that cleared the "truly dark" floor over ocean and desert).
		// Layer + date come from $lib/upstream, so the packaged tiles and the
		// runtime fallback cannot drift. They used to be re-typed here.
		urlForTile: (t) => `${VIIRS_GIBS_BASE}/${t.z}/${t.y}/${t.x}.png`,
		zoomRange: [3, 8], // every GIBS night layer is capped at z8
		// Boost halved (5.0 → 2.5). The old ×5 existed because Black Marble read
		// ~15/255 over Indian cities; this radiance product reads a median 77/255
		// over Hyderabad, so the old gain would clip the core to white and drag
		// the background grain up with it.
		postProcess: true,
		boostBrightness: 2.5,
		boostContrast: 1.5,
	},
};

export function tileFilePath(cfg: SourceConfig, t: TileSpec): string {
	return cfg.storagePath
		.replaceAll('{z}', String(t.z))
		.replaceAll('{x}', String(t.x))
		.replaceAll('{y}', String(t.y));
}


// ─── OSM Buildings via Overpass (per-location GeoJSON) ──────────────────────

export interface BuildingsConfig {
	/** Relative output path for the GeoJSON artifact. */
	storagePath: (city: string) => string;
	/** Overpass query template — {lat}, {lon}, {radius} substituted. */
	buildOverpassQuery: (lat: number, lon: number, radiusMeters: number) => string;
	/** Default radius around each location to fetch building footprints (meters). */
	defaultRadiusMeters: number;
	/** Endpoint to POST the Overpass query. Public mirrors rotate; pick the first that works. */
	endpoints: readonly string[];
}

export const BUILDINGS_CONFIG: BuildingsConfig = {
	storagePath: (city) => `../data/buildings/${city}.geojson`,
	// Asks Overpass for all building ways within a radius, returns geometry inline
	// so we don't need a second pass to resolve nodes.
	buildOverpassQuery: (lat, lon, radius) =>
		`[out:json][timeout:90];` +
		`(way["building"](around:${radius},${lat},${lon}););` +
		`out geom tags;`,
	defaultRadiusMeters: 3_500, // ~7 km square — comfortably covers cruise-altitude visible cone
	endpoints: [
		...OVERPASS_MIRRORS,
	] as const,
};

/**
 * Convert an Overpass `way[building]` response into a slim extrusion-ready
 * GeoJSON FeatureCollection. Keeps only the fields Cesium / Maplibre need
 * to extrude polygons: coordinates + height estimate.
 *
 * Height heuristic when `height`/`building:levels` are absent: 3 m per floor,
 * default 3 floors (9 m) — matches typical OSM extrusion defaults.
 */
export function overpassToGeoJson(overpassJson: {
	elements: Array<{
		type: string;
		geometry?: Array<{ lat: number; lon: number }>;
		tags?: Record<string, string>;
	}>;
}): {
	type: 'FeatureCollection';
	features: Array<{
		type: 'Feature';
		properties: { height: number; name?: string };
		geometry: { type: 'Polygon'; coordinates: number[][][] };
	}>;
} {
	const features: Array<{
		type: 'Feature';
		properties: { height: number; name?: string };
		geometry: { type: 'Polygon'; coordinates: number[][][] };
	}> = [];
	for (const el of overpassJson.elements) {
		if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) continue;
		const ring = el.geometry.map((g) => [g.lon, g.lat]);
		// Ensure closed ring
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);

		const tags = el.tags ?? {};
		const rawHeight = tags['height'];
		const rawLevels = tags['building:levels'];
		let height = 9;
		if (rawHeight && !Number.isNaN(Number.parseFloat(rawHeight))) {
			height = Number.parseFloat(rawHeight);
		} else if (rawLevels && !Number.isNaN(Number.parseInt(rawLevels, 10))) {
			height = Number.parseInt(rawLevels, 10) * 3;
		}

		features.push({
			type: 'Feature',
			properties: {
				height,
				...(tags.name ? { name: tags.name } : {}),
			},
			geometry: { type: 'Polygon', coordinates: [ring] },
		});
	}
	return { type: 'FeatureCollection', features };
}
