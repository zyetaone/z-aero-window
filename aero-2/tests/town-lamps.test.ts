import { describe, it, expect } from 'vitest';
import { pixelLat, pixelLon, townIntensity } from '../tools/extract-town-lamps.mjs';
import { lonLatToTile } from '../tools/stamp-road-glow.mjs';

describe('townIntensity', () => {
	it('is zero below the town threshold and full at saturation', () => {
		expect(townIntensity(0)).toBe(0);
		expect(townIntensity(0.24)).toBe(0);
		expect(townIntensity(0.25)).toBe(0);
		expect(townIntensity(1)).toBe(1);
	});

	it('rises monotonically between threshold and saturation', () => {
		const dim = townIntensity(0.4);
		const mid = townIntensity(0.7);
		expect(dim).toBeGreaterThan(0);
		expect(dim).toBeLessThan(mid);
		expect(mid).toBeLessThan(1);
	});
});

describe('pixelLon/pixelLat', () => {
	it('invert the slippy forward math exactly', () => {
		const z = 7;
		const lon = -104.99;
		const lat = 39.75;
		const gx = ((lon + 180) / 360) * 256 * 2 ** z;
		const latRad = (lat * Math.PI) / 180;
		const gy =
			((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
			256 *
			2 ** z;
		expect(pixelLon(gx, z)).toBeCloseTo(lon, 9);
		expect(pixelLat(gy, z)).toBeCloseTo(lat, 9);
		// And the inverted point sits inside the tile the stamp names.
		const [tx, ty] = lonLatToTile(lon, lat, z);
		expect(Math.floor(gx / 256)).toBe(tx);
		expect(Math.floor(gy / 256)).toBe(ty);
	});

	it('spans the world edges', () => {
		expect(pixelLon(0, 1)).toBe(-180);
		expect(pixelLon(512, 1)).toBe(180);
	});
});
