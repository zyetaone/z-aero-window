import { describe, it, expect } from 'vitest';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { DWELL_SEC } from '#lib/display/flight/director.svelte.js';
import {
	DOWNTOWN_PASS_START_SEC,
	DOWNTOWN_PASS_END_SEC,
	DOWNTOWN_HANDOFF_SEC,
	DOWNTOWN_THREAD_MAX_AGL_M,
	DOWNTOWN_GATE_FADE_M,
	DOWNTOWN_TIME_WARP,
	DOWNTOWN_MIN_AGL_M,
	downtownAltM,
	downtownBlendAt,
	downtownPose,
	downtownWarpSec
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
		for (const s of [0, 10, 29, 271, 300, 500])
			expect(downtownBlendAt(s, LOW), `phase ${s}`).toBe(0);
		for (const s of [120, 150, 180]) expect(downtownBlendAt(s, LOW), `phase ${s}`).toBe(1);
	});

	it('ramps monotonically across both handoffs', () => {
		let prev = 0;
		for (let s = 30; s <= 120; s++) {
			const v = downtownBlendAt(s, LOW);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
		expect(prev).toBe(1);
		prev = 1;
		for (let s = 180; s <= 270; s++) {
			const v = downtownBlendAt(s, LOW);
			expect(v).toBeLessThanOrEqual(prev);
			prev = v;
		}
		expect(prev).toBe(0);
	});

	it('stands down above the thread ceiling and fades across the gate', () => {
		expect(downtownBlendAt(150, DOWNTOWN_THREAD_MAX_AGL_M + 1)).toBe(0);
		expect(downtownBlendAt(150, 11_000)).toBe(0);
		const mid = downtownBlendAt(150, DOWNTOWN_THREAD_MAX_AGL_M - DOWNTOWN_GATE_FADE_M / 2);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
		expect(downtownBlendAt(150, DOWNTOWN_THREAD_MAX_AGL_M - DOWNTOWN_GATE_FADE_M)).toBe(1);
		// Exact middle of the fade is exactly half open.
		expect(downtownBlendAt(150, DOWNTOWN_THREAD_MAX_AGL_M - DOWNTOWN_GATE_FADE_M / 2)).toBe(
			0.5
		);
		// The ceiling itself is shut, and fractional seconds blend like whole ones.
		expect(downtownBlendAt(150, DOWNTOWN_THREAD_MAX_AGL_M)).toBe(0);
		expect(downtownBlendAt(150.5, LOW)).toBe(1);
	});

	it('stands down on non-finite inputs rather than poisoning the view', () => {
		expect(downtownBlendAt(100, NaN)).toBe(0);
		expect(downtownBlendAt(NaN, LOW)).toBe(0);
		expect(downtownBlendAt(100, Infinity)).toBe(0);
	});

	it('sits inside the dwell with margin for arrival and departure', () => {
		expect(DOWNTOWN_PASS_START_SEC - DOWNTOWN_HANDOFF_SEC).toBeGreaterThan(10);
		expect(DOWNTOWN_PASS_END_SEC + DOWNTOWN_HANDOFF_SEC).toBeLessThan(DWELL_SEC);
	});
});

