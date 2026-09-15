import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { DWELL_SEC } from '#lib/display/flight/director.svelte.js';
import {
	DOWNTOWN_PASS_START_SEC,
	DOWNTOWN_PASS_END_SEC,
	DOWNTOWN_HANDOFF_SEC,
	DOWNTOWN_THREAD_MAX_AGL_M,
	DOWNTOWN_GATE_FADE_M,
	downtownAltM,
	downtownBlendAt,
	downtownPose
} from '#lib/display/flight/downtown.js';
import { Location, readSettings } from '#lib/settings/settings.svelte.js';

const paramsFor = (search = '') => readSettings(new URL(`http://kiosk.local/${search}`));

/** Equirectangular km between two lat/lon points. */
function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (aLat - bLat) * 111.32;
	const dLon = (aLon - bLon) * 111.32 * Math.cos((bLat * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

describe('downtownBlendAt', () => {
	// Low climb throughout: the gate is open and only the time window shows.
	const LOW = 1200;

	it('is fully out outside the pass and fully in at mid-pass', () => {
		for (const s of [0, 10, 36, 174, 200, 239])
			expect(downtownBlendAt(s, LOW), `phase ${s}`).toBe(0);
		for (const s of [60, 100, 140]) expect(downtownBlendAt(s, LOW), `phase ${s}`).toBe(1);
	});

	it('ramps monotonically across both handoffs', () => {
		let prev = 0;
		for (let s = 37; s <= 53; s++) {
			const v = downtownBlendAt(s, LOW);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
		expect(prev).toBe(1);
		prev = 1;
		for (let s = 157; s <= 173; s++) {
			const v = downtownBlendAt(s, LOW);
			expect(v).toBeLessThanOrEqual(prev);
			prev = v;
		}
		expect(prev).toBe(0);
	});

	it('stands down above the thread ceiling and fades across the gate', () => {
		expect(downtownBlendAt(100, DOWNTOWN_THREAD_MAX_AGL_M + 1)).toBe(0);
		expect(downtownBlendAt(100, 11_000)).toBe(0);
		const mid = downtownBlendAt(100, DOWNTOWN_THREAD_MAX_AGL_M - DOWNTOWN_GATE_FADE_M / 2);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		expect(downtownBlendAt(100, DOWNTOWN_THREAD_MAX_AGL_M - DOWNTOWN_GATE_FADE_M)).toBe(1);
	});

	it('sits inside the dwell with margin for arrival and departure', () => {
		expect(DOWNTOWN_PASS_START_SEC - DOWNTOWN_HANDOFF_SEC).toBeGreaterThan(10);
		expect(DOWNTOWN_PASS_END_SEC + DOWNTOWN_HANDOFF_SEC).toBeLessThan(DWELL_SEC);
	});
});

describe('downtownPose', () => {
	it('shrinks the loop about the centre and drops to the thread altitude', () => {
		const p = downtownPose(
			{ lat: 18.0, lon: 79.0, headingDeg: 90, aglM: 9000, bankDeg: 10 },
			17.4435,
			78.3772,
			400
		);
		expect(kmBetween(p.lat, p.lon, 17.4435, 78.3772)).toBeLessThan(
			kmBetween(18.0, 79.0, 17.4435, 78.3772) * 0.1
		);
		expect(p.aglM).toBe(1200);
		expect(p.headingDeg).toBe(90);
		expect(p.bankDeg).toBe(10);
	});

	it('never threads below a place floor', () => {
		for (const place of Location.all())
			expect(downtownAltM(place.climbFloorM)).toBeGreaterThanOrEqual(place.climbFloorM);
		// The thread must stay in the buildings' full-render band — but only
		// cities thread. The Himalaya floor (6,000 m) is above it and never
		// threads, so it is covered by the floor bound above, not this one.
		for (const place of Location.cities())
			expect(downtownAltM(place.climbFloorM)).toBeLessThanOrEqual(5500);
	});
});

describe('downtown thread in the view', () => {
	it('brings a city visit within the building packs mid-pass', () => {
		const place = Location.byId('hyderabad');
		// speed=1 so the wall second maps 1:1 onto the climb: at 100 s the
		// climb is low (~1,800 m, gate open) and the slot phase is mid-pass.
		// At the default 4x the same second is high climb and the pass
		// correctly stands down — that is the gate test above, not this one.
		const v = calculateCameraView(100, paramsFor('?place=hyderabad&speed=1'));
		// The packs span ~5 km; the thread must get inside them, from 25+ km out.
		expect(kmBetween(v.lat, v.lon, place.lat, place.lon)).toBeLessThan(6);
		expect(v.aglM).toBeGreaterThan(1190);
		expect(v.aglM).toBeLessThan(1210);
	});

	it('is still on the big loop outside the pass', () => {
		const place = Location.byId('hyderabad');
		const v = calculateCameraView(0, paramsFor('?place=hyderabad'));
		expect(kmBetween(v.lat, v.lon, place.lat, place.lon)).toBeGreaterThan(20);
	});

	it('never threads features', () => {
		const place = Location.byId('himalayas');
		const v = calculateCameraView(100, paramsFor('?place=himalayas'));
		expect(kmBetween(v.lat, v.lon, place.lat, place.lon)).toBeGreaterThan(20);
		expect(v.aglM).toBeGreaterThanOrEqual(5999);
	});

	it('hands off continuously, never cutting', () => {
		const params = paramsFor('?place=denver');
		let prevLat = 0;
		let prevLon = 0;
		for (let s = 30; s <= 185; s++) {
			const v = calculateCameraView(s, params);
			for (const k of ['lat', 'lon', 'aglM', 'cameraPitchDeg', 'targetLat'] as const)
				expect(Number.isFinite(v[k]), `s=${s} ${k}`).toBe(true);
			// The handoff is a swoop, not a cut: ~25 km over a 16 s ease runs
			// ~2 km/s mid-ramp (87 m/frame at 60 fps — smooth), against an
			// arrival blend that warps whole time zones in 3.5 s. The bound
			// below outlaws teleporting, not moving fast.
			if (s > 30) expect(kmBetween(v.lat, v.lon, prevLat, prevLon), `s=${s} jump`).toBeLessThan(8);
			prevLat = v.lat;
			prevLon = v.lon;
		}
	});

	it('is a pure function of the second', () => {
		const params = paramsFor('?place=dubai');
		expect(calculateCameraView(100, params)).toEqual(calculateCameraView(100, params));
	});
});
