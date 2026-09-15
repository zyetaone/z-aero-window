/**
 * minimap-project — pure Web-Mercator math for the flight inset.
 *
 * WHY THIS EXISTS: MiniMap used to mount a second live MapLibre instance
 * just to (a) paint a raster backdrop and (b) call `map.project()` for its
 * SVG overlay. That second instance owned its own WebGL context, decoded
 * its own tiles, and repainted on every main-map `render` event — a
 * full-rate second map for a 190 px inset, and the prime suspect in the
 * aero-2 frame dips. Rune-free and renderer-free, so it is unit-testable
 * and either app can use it.
 */

export const MINIMAP_SIZE_PX = 190;
/**
 * Backdrop tiles are fetched one integer zoom ABOVE the fractional view
 * zoom (6.55): each 256 px tile draws at ~94 px, so the inset downsamples
 * instead of upscaling. z7 stretched 2x and read soft next to the vector
 * overlay.
 */
export const MINIMAP_TILE_ZOOM = 8;

const TILE_PX = 256;

function worldPx(zoom: number): number {
	return TILE_PX * 2 ** zoom;
}

function lonToX(lon: number, world: number): number {
	return ((lon + 180) / 360) * world;
}

function latToY(lat: number, world: number): number {
	const rad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
	return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
}

/**
 * Project lon/lat to pixels in a `size`×`size` inset centred on
 * (centerLon, centerLat) at fractional `zoom`. Handles the antimeridian by
 * wrapping the delta, so a Pacific track never flings the marker across
 * the disc.
 */
export function projectMini(
	lon: number,
	lat: number,
	centerLon: number,
	centerLat: number,
	zoom: number,
	size: number = MINIMAP_SIZE_PX
): { x: number; y: number } {
	const world = worldPx(zoom);
	let dx = lonToX(lon, world) - lonToX(centerLon, world);
	if (dx > world / 2) dx -= world;
	if (dx < -world / 2) dx += world;
	const dy = latToY(lat, world) - latToY(centerLat, world);
	return { x: size / 2 + dx, y: size / 2 + dy };
}

/** Inverse of the latitude step above: pixel y at `zoom` back to latitude. */
function yToLat(y: number, world: number): number {
	const n = Math.PI * (1 - (2 * y) / world);
	return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

export interface MiniTile {
	x: number;
	y: number;
	/** CSS px offset of the tile's top-left corner inside the inset. */
	left: number;
	top: number;
	/** CSS px size (tiles are scaled from their native 256 to the view zoom). */
	size: number;
}

/**
 * The integer-zoom tiles covering the inset viewport, with their pixel
 * placement. x wraps at the antimeridian, y clamps at the poles. The
 * caller turns these into URLs from its own tile template.
 */
export function coverTiles(
	centerLon: number,
	centerLat: number,
	zoom: number,
	size: number = MINIMAP_SIZE_PX,
	tileZoom: number = MINIMAP_TILE_ZOOM
): MiniTile[] {
	const world = worldPx(zoom);
	const n = 2 ** tileZoom;
	const scale = world / (TILE_PX * n);
	const cx = lonToX(centerLon, world);
	const cy = latToY(centerLat, world);
	const x0 = Math.floor(((cx - size / 2) / world) * n);
	const x1 = Math.floor(((cx + size / 2) / world) * n);
	const y0 = Math.max(0, Math.floor(((cy - size / 2) / world) * n));
	const y1 = Math.min(n - 1, Math.floor(((cy + size / 2) / world) * n));
	const out: MiniTile[] = [];
	for (let x = x0; x <= x1; x++) {
		for (let y = y0; y <= y1; y++) {
			const wrapped = ((x % n) + n) % n;
			out.push({
				x: wrapped,
				y,
				left: (x * TILE_PX - (cx - size / 2) / scale) * scale,
				top: (y * TILE_PX - (cy - size / 2) / scale) * scale,
				size: TILE_PX * scale
			});
		}
	}
	return out;
}

/** Pixel y at `zoom` back to longitude — exported for tests. */
export function xToLon(x: number, world: number): number {
	return (x / world) * 360 - 180;
}

export { yToLat };
