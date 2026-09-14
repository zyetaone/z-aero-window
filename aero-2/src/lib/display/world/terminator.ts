/**
 * terminator — the day/night line as vector geometry.
 *
 * Cesium blends its night imagery per pixel off the real sun position, so a
 * dusk frame shows day and night in the SAME frame with a terminator sweeping
 * through it. Our `night` scalar cannot do that: the whole frame is day or
 * night together, which is why transitions read flat. This module recovers
 * the terminator as geometry: nested night-cap bands around the antisolar
 * point, drawn as draped fills UNDER the emitted city lights (but OVER the
 * ground photograph), so dusk darkens the ground on the night side while
 * VIIRS and the lamp dots keep glowing through it.
 *
 * All pure and unit-tested: subsolar point, great-circle destinations,
 * small-circle rings, antimeridian splitting, band assembly. The component
 * (`Terminator.svelte`) only refreshes the FeatureCollection every 60 s —
 * the sun moves 0.25°/minute, so finer updates would churn the source for
 * an invisible difference.
 */

import { antipodeOf, subSolarPoint, type GeoPoint } from './sun.js';
import { DEG2RAD, RAD2DEG } from '#lib/angles.js';

export interface NightBand {
	/** Outer radius from the antisolar point, degrees. */
	outer: number;
	/** Inner radius, degrees; null draws a solid cap. */
	inner: number | null;
	/** Fill opacity of this band (absolute, not cumulative — bands tile). */
	opacity: number;
}

/**
 * Feathered night, tiled outward from full dark: angular distance from the
 * subsolar point d gives sun elevation 90−d, so civil darkness (elev < −6°)
 * starts at d = 96°, i.e. 84°... measured from the ANTISOLAR point a = 180−d,
 * the solid cap ends at a = 72° and the feather runs out to a = 96°.
 */
export const NIGHT_BANDS: NightBand[] = [
	{ outer: 96, inner: 90, opacity: 0.05 },
	{ outer: 90, inner: 84, opacity: 0.11 },
	{ outer: 84, inner: 78, opacity: 0.18 },
	{ outer: 78, inner: 72, opacity: 0.26 },
	{ outer: 72, inner: null, opacity: 0.34 }
];

/**
 * Great-circle destination on a spherical earth. Longitude comes back
 * UNWRAPPED (continuous with the origin) — `splitRing` does the cutting;
 * normalizing here would weld a seam into every ring that crosses ±180.
 */
export function destPoint(from: GeoPoint, bearingDeg: number, angularDeg: number): GeoPoint {
	const d = angularDeg * DEG2RAD;
	const t = bearingDeg * DEG2RAD;
	const p1 = from.lat * DEG2RAD;
	const l1 = from.lng * DEG2RAD;
	const sinP1 = Math.sin(p1);
	const cosP1 = Math.cos(p1);
	const p2 = Math.asin(sinP1 * Math.cos(d) + cosP1 * Math.sin(d) * Math.cos(t));
	const l2 =
		l1 + Math.atan2(Math.sin(t) * Math.sin(d) * cosP1, Math.cos(d) - sinP1 * Math.sin(p2));
	return { lat: p2 * RAD2DEG, lng: l2 * RAD2DEG };
}

/**
 * Small circle around a centre at fixed angular radius, as a closed ring
 * with continuous (unwrapped) longitudes. 73 points at 5° steps: the chord
 * error on a 96° cap is invisible under a 0.05-opacity feather.
 */
export function circleRing(center: GeoPoint, radiusDeg: number, steps = 72): GeoPoint[] {
	const pts: GeoPoint[] = [];
	for (let i = 0; i <= steps; i++) {
		const p = destPoint(center, (i / steps) * 360, radiusDeg);
		if (i > 0) {
			// Unwrap against the previous point so the ring never jumps.
			const prev = pts[i - 1].lng;
			let lng = p.lng;
			while (lng - prev > 180) lng -= 360;
			while (lng - prev < -180) lng += 360;
			pts.push({ lat: p.lat, lng });
		} else {
			pts.push(p);
		}
	}
	return pts;
}

