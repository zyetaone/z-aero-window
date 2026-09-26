import { describe, it, expect } from 'vitest';
import {
	projectMini,
	coverTiles,
	MINIMAP_SIZE_PX,
	MINIMAP_TILE_ZOOM,
	threadArc
} from '#lib/display/flight/minimap-project.js';
import { FlightTrack, phaseFor } from '#lib/display/flight/flight-path.js';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { Location, readSettings } from '#lib/settings/settings.svelte.js';

const paramsFor = (search = '') => readSettings(new URL(`http://kiosk.local/${search}`));
function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (aLat - bLat) * 111.32;
	const dLon = (aLon - bLon) * 111.32 * Math.cos((bLat * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

const ZOOM = 6.55;

describe('projectMini', () => {
	it('puts the centre in the middle of the inset', () => {
		const p = projectMini(-122.4, 37.8, -122.4, 37.8, ZOOM);
		expect(p.x).toBeCloseTo(MINIMAP_SIZE_PX / 2, 6);
		expect(p.y).toBeCloseTo(MINIMAP_SIZE_PX / 2, 6);
	});

	it('moves east positive, north negative', () => {
		const c = projectMini(0, 0, 0, 0, ZOOM);
		const east = projectMini(1, 0, 0, 0, ZOOM);
		const north = projectMini(0, 1, 0, 0, ZOOM);
		expect(east.x).toBeGreaterThan(c.x);
		expect(north.y).toBeLessThan(c.y);
	});

	it('wraps at the antimeridian instead of flinging the marker', () => {
		// 179E viewed from a 179W centre is 2° to the WEST, not 358° east:
		// at zoom 6.55 one degree is ~66.6 px, so the marker sits ~133 px
		// left of centre instead of ~23,800 px away.
		const p = projectMini(179, 0, -179, 0, ZOOM);
		expect(p.x - MINIMAP_SIZE_PX / 2).toBeCloseTo(-133.3, 0);
	});

	it('scales with zoom: one degree is wider at higher zoom', () => {
		const lo = projectMini(1, 0, 0, 0, 5);
		const hi = projectMini(1, 0, 0, 0, 8);
		expect(Math.abs(hi.x - MINIMAP_SIZE_PX / 2)).toBeGreaterThan(
			Math.abs(lo.x - MINIMAP_SIZE_PX / 2)
		);
	});
});

describe('coverTiles', () => {
	it('covers the centre pixel and stays a small set', () => {
		const tiles = coverTiles(19.3, 72.8, ZOOM);
		expect(tiles.length).toBeGreaterThan(0);
		expect(tiles.length).toBeLessThanOrEqual(16);
		// Every tile reports placement inside a sane band around the inset.
		for (const t of tiles) {
			expect(t.size).toBeGreaterThan(0);
			expect(t.left).toBeGreaterThan(-t.size);
			expect(t.left).toBeLessThan(MINIMAP_SIZE_PX + t.size);
		}
		// The centre pixel is inside at least one tile.
		const half = MINIMAP_SIZE_PX / 2;
		expect(
			tiles.some(
				(t) => half >= t.left && half <= t.left + t.size && half >= t.top && half <= t.top + t.size
			)
		).toBe(true);
	});

	it('uses the configured integer tile zoom', () => {
		const n = 2 ** MINIMAP_TILE_ZOOM;
		for (const t of coverTiles(0, 0, ZOOM)) {
			expect(t.x).toBeGreaterThanOrEqual(0);
			expect(t.x).toBeLessThan(n);
			expect(t.y).toBeGreaterThanOrEqual(0);
			expect(t.y).toBeLessThan(n);
		}
	});
});

describe('threadArc', () => {
	const hyderabad = Location.byId('hyderabad');
	// Today's real phase, the same one calculateCameraView derives — a
	// fixed literal would fly a different loop than the view under test.
	const cityTrack = () =>
		new FlightTrack(hyderabad.lat, hyderabad.lon, 400, 12_500, 1, phaseFor(hyderabad, 100));

	it('draws the downtown detour the ring omits', () => {
		const arc = threadArc(cityTrack(), hyderabad.lat, hyderabad.lon, 400, 1);
		expect(arc).not.toBeNull();
		expect(arc).toHaveLength(48);
		// Mid-pass samples hug downtown; the window edges rejoin the big
		// loop far outside it.
		for (const [lon, lat] of arc!.slice(10, 38)) {
			expect(kmBetween(lat, lon, hyderabad.lat, hyderabad.lon)).toBeLessThan(6);
		}
		expect(kmBetween(arc![0][1], arc![0][0], hyderabad.lat, hyderabad.lon)).toBeGreaterThan(8);
		expect(kmBetween(arc![47][1], arc![47][0], hyderabad.lat, hyderabad.lon)).toBeGreaterThan(8);
	});

	it('returns null when the gate never opens', () => {
		const himalayas = Location.byId('himalayas');
		const high = new FlightTrack(himalayas.lat, himalayas.lon, 6000, 13_000, 1, 1.3);
		expect(threadArc(high, himalayas.lat, himalayas.lon, 6000, 1)).toBeNull();
	});

	it('is identical every visit — pure in track, place and speed', () => {
		const a = threadArc(cityTrack(), hyderabad.lat, hyderabad.lon, 400, 1);
		const b = threadArc(cityTrack(), hyderabad.lat, hyderabad.lon, 400, 1);
		expect(a).toEqual(b);
	});

	it('carries the mid-pass marker: the view sits on the arc', () => {
		const arc = threadArc(cityTrack(), hyderabad.lat, hyderabad.lon, 400, 1);
		const v = calculateCameraView(100, paramsFor('?place=hyderabad&speed=1'));
		const off = (lon: number, lat: number) =>
			Math.min(...arc!.map(([alon, alat]) => kmBetween(lat, lon, alat, alon)));
		// Same blend math both sides, so the marker misses the drawn path
		// by resampling distance only (~3 wall seconds between samples).
		expect(off(v.lon, v.lat)).toBeLessThan(0.5);
	});
});
