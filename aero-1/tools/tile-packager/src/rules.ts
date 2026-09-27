/**
 * Pure tile-math: lat/lon → XYZ tile coords, bbox enumeration, storage estimates.
 *
 * All functions are pure + no Bun/Node fs deps so they're easily testable.
 */

export interface TileSpec {
	z: number;
	x: number;
	y: number;
}

/** Convert lon/lat to XYZ tile coordinates at a given zoom (WebMercator). */
export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
	const n = 2 ** z;
	const x = Math.floor(((lon + 180) / 360) * n);
	const latRad = (lat * Math.PI) / 180;
	const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
	return { x, y };
}

/**
 * Enumerate all tiles within a square bbox of `radiusDeg` around (lat, lon)
 * across the inclusive zoom range [zMin, zMax].
 *
 * radiusDeg = 0.5 ≈ ~55 km half-side at equator, plenty for an airplane
 * window's visible cone at cruise altitude.
 */
export function enumerateTiles(
	lat: number,
	lon: number,
	radiusDeg: number,
	zMin: number,
	zMax: number,
): TileSpec[] {
	const tiles: TileSpec[] = [];
	for (let z = zMin; z <= zMax; z++) {
		const tl = lonLatToTile(lon - radiusDeg, lat + radiusDeg, z);
		const br = lonLatToTile(lon + radiusDeg, lat - radiusDeg, z);
		const xMin = Math.max(0, Math.min(tl.x, br.x));
		const xMax = Math.max(tl.x, br.x);
		const yMin = Math.max(0, Math.min(tl.y, br.y));
		const yMax = Math.max(tl.y, br.y);
		for (let y = yMin; y <= yMax; y++) {
			for (let x = xMin; x <= xMax; x++) {
				tiles.push({ z, x, y });
			}
		}
	}
	return tiles;
}

/** Average bytes per tile by source — calibrated against real samples. */
export const TILE_AVG_BYTES = {
	'viirs-night-lights': 11_000,
} as const;
// Removed 2026-09-28: 'eox-sentinel2' (CC BY-NC-SA, cannot ship on a paid
// install) and 'cesium-terrain' from Cesium ion (tokened, online). Day imagery
// is now the Copernicus `sentinel2/` tree aero-2/tools builds from Level-2A
// COGs; terrain is tools/build-terrain.py from AWS Open Data elevation. Both
// are open data, both are built offline, neither needs a token.

export type TileSource = keyof typeof TILE_AVG_BYTES;

/** Non-tile sources (per-location GeoJSON, not XYZ tiles). */
export const NON_TILE_SOURCES = ['osm-buildings'] as const;
export type NonTileSource = (typeof NON_TILE_SOURCES)[number];

/** All packager source types (tiled + per-location). */
export type PackagerSource = TileSource | NonTileSource;

/** Estimate storage cost for a tile set at a given source. */
export function estimateBytes(tileCount: number, source: TileSource): number {
	return tileCount * TILE_AVG_BYTES[source];
}

/** Format byte count for human display. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
