import { describe, it, expect } from 'vitest';
import {
	SENTINEL2_PLACES,
	SENTINEL2_Z14_PLACES,
	TILE_MAXZOOM,
	sentinel2MaxZoom
} from '#lib/settings/tiles.js';

describe('sentinel2MaxZoom', () => {
	it('unlocks z14 where the manifest packs it', () => {
		expect(sentinel2MaxZoom('mumbai')).toBe(14);
		expect(sentinel2MaxZoom('dubai')).toBe(14);
	});

	it('holds the global cap everywhere else', () => {
		expect(sentinel2MaxZoom('hyderabad')).toBe(TILE_MAXZOOM.sentinel2);
		expect(sentinel2MaxZoom('denver')).toBe(TILE_MAXZOOM.sentinel2);
		expect(sentinel2MaxZoom('ocean')).toBe(TILE_MAXZOOM.sentinel2);
	});

	it('falls back to the cap on missing input', () => {
		expect(sentinel2MaxZoom(null)).toBe(TILE_MAXZOOM.sentinel2);
		expect(sentinel2MaxZoom(undefined)).toBe(TILE_MAXZOOM.sentinel2);
		expect(sentinel2MaxZoom('')).toBe(TILE_MAXZOOM.sentinel2);
	});

	it('keeps the z14 set inside the packed set', () => {
		// A name here with no pack behind it is a 404 storm, not sharper ground.
		for (const id of SENTINEL2_Z14_PLACES) {
			expect(SENTINEL2_PLACES.has(id)).toBe(true);
		}
	});
});