describe('downtownWarpSec', () => {
	it('is the flight clock before the pass and runs at the warp rate inside it', () => {
		expect(downtownWarpSec(20, 20)).toBe(20);
		const mid = (DOWNTOWN_PASS_START_SEC + DOWNTOWN_PASS_END_SEC) / 2;
		expect(downtownWarpSec(mid + 1, mid + 1) - downtownWarpSec(mid, mid)).toBeCloseTo(
			DOWNTOWN_TIME_WARP,
			6
		);
	});

	it('is strictly increasing — the thread never stops or runs backwards', () => {
		for (const speed of [1, 4]) {
			let prev = downtownWarpSec(0, 0, speed);
			for (let s = 0.5; s < 600; s += 0.5) {
				const v = downtownWarpSec(s * speed, s, speed);
				expect(v, `s=${s} speed=${speed}`).toBeGreaterThan(prev);
				prev = v;
			}
		}
	});

	it('stands down to the anchor on non-finite input', () => {
		expect(downtownWarpSec(NaN, 10)).toBe(DOWNTOWN_PASS_START_SEC);
		expect(downtownWarpSec(Infinity, 10)).toBe(DOWNTOWN_PASS_START_SEC);
	});

	it('circles the city mid-pass instead of hovering one suburb', () => {
		// speed=1 maps the wall second 1:1 onto climb and slot alike.
		const params = paramsFor('?place=hyderabad&speed=1');
		const place = Location.byId('hyderabad');
		const a = calculateCameraView(135, params);
		const b = calculateCameraView(165, params);
		// Both ends of the window are fully threaded (blend 1), 104 s
		// apart on the wall clock. Without the warp the small loop
		// inherits the big loop's angular rate and the two sit ~0.4 km
		// apart; warped 3x they measure 1.33 km — visibly different sides
		// of the downtown circle. Bounds are loose on purpose: `daySeed`
		// moves the arc around the ellipse every day, so this pins the
		// order of magnitude, not today's digits.
		const arc = kmBetween(a.lat, a.lon, b.lat, b.lon);
		expect(kmBetween(a.lat, a.lon, place.lat, place.lon)).toBeLessThan(6);
		expect(kmBetween(b.lat, b.lon, place.lat, place.lon)).toBeLessThan(6);
		expect(arc).toBeGreaterThan(0.4);
		expect(arc).toBeLessThan(2.5);
		for (const v of [a, b]) {
			expect(Number.isFinite(v.planeHeadingDeg)).toBe(true);
			expect(Number.isFinite(v.bankDeg)).toBe(true);
		}
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
		expect(p.aglM).toBe(DOWNTOWN_MIN_AGL_M);
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
		// A zeroed floor knob still threads at a sane altitude, not the runway.
		expect(downtownAltM(0)).toBe(DOWNTOWN_MIN_AGL_M);
	});
});

describe('downtown thread in the view', () => {
	it('brings a city visit within the building packs mid-pass', () => {
		const place = Location.byId('hyderabad');
		// speed=1 so the wall second maps 1:1 onto the climb: at 100 s the
		// climb is low (near the floor, gate open) and the slot phase is mid-pass.
		// At the default 4x the same second is high climb and the pass
		// correctly stands down — that is the gate test above, not this one.
		const v = calculateCameraView(150, paramsFor('?place=hyderabad&speed=1'));
		// The packs span ~5 km; the thread must get inside them, from 25+ km out.
		expect(kmBetween(v.lat, v.lon, place.lat, place.lon)).toBeLessThan(6);
		const thread = downtownAltM(place.climbFloorM);
		expect(v.aglM).toBeGreaterThan(thread - 10);
		expect(v.aglM).toBeLessThan(thread + 10);
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
		for (let s = 25; s <= 275; s++) {
			const v = calculateCameraView(s, params);
			for (const k of ['lat', 'lon', 'aglM', 'cameraPitchDeg', 'targetLat'] as const)
				expect(Number.isFinite(v[k]), `s=${s} ${k}`).toBe(true);
			// The handoff is a spiral, not a cut: one pose whose loop scale
			// follows the blend. Under 1 km per second is what keeps it
			// reading as an aircraft turning inward rather than a slide.
			if (s > 25) expect(kmBetween(v.lat, v.lon, prevLat, prevLon), `s=${s} jump`).toBeLessThan(1);
			prevLat = v.lat;
			prevLon = v.lon;
		}
	});

	it('is a pure function of the second', () => {
		const params = paramsFor('?place=dubai');
		expect(calculateCameraView(100, params)).toEqual(calculateCameraView(100, params));
	});
});