function normLng(lng: number): number {
	return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/**
 * Split a closed linear ring at antimeridian crossings into simple parts,
 * each with longitudes normalized into [−180, 180].
 *
 * The cut interpolates the crossing latitude linearly in (lng, lat) — fine
 * at 5° steps — and each part is re-closed. Rings that never cross come back
 * as exactly one part. Parts never contain a crossing by construction, so
 * normalizing per point cannot tear them.
 */
export function splitRing(ring: GeoPoint[]): GeoPoint[][] {
	const parts: GeoPoint[][] = [];
	let current: GeoPoint[] = [];
	const push = (p: GeoPoint) => current.push({ lat: p.lat, lng: normLng(p.lng) });
	// Rings arrive with continuous (unwrapped) longitudes, so a smooth
	// meridian crossing shows no jump — detect straddling an 180+360k line.
	const meridianIndex = (lng: number) => Math.floor((lng - 180) / 360);

	push(ring[0]);
	for (let i = 1; i < ring.length; i++) {
		const prev = ring[i - 1];
		const p = ring[i];
		if (meridianIndex(prev.lng) !== meridianIndex(p.lng)) {
			const k = Math.max(meridianIndex(prev.lng), meridianIndex(p.lng));
			const edgeRaw = 180 + 360 * k;
			const t = (edgeRaw - prev.lng) / (p.lng - prev.lng);
			const lat = prev.lat + (p.lat - prev.lat) * t;
			/**
			 * The cut vertices keep the SIDE they were approached from, and so
			 * must bypass `normLng` -- which maps +180 to -180 and would put
			 * the eastern piece's boundary on the western edge of the map,
			 * stretching that polygon across every longitude between.
			 */
			const endLng = prev.lng < edgeRaw ? 180 : -180;
			current.push({ lat, lng: endLng });
			parts.push(current);
			current = [];
			current.push({ lat, lng: -endLng });
		}
		push(p);
	}
	parts.push(current);

	/**
	 * A closed ring has no beginning, so `ring[0]` is not a boundary.
	 *
	 * Cutting a closed ring at N crossings must yield N pieces. The loop above
	 * yields N+1, because it opens a part at `ring[0]` and closes one there
	 * too -- so the piece that happens to contain the start vertex comes out as
	 * two polygons, each then re-closed with a straight chord across the cap's
	 * interior. That chord removes filled area and adds unfilled area.
	 *
	 * Measured before this line existed: the night bands were wrong for 53% of
	 * the day over Hyderabad and 75% over Denver, at worst painting 0.60 of
	 * night wash onto ground that should carry none. The direct proof needs no
	 * renderer: the solid 72 deg cap did not contain the antisolar point it is
	 * drawn around, on any day when it straddled the antimeridian.
	 *
	 * The ring closes (`ring[last]` === `ring[0]`), so the final part ends
	 * exactly where the first begins. Joining them restores the true piece.
	 */
	if (parts.length > 1) {
		const tail = parts.pop() as GeoPoint[];
		parts[0] = [...tail.slice(0, -1), ...parts[0]];
	}

	// Re-close every part. `>= 3` keeps genuine slivers at the cut: three
	// distinct points already enclose area, and `>= 4` silently dropped them.
	return parts
		.filter((part) => part.length >= 3)
		.map((part) => {
			const first = part[0];
			const last = part[part.length - 1];
			if (first.lat !== last.lat || first.lng !== last.lng) part.push({ ...first });
			return part;
		});
}

const toPositions = (part: GeoPoint[]): number[][] => part.map((p) => [p.lng, p.lat]);

/**
 * One band as renderable polygons: a cap, or an annulus built as a single
 * linear ring (outer circle out, inner circle back) so the splitter treats
 * the radial cuts as ordinary edges. Returns [lng,lat] polygon sets.
 */
export function bandPolygons(
	center: GeoPoint,
	band: NightBand,
	steps = 72
): number[][][][] {
	const outer = circleRing(center, band.outer, steps);
	if (band.inner === null) {
		return splitRing(outer).map((part) => [toPositions(part)]);
	}
	const inner = circleRing(center, band.inner, steps).reverse();
	const path = [...outer.slice(0, -1), ...inner.slice(0, -1), outer[0]];
	return splitRing(path).map((part) => [toPositions(part)]);
}

export interface NightOverlay {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		properties: { band: number; opacity: number };
		geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
	}[];
}

/** The whole feathered night for a wall-clock instant, centred opposite the sun. */
export function nightOverlay(wallSec: number): NightOverlay {
	const anti = antipodeOf(subSolarPoint(wallSec));
	return {
		type: 'FeatureCollection',
		features: NIGHT_BANDS.map((band, i) => ({
			type: 'Feature',
			properties: { band: i, opacity: band.opacity },
			geometry: { type: 'MultiPolygon', coordinates: bandPolygons(anti, band) }
		}))
	};
}
