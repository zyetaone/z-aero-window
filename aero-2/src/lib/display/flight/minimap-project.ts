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
import { FlightTrack } from './flight-path.js';
import {
	DOWNTOWN_HANDOFF_SEC,
	DOWNTOWN_PASS_END_SEC,
	DOWNTOWN_PASS_START_SEC,
	downtownBlendAt,
	downtownPose,
	downtownWarpSec
} from './downtown.js';

export const MINIMAP_SIZE_PX = 190;
/**
 * Backdrop tiles are fetched one integer zoom ABOVE the fractional view
 * zoom (6.55): each 256 px tile draws at ~94 px, so the inset downsamples
 * instead of upscaling. z7 stretched 2x and read soft next to the vector
 * overlay.
 */
export const MINIMAP_TILE_ZOOM = 8;

/**
 * The downtown thread as minimap geometry: [lon, lat] samples across the
 * pass window, or null when the gate never opens.
 *
 * The marker reads the blended view position (thread included) while the
 * ring is the big loop only, so mid-pass the marker walks off the ring —
 * the off-ring wart. This draws the missing piece: the same blend the
 * view computes (big pose at effective seconds, thread pose at warped
 * seconds, downtown gate, smoothstep ease identical to blendViews), so the
 * marker rides ON a drawn path instead of leaving it.
 *
 * Pure in (track, place, speed): the pass window is fixed in wall seconds
 * and the climb it gates on is a pure function of effective seconds, so
 * the arc is identical every visit. Null when the gate stays shut through
 * the whole window (high-floor cities, features) — the caller draws
 * nothing instead of a dot at downtown.
 */
export function threadArc(
	track: FlightTrack,
	placeLat: number,
	placeLon: number,
	floorM: number,
	speed: number,
	samples = 48
): Array<[number, number]> | null {
	const start = DOWNTOWN_PASS_START_SEC - DOWNTOWN_HANDOFF_SEC;
	const end = DOWNTOWN_PASS_END_SEC + DOWNTOWN_HANDOFF_SEC;
	const pts: Array<[number, number]> = [];
	let engaged = false;
	for (let i = 0; i < samples; i++) {
		const s = start + ((end - start) * i) / (samples - 1);
		const eff = s * speed;
		const plane = track.poseAt(eff);
		const t = downtownBlendAt(s, plane.aglM);
		let lat = plane.lat;
		let lon = plane.lon;
		if (t > 0) {
			engaged = true;
			const small = downtownPose(track.poseAt(downtownWarpSec(eff)), placeLat, placeLon, floorM);
			// Smoothstep — the same ease blendViews applies, so the arc
			// meets the ring exactly where the marker leaves it.
			const e = t * t * (3 - 2 * t);
			lat = plane.lat + (small.lat - plane.lat) * e;
			const dLon = ((small.lon - plane.lon + 540) % 360) - 180;
			lon = plane.lon + dLon * e;
		}
		pts.push([lon, lat]);
	}
	return engaged ? pts : null;
}

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
