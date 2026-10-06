/** Web Mercator, as the tile packs use it: one home for the grid both ground/terrain.ts and ground/maps.ts read. */
import { RAD } from '../../math.ts';

export const TILE = 256; // px per tile
/** `span` × `span` tiles at zoom `z`, top-left tile (x0, y0). */
export type Grid = { z: number; x0: number; y0: number; span: number };
/** Longitude and latitude to global Mercator, 0..1 across the world. */
export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2;

/** The two ground patches around a place: one home, read by ground/terrain.ts and tools/fetch-terrain.ts. */
export function gridsFor(lat: number, lon: number): { near: Grid; far: Grid } {
	const [cx, cy] = [Math.floor(mercX(lon) * 2 ** 10), Math.floor(mercY(lat) * 2 ** 10)];
	return {
		// ~37 km tiles: 3×3 is ~110 km around the place, sized so its z12 imagery (3072 px,
		// ~37 m/px) fits the Pi's 4096 px texture limit. z11 over 5×5 smeared like wet paint.
		near: { z: 10, x0: cx - 1, y0: cy - 1, span: 3 },
		// ~150 km tiles: 5×5 is ~750 km, past the horizon from cruise. Its z10 footprint always
		// contains the near patch (cx/4 rounds down by at most 3).
		far: { z: 8, x0: Math.floor(cx / 4) - 2, y0: Math.floor(cy / 4) - 2, span: 5 }
	};
}
