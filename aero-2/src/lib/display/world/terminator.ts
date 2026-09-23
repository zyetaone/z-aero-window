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
	/** How dark the ground is INSIDE this radius, composited. */
	opacity: number;
}

/**
 * Feathered night, as nested solid caps around the antisolar point.
 *
 * Angular distance from the subsolar point d gives sun elevation 90-d, so
 * civil darkness (elev < -6) starts at d = 96; measured from the ANTISOLAR
 * point a = 180-d, that is a = 84, and the feather runs out to a = 96.
 *
 * `opacity` is the COMPOSITE darkness at that radius -- what a reader wants to
 * check against the sky. The caps overlap, so `nightOverlay` derives the
 * incremental alpha each cap must carry for the stack to land on these numbers.
 *
 * Nested caps, not tiled annuli. An annulus is two circles joined by a bridge,
 * and a circle that winds around a pole cannot be cut at the antimeridian at
 * all -- which is 16-21% of the year for three of these five bands. A cap has
 * no hole, so every shape reduces to one of two primitives.
 */
export const NIGHT_BANDS: NightBand[] = [
	{ outer: 96, opacity: 0.05 },
	{ outer: 90, opacity: 0.11 },
	{ outer: 84, opacity: 0.18 },
	{ outer: 78, opacity: 0.26 },
	{ outer: 72, opacity: 0.34 }
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

/**
 * Which pole the boundary circle WINDS AROUND, if any.
 *
 * Not the same as "which poles the cap contains", and the difference decides
 * the shape. A small circle separates its cap from the complement, so it winds
 * around a pole exactly when ONE pole is inside and the other is not. When
 * BOTH are inside the ring winds around neither: the cap is then the whole
 * world minus a small cap at the antipode, and the ring is that small cap's
 * boundary.
 *
 * The antisolar point never leaves +/-23.44 deg, so against band radii of
 * 72..96 winding is the normal case, not an edge case: measured over a year,
 * the 90 deg cap winds around a pole 83% of the time.
 */
function windingPole(center: GeoPoint, radiusDeg: number): 1 | -1 | 0 {
	const inNorth = 90 - center.lat < radiusDeg;
	const inSouth = 90 + center.lat < radiusDeg;
	if (inNorth === inSouth) return 0;
	return inNorth ? 1 : -1;
}

/** True when the cap swallows both poles -- it is then a complement, not a disk. */
function coversBothPoles(center: GeoPoint, radiusDeg: number): boolean {
	return 90 - center.lat < radiusDeg && 90 + center.lat < radiusDeg;
}

/**
 * A pole-winding region as one renderable ring.
 *
 * The input is a curve that crosses every meridian exactly once, so it is
 * single-valued in longitude: sorting the normalised points by longitude
 * recovers it in order, and closing over the pole fills the region. No
 * antimeridian cut is involved, which is why `splitRing` -- whose whole job is
 * that cut -- could never represent this shape.
 *
 * The curve is periodic, so the latitude at -180 and at +180 is the SAME
 * value: the crossing between the last sorted point and the first, one turn on.
 * Using each end's own latitude instead leaves a jag of up to one step there.
 */
function poleCapRing(curve: GeoPoint[], pole: 1 | -1): GeoPoint[] {
	const pts = curve
		.map((p) => ({ lat: p.lat, lng: normLng(p.lng) }))
		.sort((a, b) => a.lng - b.lng);
	const first = pts[0];
	const last = pts[pts.length - 1];
	const span = first.lng + 360 - last.lng;
	const t = span === 0 ? 0 : (180 - last.lng) / span;
	const edgeLat = last.lat + (first.lat - last.lat) * t;
	const poleLat = pole === 1 ? 90 : -90;
	return [
		{ lat: edgeLat, lng: -180 },
		...pts,
		{ lat: edgeLat, lng: 180 },
		{ lat: poleLat, lng: 180 },
		{ lat: poleLat, lng: -180 },
		{ lat: edgeLat, lng: -180 }
	];
}

const meanLat = (pts: GeoPoint[]): number =>
	pts.reduce((a, p) => a + p.lat, 0) / pts.length;

/**
 * A cap that contains BOTH poles, as two pole-winding pieces that tile it.
 *
 * Such a cap is the whole world minus a small disk at the antipode, and a
 * polygon-with-a-hole cannot express that here: the disk usually straddles the
 * antimeridian, so its hole would arrive in two pieces, each touching the
 * exterior edge. (Widening the exterior past +/-180 does not rescue it either
 * -- geojson-vt wraps anything outside the world and draws the overflow a
 * second time, inside the hole.)
 *
 * Instead, cut the complement along the two extreme-longitude vertices of the
 * disk. The disk spans less than 360 deg of longitude, so above its upper arc
 * and below its lower arc are each single-valued curves once continued across
 * the unspanned longitudes by a shared link. Both pieces use the SAME link, so
 * they abut exactly: no overlap to double-darken, no gap to show through.
 */
function bothPolesCap(ring: GeoPoint[]): number[][][][] {
	const pts = ring.slice(0, -1);
	let wi = 0;
	let ei = 0;
	for (let i = 1; i < pts.length; i++) {
		if (pts[i].lng < pts[wi].lng) wi = i;
		if (pts[i].lng > pts[ei].lng) ei = i;
	}
	const arc = (from: number, to: number): GeoPoint[] => {
		const out: GeoPoint[] = [];
		for (let i = from; ; i = (i + 1) % pts.length) {
			out.push(pts[i]);
			if (i === to) break;
		}
		return out;
	};
	const a = arc(wi, ei);
	const b = arc(ei, wi).reverse();
	const upper = meanLat(a) > meanLat(b) ? a : b;
	const lower = upper === a ? b : a;

	// The longitudes the disk does not span, walked at its own edge latitudes.
	const w = pts[wi];
	const e = pts[ei];
	const link: GeoPoint[] = [];
	const LINK_STEPS = 12;
	for (let i = 1; i < LINK_STEPS; i++) {
		const t = i / LINK_STEPS;
		link.push({ lat: e.lat + (w.lat - e.lat) * t, lng: e.lng + (w.lng + 360 - e.lng) * t });
	}
	return [
		[toPositions(poleCapRing([...upper, ...link], 1))],
		[toPositions(poleCapRing([...lower, ...link], -1))]
	];
}

const toPositions = (part: GeoPoint[]): number[][] => part.map((p) => [p.lng, p.lat]);

/**
 * One solid cap as renderable polygons, in whichever of the three shapes the
 * sun's declination has put it: a plain disk (cut at the antimeridian if it
 * reaches), a pole-winding region, or a both-poles complement.
 */
export function capPolygons(center: GeoPoint, radiusDeg: number, steps = 72): number[][][][] {
	const ring = circleRing(center, radiusDeg, steps);
	if (coversBothPoles(center, radiusDeg)) return bothPolesCap(ring);
	const pole = windingPole(center, radiusDeg);
	if (pole !== 0) return [[toPositions(poleCapRing(ring.slice(0, -1), pole))]];
	return splitRing(ring).map((part) => [toPositions(part)]);
}

export interface NightOverlay {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		properties: { band: number; opacity: number };
		geometry: { type: 'MultiPolygon'; coordinates: number[][][][] };
	}[];
}

/**
 * The whole feathered night for a wall-clock instant, centred opposite the sun.
 *
 * The caps nest, so `opacity` here is not the band's darkness -- it is the
 * extra alpha this cap must add on top of the one outside it to reach it:
 * a = 1 - (1 - c_i) / (1 - c_i-1). MapLibre draws a fill layer in the
 * translucent pass with a tile-clipping stencil only (verified in
 * `webgl/draw/draw_fill.ts`), so overlapping features composite; every cap is
 * the same colour, and alpha-over of one colour is order-independent.
 */
export function nightOverlay(wallSec: number): NightOverlay {
	const anti = antipodeOf(subSolarPoint(wallSec));
	let covered = 0;
	return {
		type: 'FeatureCollection',
		features: NIGHT_BANDS.map((band, i) => {
			const alpha = 1 - (1 - band.opacity) / (1 - covered);
			covered = band.opacity;
			return {
				type: 'Feature' as const,
				properties: { band: i, opacity: alpha },
				geometry: {
					type: 'MultiPolygon' as const,
					coordinates: capPolygons(anti, band.outer)
				}
			};
		})
	};
}
