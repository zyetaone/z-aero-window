import { describe, it, expect } from 'vitest';
import { destinationAt, rotationSeedFor } from '#lib/display/flight/director.svelte.js';
import { Location, LOCATIONS } from '#lib/settings/locations.js';
import { SENTINEL2_PLACES, WATER_PLACES } from '#lib/settings/tiles.js';

describe('every location is actually reachable', () => {
	/**
	 * A catalog entry with floor above ceiling would fly the whole visit pinned
	 * to the ceiling, silently discarding the floor — and the floor is the bound
	 * that "must clear local peaks". `PaneSettings.orderClimbBand` repairs an
	 * inverted band arriving from a URL or a slider, but `setPlace` assigns these
	 * two straight from the catalog, so a bad entry here is not covered by it.
	 */
	it('declares a climb band the right way up', () => {
		for (const l of LOCATIONS) {
			expect(l.climbFloorM, `${l.id} floor above ceiling`).toBeLessThanOrEqual(l.climbCeilingM);
		}
	});

	it('has the whole catalogue in the rotation pool', () => {
		expect(LOCATIONS.map((l) => l.id).sort()).toEqual(Location.CATALOG.map((l) => l.id).sort());
	});

	it('visits all 11 within one day of slots', () => {
		const seen = new Set<string>();
		const seed = rotationSeedFor(1_770_000_000);
		// DWELL_SEC slots across a day, sampled densely enough to cover the cycle.
		for (let s = 0; s < 4000; s++) {
			seen.add(destinationAt(1_770_000_000 + s * 60, seed).id);
		}
		const missing = LOCATIONS.map((l) => l.id).filter((id) => !seen.has(id));
		expect(missing, `never visited: ${missing.join(', ')}`).toEqual([]);
	});

	it('splits the catalogue into cities and features with nothing lost', () => {
		const cities = Location.cities().map((l) => l.id);
		const features = Location.features().map((l) => l.id);
		expect([...cities, ...features].sort()).toEqual(LOCATIONS.map((l) => l.id).sort());
	});

	it('reports which locations lack a sharp basemap or water mask', () => {
		const noS2 = LOCATIONS.filter((l) => !SENTINEL2_PLACES.has(l.id)).map((l) => l.id);
		const noWater = LOCATIONS.filter((l) => !WATER_PLACES.has(l.id)).map((l) => l.id);
		// eslint-disable-next-line no-console
		console.log('  no sentinel2:', noS2.join(', ') || '(none)');
		// eslint-disable-next-line no-console
		console.log('  no water    :', noWater.join(', ') || '(none)');
		expect(noS2.length).toBeLessThanOrEqual(2);
	});
});