describe('downtown thread in production config', () => {
	/**
	 * The thread tests above pin `?speed=1` so the wall second maps 1:1 onto
	 * the climb. The kiosk flies at 4x, where the pass window (240 s slots)
	 * and the climb (900/4 = 225 s) beat against each other — so this asserts
	 * the beat actually lands: at wallSec 675 the slot phase is 75 (mid-pass,
	 * DWELL_SEC = 600) and the climb is at its floor (gate open).
	 */
	it('threads at default speed, not just at speed=1', () => {
		for (const id of ['hyderabad', 'denver']) {
			const place = Location.byId(id);
			const v = calculateCameraView(1350, paramsFor(`?place=${id}`));
			expect(kmBetween(v.lat, v.lon, place.lat, place.lon), `${id} off-thread`).toBeLessThan(
				6
			);
			// Climb is at its floor (9000 % 900 == 0 kills the wander taper
			// too), so the thread bottoms out at the thread altitude: 1,200
			// over Hyderabad, Denver's own 3,000 m floor.
			const want = downtownAltM(place.climbFloorM);
			expect(v.aglM, `${id} altitude ${v.aglM.toFixed(0)}m`).toBeGreaterThan(want - 50);
			expect(v.aglM, `${id} altitude ${v.aglM.toFixed(0)}m`).toBeLessThan(want + 500);
		}
	});

	/**
	 * The gate modulates the view, not just the unit: seconds 100 and 340
	 * share slot phase 100 (time fully in) but sit at opposite ends of the
	 * climb, so the same phase threads at one and flies the big loop at the
	 * other. Same time axis, different altitude axis — the two knobs the
	 * gate multiplies.
	 */
	it('gates the same phase open and shut by climb alone', () => {
		const place = Location.byId('hyderabad');
		const low = calculateCameraView(150, paramsFor('?place=hyderabad&speed=1'));
		const high = calculateCameraView(1350, paramsFor('?place=hyderabad&speed=1'));
		expect(kmBetween(low.lat, low.lon, place.lat, place.lon)).toBeLessThan(6);
		expect(low.aglM).toBeLessThan(downtownAltM(place.climbFloorM) + 100);
		expect(kmBetween(high.lat, high.lon, place.lat, place.lon)).toBeGreaterThan(20);
		expect(high.aglM).toBeGreaterThan(9000);
	});

	/**
	 * At 25x the whole flight is warp (orbit in under two minutes): the
	 * climb crosses the 500 m gate fade in about a second, so the thread
	 * slams open and shut and 1 s samples can sit 25 km apart. That is
	 * warp mode being warp mode — the math stays C0 continuous throughout,
	 * just steep — so the contract here is finiteness plus proof the gate
	 * still engages, not a speed limit. A step bound at 25x would be
	 * asserting aesthetics, not correctness.
	 */
	it('stays finite and engaged at warp speed', () => {
		const params = paramsFor('?place=denver&speed=25');
		const place = Location.byId('denver');
		let closest = Infinity;
		for (let s = 25; s <= 275; s++) {
			const v = calculateCameraView(s, params);
			for (const k of ['lat', 'lon', 'aglM', 'cameraPitchDeg'] as const)
				expect(Number.isFinite(v[k]), `s=${s} ${k}`).toBe(true);
			closest = Math.min(closest, kmBetween(v.lat, v.lon, place.lat, place.lon));
		}
		expect(closest, 'gate never engaged at 25x').toBeLessThan(6);
	});
});

describe('scheduledWeather', () => {
	it('is per slot, mostly clear, and identical for every pane', async () => {
		const { scheduledWeather } = await import('#lib/display/flight/view.js');
		const seen = new Map<string, number>();
		for (let slot = 0; slot < 600; slot++) {
			const w = scheduledWeather(slot * DWELL_SEC + 5);
			expect(scheduledWeather(slot * DWELL_SEC + DWELL_SEC - 5)).toBe(w);
			seen.set(w, (seen.get(w) ?? 0) + 1);
		}
		expect(seen.get('clear')! > 300).toBe(true);
		expect(seen.get('overcast')! > 50).toBe(true);
	});
});
