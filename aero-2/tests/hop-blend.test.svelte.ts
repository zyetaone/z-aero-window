import { describe, it, expect } from 'vitest';
import { AeroDisplay } from '#lib/display/display.svelte.js';
import { readSettings } from '#lib/settings/settings.svelte.js';
import { DWELL_SEC } from '#lib/display/flight/flight-path.js';

/**
 * The first frame after a rotation hop blends the old pose into the new
 * one. The old pose used to be computed from `{ ...config }`, which on a
 * runes class copies nothing, so azimuth and pitch were undefined and the
 * target went NaN — MapLibre threw and the page died on every hop. The
 * harness never saw it because a pinned `?place=` never crosses a boundary.
 */
describe('rotation hop', () => {
	it('keeps every camera number finite across a slot boundary', () => {
		const settings = readSettings(new URL('http://kiosk.local/'));
		const display = new AeroDisplay(settings);
		const boundary = DWELL_SEC * 2_983_217;
		const before = display.advanceTo(boundary - 1);
		const after = display.advanceTo(boundary + 0.5);
		expect(after.lat).not.toBe(before.lat);
		for (const v of [before, after]) {
			for (const k of ['lat', 'lon', 'targetLat', 'targetLon', 'aglM', 'planeHeadingDeg'] as const) {
				const n = (v as unknown as Record<string, number>)[k];
				expect(Number.isFinite(n), `${k}=${n}`).toBe(true);
			}
		}
	});
});
