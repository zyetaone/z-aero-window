import { describe, it, expect } from 'vitest';
import { calculateCameraView, type CameraParams } from '#lib/display/flight/view.js';
import { Location } from '#lib/settings/locations.js';
import { blendViews } from '#lib/display/flight/view.js';

/**
 * The Stage RAF loop has no recovery: one NaN pose → `jumpTo` throws →
 * the map freezes at its init camera while the HUD keeps ticking (the
 * loops are separate). This sweep drives the full view pipeline across
 * every place, both directions, and a 48 h wall window, asserting every
 * field the map consumes stays finite. If this goes red, the kiosk goes
 * black — treat it accordingly.
 */
describe('camera view finiteness sweep (black-map guard)', () => {
	const places = Location.all();
	expect(places.length).toBeGreaterThan(0);

	it('every field stays finite for every place, direction, and sampled second', () => {
		const now = Math.floor(Date.now() / 1000);
		let checked = 0;
		for (const place of places) {
			for (const direction of [1, -1] as const) {
				for (let h = 0; h < 48; h += 3) {
					const wallSec = now + h * 3600;
					const params: CameraParams = {
						place,
						// Required params, mirrored from the app defaults —
						// omitting them NaNs the bearing, which is a test bug,
						// not a code bug (config always provides both).
						azimuthDeg: -90,
						pitchDeg: -10,
						floorM: place.climbFloorM,
						ceilingM: place.climbCeilingM,
						direction
					};
					const v = calculateCameraView(wallSec, params);
					for (const k of [
						'lat',
						'lon',
						'aglM',
						'planeHeadingDeg',
						'bankDeg',
						'cameraBearingDeg',
						'cameraPitchDeg',
						'targetLat',
						'targetLon',
						'distanceM',
						'timeOfDay',
						'wallSec'
					] as const) {
						expect(Number.isFinite(v[k]), `${place.id} dir=${direction} h=${h} field=${k}`).toBe(
							true
						);
					}
					checked++;
				}
			}
		}
		expect(checked).toBeGreaterThan(100);
	});

	it('blendViews stays finite across every place pair and blend instant', () => {
		const t = Math.floor(Date.now() / 1000);
		const views = places.map((place) =>
			calculateCameraView(t, {
				place,
				azimuthDeg: -90,
				pitchDeg: -10,
				floorM: place.climbFloorM,
				ceilingM: place.climbCeilingM,
				direction: 1
			})
		);
		// Blended longitude is normalized: the shortest-arc term can push
		// past ±180 mid-blend (a.lon + wrap*ease), and MapLibre wraps LngLat
		// on the way into jumpTo — so the contract is finite + wraps clean.
		const normLon = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
		for (let i = 0; i < views.length; i++) {
			for (let j = 0; j < views.length; j++) {
				for (const k of [0.001, 0.25, 0.5, 0.75, 0.999]) {
					const v = blendViews(views[i], views[j], k);
					expect(Number.isFinite(v.lat), `blend ${i}->${j} t=${k} lat`).toBe(true);
					expect(Number.isFinite(v.lon), `blend ${i}->${j} t=${k} lon`).toBe(true);
					expect(Number.isFinite(v.aglM), `blend ${i}->${j} t=${k} aglM`).toBe(true);
					expect(Math.abs(v.lat)).toBeLessThanOrEqual(90);
					expect(Math.abs(normLon(v.lon))).toBeLessThanOrEqual(180);
				}
			}
		}
	});
});
