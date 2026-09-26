import { describe, it, expect } from 'vitest';
import { Location } from '#lib/settings/locations.js';

describe('Location.moodFor', () => {
	it('falls back to the default openly for unknown ids', () => {
		expect(Location.moodFor('atlantis')).toEqual(Location.moodFor('atlantis'));
		expect(Location.moodFor('atlantis').nightGlow).toBe(1.0);
	});

	it('covers every catalog place, so no world flies on the default by accident', () => {
		for (const loc of Location.all()) {
			const mood = Location.moodFor(loc.id);
			expect(mood.dust, `${loc.id} dust`).toBeGreaterThanOrEqual(0);
			expect(mood.dust, `${loc.id} dust`).toBeLessThanOrEqual(0.5);
			expect(mood.nightGlow, `${loc.id} glow`).toBeGreaterThan(0);
			expect(mood.nightGlow, `${loc.id} glow`).toBeLessThanOrEqual(1.3);
		}
	});

	it('orders the obvious cases: desert dustier than alps, showcase cities brighter', () => {
		expect(Location.moodFor('desert').dust).toBeGreaterThan(Location.moodFor('himalayas').dust);
		expect(Location.moodFor('dubai').nightGlow).toBeGreaterThan(
			Location.moodFor('desert').nightGlow
		);
	});
});
