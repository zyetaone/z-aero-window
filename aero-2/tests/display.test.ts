import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	ORBIT,
	ORBIT_PERIOD_SEC,
	BREATHE_PERIOD_SEC,
	FlightTrack,
	daySeed,
	CLIMB_PERIOD_SEC
} from '#lib/display/flight/flight-path.js';
import {
	calculateCameraView,
	FlightCamera,
	WEATHERS,
	WORLD_ROLL_GAIN
} from '#lib/display/flight/view.js';
import { resolveAtmosphere, weatherLightLoss, cloudedRgb } from '#lib/display/world/atmosphere.js';
import { slotNoise, phaseFor } from '#lib/display/flight/flight-path.js';
import {
	resolveLocalHours,
	nightAmount,
	sunPosition,
	duskHorizonMix,
	duskVaultMix,
	facingSunAmount,
	specularGlint
} from '#lib/display/world/sun.js';
import { ATMOSPHERE_BANDS } from '#lib/display/world/atmosphere.js';
import { ALTITUDE_CEILING_M, ALTITUDE_FLOOR_M } from '#lib/display/flight/flight-path.js';
import { Location, readSettings } from '#lib/settings/settings.svelte.js';

/** Signed shortest difference between two bearings, -180..180. */
function normalizeSigned(deg: number): number {
	return ((((deg + 180) % 360) + 360) % 360) - 180;
}

const paramsFor = (search = '') => readSettings(new URL(`http://kiosk.local/${search}`));

/**
 * The altitude at which band `index` applies exactly — the middle of its span.
 *
 * This used to hunt for a spot clear of a 200 m blend zone, because the
 * resolver held each band flat and blended only at the edges. It no longer
 * does: the curve is interpolated between band anchors across the whole
 * climb, and the anchor IS the midpoint.
 */
function coreAltitude(index: number): number {
	const floor = index === 0 ? 0 : ATMOSPHERE_BANDS[index - 1].topM;
	const ceil = ATMOSPHERE_BANDS[index].topM;
	return Number.isFinite(ceil) ? (floor + ceil) / 2 : 13_000;
}

// ── URL Knobs & Param Parsing ────────────────────────────────────────────────

describe('readSettings', () => {
	it('defaults to Hyderabad, the fielded kiosk home', () => {
		expect(paramsFor().place.id).toBe('hyderabad');
		expect(paramsFor('?place=denver').place.id).toBe('denver');
	});

	it('falls back on an unknown place rather than throwing', () => {
		expect(paramsFor('?place=atlantis').place.id).toBe('hyderabad');
	});

	it('reads azimuth & pitch overrides', () => {
		const p = paramsFor('?azimuth=45&pitch=-30');
		expect(p.azimuthDeg).toBe(45);
		expect(p.pitchDeg).toBe(-30);
	});

	/**
	 * The non-flight display modes have to be reachable from a URL.
	 *
	 * `?mode=` existed while the thing it displays did not, so `?mode=video`
	 * could only ever play a hardcoded default — which is a large part of why
	 * nobody noticed the CSP was blocking all three modes outright. A feature
	 * you cannot point at a file is a feature nobody exercises.
	 */
	it('takes the media playlist from the URL', () => {
		const p = paramsFor('?mode=screensaver&media=/a.webp,/b.webp');
		expect(p.displayMode).toBe('screensaver');
		expect(p.screensaverUrls).toEqual(['/a.webp', '/b.webp']);
		// Both lists, because a pane is in one mode at a time and two lists
		// that must not disagree is one list.
		expect(p.videoPlaylist).toEqual(['/a.webp', '/b.webp']);
		expect(p.videoUrl).toBe('/a.webp');
	});

	it('ignores blanks and stray whitespace in the media list', () => {
		// `?media=a,,b` and a trailing comma are what a hand-typed operator URL
		// actually looks like; an empty string would render as a broken element.
		const p = paramsFor('?media=%20/a.webp%20,,/b.webp,');
		expect(p.screensaverUrls).toEqual(['/a.webp', '/b.webp']);
	});

	/**
	 * Media ships EMPTY, and that is load-bearing.
	 *
	 * The defaults pointed at commondatastorage.googleapis.com,
	 * images.unsplash.com and actions.google.com -- third-party CDNs, on a
	 * device whose premise is that it works with no internet, and every one of
	 * them blocked by the CSP. The result was a feature that was 100% broken
	 * out of the box while LOOKING configured. Empty renders "No media
	 * specified", which is the truth.
	 */
	it('ships no remote media defaults', () => {
		const p = paramsFor();
		expect(p.videoUrl).toBe('');
		expect(p.videoPlaylist).toEqual([]);
		expect(p.screensaverUrls).toEqual([]);
		expect(p.audioPlaylist).toEqual([]);
	});

	/**
	 * Audio needs its own param for the same reason video did.
	 *
	 * `?media=` was added first and covers video and the slideshow; the cabin
	 * audio playlist stayed unreachable from a URL, which is exactly the state
	 * that let the CSP silence it unnoticed. Verified end to end afterwards
	 * against a real served .wav, cross-origin, both with and without
	 * AERO_MEDIA_ORIGINS.
	 */
	it('takes the audio playlist from the URL and switches to playlist mode', () => {
		const p = paramsFor('?audio=/rain.ogg,/wind.ogg');
		expect(p.audioPlaylist).toEqual(['/rain.ogg', '/wind.ogg']);
		expect(p.audioTrackIndex).toBe(0);
		// A URL naming files with the mode still on `synth` is two switches for
		// one intent, and the files would never be heard.
		expect(p.audioMode).toBe('playlist');
		expect(p.audioEnabled).toBe(true);
	});

	it('leaves audio on synth when the param names no usable track', () => {
		// `?audio=` with nothing in it must not enable a playlist of nothing:
		// that swaps working synth rumble for silence.
		const p = paramsFor('?audio=');
		expect(p.audioPlaylist).toEqual([]);
		expect(p.audioMode).toBe('synth');
		expect(p.audioEnabled).toBe(false);
	});

	/**
	 * Changing place must carry everything the place DEFINES with it.
	 *
	 * The climb envelope is the case with teeth: Mumbai's 500 m floor following
	 * you to Denver puts the camera inside the Front Range. This has regressed
	 * four times, every time because a caller set place and forgot a sibling
	 * field — hence one gate, and this test on it.
	 */
	it('carries floor and ceiling across a place change', () => {
		const s = paramsFor('?place=denver');

		s.setPlace(Location.hyderabad());
		expect(s.floorM).toBe(Location.hyderabad().climbFloorM);
		expect(s.ceilingM).toBe(Location.hyderabad().climbCeilingM);

		s.setPlace(Location.denver());
		expect(s.floorM).toBe(Location.denver().climbFloorM);
		expect(s.ceilingM).toBe(Location.denver().climbCeilingM);
	});
});

// ── Flight Pose & Determinism ────────────────────────────────────────────────

describe('Flight Pose', () => {
	it('produces finite, in-range numbers', () => {
		const v = calculateCameraView(1_787_650_000, paramsFor());
		expect(Number.isFinite(v.lat)).toBe(true);
		expect(Number.isFinite(v.lon)).toBe(true);
		expect(Number.isFinite(v.aglM)).toBe(true);
		expect(v.aglM).toBeGreaterThanOrEqual(ALTITUDE_FLOOR_M);
		expect(v.aglM).toBeLessThanOrEqual(ALTITUDE_CEILING_M);
	});

	it('is deterministic across repeat calls with identical wall-clock time', () => {
		const t = 1_787_650_123.456;
		const p = paramsFor();
		const a = calculateCameraView(t, p);
		const b = calculateCameraView(t, p);
		expect(a).toEqual(b);
	});

	/**
	 * Three panes render from three processes whose animation frames are not in
	 * phase, so "deterministic off the wall clock" is only worth something if the
	 * derivation is insensitive to a few milliseconds. Turbulence runs at ~3.5 Hz,
	 * an order of magnitude faster than anything else here, and it feeds bankDeg —
	 * which tilts the horizon across one continuous panorama.
	 *
	 * Before the fix, 8 ms of frame offset was 0.18 rad of phase at 22.3 rad/s and
	 * the three panes disagreed outright. Negative control: drop the grid rounding
	 * in atmosphericTurbulence and this fails at the storm intensity.
	 */
	it('gives three out-of-phase panes the same pose, storm included', () => {
		const t = 1_787_650_000.0;
		const p = paramsFor('?weather=storm');

		// One RAF period spread across the three panes, worst case.
		for (const skewSec of [0.008, 0.016]) {
			const a = calculateCameraView(t, p);
			const b = calculateCameraView(t + skewSec, p);
			expect(Math.abs(b.bankDeg - a.bankDeg), `bank diverged at ${skewSec}s skew`).toBeLessThan(
				0.05
			);
			expect(Math.abs(b.cameraPitchDeg - a.cameraPitchDeg)).toBeLessThan(0.05);
			// The pose itself legitimately advances over 16 ms; the turbulence term
			// is the part that must not, so assert on it directly.
			expect(b.turbulence).toEqual(a.turbulence);
		}
	});

	/**
	 * The view layer may perturb the pose; it may not overrule the climb envelope.
	 * A `Math.max(10, ...)` floor here would sit below every location's
	 * climbFloorM — the lowest in the catalog is 300 m.
	 */
	it('keeps altitude inside the climb envelope under the worst turbulence', () => {
		const p = paramsFor('?weather=storm');
		for (let s = 0; s < CLIMB_PERIOD_SEC; s += 97) {
			const v = calculateCameraView(s, p);
			expect(v.aglM).toBeGreaterThan(ALTITUDE_FLOOR_M * 0.9);
			expect(v.aglM).toBeLessThan(ALTITUDE_CEILING_M * 1.1);
		}
	});

	it('tiles into a continuous window across three pan yaw offsets', () => {
		const t = 1_787_650_000;
		const left = calculateCameraView(t, paramsFor('?azimuth=-120'));
		const center = calculateCameraView(t, paramsFor('?azimuth=-90'));
		const right = calculateCameraView(t, paramsFor('?azimuth=-60'));

		expect(left.lat).toBe(center.lat);
		expect(left.lon).toBe(center.lon);
		expect(left.aglM).toBe(center.aglM);
		expect(left.cameraBearingDeg).toBeCloseTo((center.cameraBearingDeg - 30 + 360) % 360, 5);
		expect(right.cameraBearingDeg).toBeCloseTo((center.cameraBearingDeg + 30) % 360, 5);
	});

	it('visits all altitude bands during the climb cycle', () => {
		const visitedBands = new Set<string>();
		const p = paramsFor();
		for (let s = 0; s < CLIMB_PERIOD_SEC; s += 10) {
			const v = calculateCameraView(s, p);
			const atmo = resolveAtmosphere(v.aglM);
			visitedBands.add(atmo.bandId);
		}
		expect(visitedBands.size).toBe(ATMOSPHERE_BANDS.length);
	});
});

// ── Atmosphere & Night Curves ────────────────────────────────────────────────

describe('resolveAtmosphere', () => {
	it('hits each band exactly at its anchor', () => {
		ATMOSPHERE_BANDS.forEach((band, i) => {
			const s = resolveAtmosphere(coreAltitude(i));
			expect(s.bandId).toBe(band.id);
			expect(s.fogDensity).toBeCloseTo(band.fogDensity, 12);
		});
	});

	it('is continuous with smooth transitions across climb', () => {
		const STEP = 5;
		let prev = resolveAtmosphere(0);
		for (let alt = STEP; alt <= 15_000; alt += STEP) {
			const s = resolveAtmosphere(alt);
			expect(Math.abs(s.fogDensity - prev.fogDensity)).toBeLessThan(1e-5);
			prev = s;
		}
	});

	/**
	 * The bug this replaced: values were held FLAT across each band and blended
	 * only over a 200 m boundary, so across a 0-13,000 m climb the atmosphere
	 * was constant for 11,400 m and changed over 1,600 m. 88% plateau, four
	 * cliffs, and that is what read as banding out of the window.
	 *
	 * Guarding the SHAPE, not a value: most of the climb must actually move the
	 * sky, and no single 200 m step may carry a large share of the total change.
	 */
	it('changes across most of the climb, in no single step', () => {
		const STEP = 200;
		const TOP = 13_000;
		let moving = 0;
		let steps = 0;
		let biggest = 0;
		let total = 0;
		let prev = resolveAtmosphere(0);

		for (let alt = STEP; alt <= TOP; alt += STEP) {
			const s = resolveAtmosphere(alt);
			const d = Math.abs(s.fogDensity - prev.fogDensity);
			if (d > 1e-9) moving++;
			biggest = Math.max(biggest, d);
			total += d;
			steps++;
			prev = s;
		}

		// Was 12% before; a continuous curve moves on essentially every step.
		expect(moving / steps).toBeGreaterThan(0.9);
		// Was ~23% of all change in one 200 m step.
		expect(biggest / total).toBeLessThan(0.1);
	});

	it('darkens sky monotonically with altitude', () => {
		const alts = ATMOSPHERE_BANDS.map((_, i) => coreAltitude(i));
		const luma = alts.map((a) => {
			const [r, g, b] = resolveAtmosphere(a).skyTop;
			return r + g + b;
		});
		for (let i = 1; i < luma.length; i++) expect(luma[i]).toBeLessThan(luma[i - 1]);
	});
});

/**
 * These replace tests on `nightFactor(timeOfDay)`, which hardcoded the dusk
 * ramp to 17:30-21:00 and knew nothing about latitude or season. The clock
 * cannot tell you how dark it is: at Mumbai 19:41 that curve said 0.68 while
 * the sun was 20 degrees below the horizon, and at Chicago in December it said
 * 0 -- full daylight -- more than an hour after sunset.
 */
describe('nightAmount', () => {
	it('is full day with the sun up and full night once it is well down', () => {
		expect(nightAmount(60)).toBe(0);
		expect(nightAmount(-30)).toBe(1);
	});

	it('is dark when the sun is 20 degrees below the horizon, whatever the hour', () => {
		// The case the clock-based curve got wrong: it returned 0.68 here.
		expect(nightAmount(-20)).toBe(1);
	});

	it('ramps smoothly through twilight', () => {
		const midDusk = nightAmount(-3);
		expect(midDusk).toBeGreaterThan(0.3);
		expect(midDusk).toBeLessThan(0.8);
	});

	it('never brightens as the sun drops', () => {
		let prev = -Infinity;
		for (let e = 60; e >= -30; e--) {
			const v = nightAmount(e);
			expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
			prev = v;
		}
	});
});

// ── Solar position ───────────────────────────────────────────────────────────

describe('sunPosition', () => {
	// Hyderabad, and a wall-clock second chosen to land on local noon there.
	const HYD_LAT = 17.385;
	const HYD_OFFSET = 5.5;
	/** UTC seconds for a date at 12:00 local (06:30 UTC) in Hyderabad. */
	const localNoon = (isoDate: string) => Date.parse(`${isoDate}T06:30:00Z`) / 1000;

	it('puts the sun high and roughly south at local noon in June', () => {
		// Northern-hemisphere summer: sun is north of the zenith at this latitude,
		// so the bearing swings past 180. Elevation is what matters here.
		const { elevationDeg } = sunPosition(localNoon('2026-06-21'), HYD_LAT, HYD_OFFSET);
		expect(elevationDeg).toBeGreaterThan(80);
	});

	it('is below the horizon at local midnight', () => {
		const midnight = Date.parse('2026-06-21T18:30:00Z') / 1000;
		expect(sunPosition(midnight, HYD_LAT, HYD_OFFSET).elevationDeg).toBeLessThan(0);
	});

	it('rises in the east and sets in the west', () => {
		const day = '2026-03-21';
		const morning = Date.parse(`${day}T03:00:00Z`) / 1000; // 08:30 local
		const evening = Date.parse(`${day}T11:30:00Z`) / 1000; // 17:00 local
		expect(sunPosition(morning, HYD_LAT, HYD_OFFSET).azimuthDeg).toBeLessThan(180);
		expect(sunPosition(evening, HYD_LAT, HYD_OFFSET).azimuthDeg).toBeGreaterThan(180);
	});

	it('is deterministic — the same second gives the same sun', () => {
		// Three Pis derive the sun independently; if this drifts, the panorama
		// seam shows two different shadow directions.
		const t = localNoon('2026-01-15');
		expect(sunPosition(t, HYD_LAT, HYD_OFFSET)).toEqual(sunPosition(t, HYD_LAT, HYD_OFFSET));
	});
});

// ── Minimap ground track ─────────────────────────────────────────────────────

describe('groundTrack', () => {
	it('closes the ring so the drawn loop has no seam', () => {
		const ring = new FlightTrack(17.385, 78.4867).groundTrack();
		expect(ring.length).toBeGreaterThan(3);
		expect(ring[0]).toEqual(ring[ring.length - 1]);
	});

	it('stays within the orbit extent around the place', () => {
		const lat = 17.385;
		const lon = 78.4867;
		// majorMax 0.25 deg north-south; east-west is aspect x that, then
		// widened again by 1/cos(lat).
		const maxLon = (0.25 * ORBIT.aspect) / Math.cos((lat * Math.PI) / 180) + 0.02;
		for (const [x, y] of new FlightTrack(lat, lon).groundTrack()) {
			expect(Math.abs(y - lat)).toBeLessThan(0.27);
			expect(Math.abs(x - lon)).toBeLessThan(maxLon);
		}
	});

	it('traces the path actually flown, not a re-derived ellipse', () => {
		// Each sample must equal poseAt at the same instant, or the drawn loop
		// and the flown loop can drift apart without anything failing.
		const hyd = new FlightTrack(17.385, 78.4867);
		const ring = hyd.groundTrack(0, 8);
		for (let i = 0; i < 8; i++) {
			const p = hyd.poseAt((i / 8) * ORBIT_PERIOD_SEC);
			expect(ring[i][0]).toBeCloseTo(p.lon, 10);
			expect(ring[i][1]).toBeCloseTo(p.lat, 10);
		}
	});

	it('is deterministic, so three panes draw the same loop', () => {
		const den = () => new FlightTrack(39.7392, -104.9903).groundTrack();
		expect(den()).toEqual(den());
	});
});

describe('orbit shape', () => {
	it('breathes a whole number of times per circuit, so the loop closes', () => {
		expect(Number.isInteger(ORBIT.petals)).toBe(true);
		expect(BREATHE_PERIOD_SEC * ORBIT.petals).toBeCloseTo(ORBIT_PERIOD_SEC, 6);
	});

	it('returns to its own start after one period', () => {
		// The real seam test: not that we appended point 0, but that the maths
		// actually comes back. A non-integer petal count fails this.
		const hyd = new FlightTrack(17.385, 78.4867);
		const a = hyd.poseAt(0);
		const b = hyd.poseAt(ORBIT_PERIOD_SEC);
		expect(b.lat).toBeCloseTo(a.lat, 9);
		expect(b.lon).toBeCloseTo(a.lon, 9);
	});

	it('reads as an ellipse, not a flower', () => {
		// Radius swing stays gentle. At 3x it looked like a spirograph.
		expect(ORBIT.majorMax / ORBIT.majorMin).toBeLessThan(1.6);
	});
});

describe('flight direction', () => {
	it('reversing mirrors the path, so the loop is flown the other way', () => {
		const fwd = new FlightTrack(17.385, 78.4867);
		const rev = fwd.reversed();
		const t = 400;
		const a = fwd.poseAt(t);
		const b = rev.poseAt(t);
		// theta is negated. dLat is a sine of theta so it mirrors; dLon is a
		// cosine so it is unchanged. Same ground track, walked the other way.
		expect(b.lat - 17.385).toBeCloseTo(-(a.lat - 17.385), 9);
		expect(b.lon - 78.4867).toBeCloseTo(a.lon - 78.4867, 9);
	});

	it('heading follows the reversed velocity, not the forward one', () => {
		const fwd = new FlightTrack(17.385, 78.4867);
		const rev = fwd.reversed();
		// A plane flying the same loop backwards must not report the same heading.
		expect(rev.poseAt(400).headingDeg).not.toBeCloseTo(fwd.poseAt(400).headingDeg, 3);
	});

	it('reversing twice returns the original direction', () => {
		expect(new FlightTrack(1, 2).reversed().reversed().direction).toBe(1);
	});
});

describe('orbit shape is an ellipse with gentle bumps', () => {
	it('is wider than it is tall', () => {
		expect(ORBIT.aspect).toBeGreaterThan(1);
	});

	it('breathes only slightly, so it reads as an orbit not a flower', () => {
		expect(ORBIT.majorMax / ORBIT.majorMin).toBeLessThan(1.2);
	});

	it('climbs and descends rather than holding one altitude', () => {
		const t = new FlightTrack(17.385, 78.4867);
		const alts = Array.from({ length: 40 }, (_, i) => t.altitudeAt((i / 40) * CLIMB_PERIOD_SEC));
		expect(Math.max(...alts) - Math.min(...alts)).toBeGreaterThan(5_000);
	});
});

describe('the window looks at the city', () => {
	/**
	 * The camera bearing used to be `planeHeading + azimuth`, a fixed offset off
	 * the nose. On an ellipse that points INWARD on one side of the loop and
	 * OUTWARD on the other, so for half of every circuit the window showed empty
	 * countryside instead of the city it is supposed to be flying around.
	 */
	it('keeps the target near the city for the whole orbit', () => {
		const place = Location.hyderabad();
		const params = {
			place,
			azimuthDeg: 0,
			pitchDeg: -18,
			floorM: place.climbFloorM,
			ceilingM: place.climbCeilingM
		};

		let worst = 0;
		for (let i = 0; i < 60; i++) {
			const v = calculateCameraView((i / 60) * ORBIT_PERIOD_SEC, params);
			const dLat = v.targetLat - place.lat;
			const dLon = (v.targetLon - place.lon) * Math.cos(place.lat * (Math.PI / 180));
			worst = Math.max(worst, Math.hypot(dLat, dLon));
		}
		// The honest comparison is against the old behaviour, not a bare number:
		// the same sweep aimed 90 deg off the nose. Inward aiming must keep the
		// target markedly closer to the city than heading-relative aiming did.
		let worstOffNose = 0;
		for (let i = 0; i < 60; i++) {
			const wallSec = (i / 60) * ORBIT_PERIOD_SEC;
			const pose = new FlightTrack(
				place.lat,
				place.lon,
				place.climbFloorM,
				place.climbCeilingM
			).poseAt(wallSec);
			const cam = new FlightCamera(90, -18).viewOptions(pose); // no centre => off-nose
			const dLat = cam.targetLat - place.lat;
			const dLon = (cam.targetLon - place.lon) * Math.cos(place.lat * (Math.PI / 180));
			worstOffNose = Math.max(worstOffNose, Math.hypot(dLat, dLon));
		}
		expect(worst).toBeLessThan(worstOffNose);
	});

	it('aims across the orbit, not along the aircraft nose', () => {
		const place = Location.hyderabad();
		const v = calculateCameraView(400, {
			place,
			azimuthDeg: 0,
			pitchDeg: -18,
			floorM: place.climbFloorM,
			ceilingM: place.climbCeilingM
		});
		// The plane's own heading is tangential; the camera should not match it.
		const diff = Math.abs(v.cameraBearingDeg - v.planeHeadingDeg);
		expect(Math.min(diff, 360 - diff)).toBeGreaterThan(30);
	});
});

describe('banking', () => {
	const track = (dir: 1 | -1 = 1) => new FlightTrack(17.385, 78.4867, 400, 13_000, dir);

	it('banks INTO the turn both ways round, never outward', () => {
		// The inside wing drops whichever direction the loop is flown. Reversing
		// mirrors the sign; it must not produce "outward" bank on one leg.
		const fwd = track(1);
		const rev = track(-1);
		for (let i = 1; i < 12; i++) {
			const t = (i / 12) * ORBIT_PERIOD_SEC;
			expect(Math.sign(fwd.poseAt(t).bankDeg)).not.toBe(Math.sign(rev.poseAt(t).bankDeg));
		}
	});

	/**
	 * WHICH wing drops — the half of the question the test above cannot see.
	 *
	 * That one asserts the two directions disagree, which is true of a correct
	 * sign AND of an inverted one. `bankAt` was inverted, so the aircraft banked
	 * AWAY from every turn, and this suite was green on it under a heading that
	 * says "banks INTO the turn". A test named for a property it does not test
	 * is worse than no test: it is why nobody looked.
	 *
	 * The check owes nothing to any bearing convention, which is where the bug
	 * came from — `headingAt` is a COMPASS bearing and increases clockwise, so
	 * a left turn gives a negative rate, and the old `-norm` flipped that into
	 * right-wing-down. Instead take the 2D cross product of successive velocity
	 * vectors along the real ground track: positive is counterclockwise, i.e. a
	 * left turn, which must drop the LEFT wing (negative by this file's
	 * convention).
	 */
	it('drops the wing on the INSIDE of the turn', () => {
		for (const dir of [1, -1] as const) {
			const t = track(dir);
			const cosLat = Math.cos((17.385 * Math.PI) / 180);
			for (let i = 1; i < 16; i++) {
				const s = (i / 16) * ORBIT_PERIOD_SEC;
				const p0 = t.positionAt(s - 10);
				const p1 = t.positionAt(s);
				const p2 = t.positionAt(s + 10);
				const v1 = [(p1.lon - p0.lon) * cosLat, p1.lat - p0.lat];
				const v2 = [(p2.lon - p1.lon) * cosLat, p2.lat - p1.lat];
				// z of the cross product: > 0 is a counterclockwise (left) turn.
				const cross = v1[0] * v2[1] - v1[1] * v2[0];
				const bank = t.bankAt(s);
				if (Math.abs(cross) < 1e-12 || Math.abs(bank) < 0.05) continue;
				expect(
					Math.sign(bank),
					`dir=${dir} t=${Math.round(s)} turning ${cross > 0 ? 'left' : 'right'} with ` +
						`${bank < 0 ? 'left' : 'right'} wing down — banking away from the turn`
				).toBe(cross > 0 ? -1 : 1);
			}
		}
	});

	/**
	 * Heading must agree with where the aircraft actually goes next.
	 *
	 * The old analytic velocity divided the east component by cosLat and then
	 * multiplied by metres-per-degree at the equator, applying the meridian
	 * convergence twice, and treated the ellipse radii as constants when both
	 * breathe with time and wobble with theta. Reported heading was out by a
	 * mean of 6-8 degrees and a peak of 27 at Chicago -- so the window looked
	 * sideways of the direction of travel, worse the further from the equator.
	 *
	 * Checked at three latitudes because the error scaled with cosLat and would
	 * have been easy to miss at Hyderabad alone.
	 */
	it('reports the heading the ground track actually flies', () => {
		for (const [name, lat, lon] of [
			['hyderabad', 17.385, 78.4867],
			['denver', 39.8561, -104.6737],
			['chicago', 41.7868, -87.7522]
		] as const) {
			const t = new FlightTrack(lat, lon, 400, 13_000, 1);
			const cosLat = Math.cos((lat * Math.PI) / 180);

			for (let i = 0; i < 60; i++) {
				const s = (i / 60) * ORBIT_PERIOD_SEC;
				const before = t.positionAt(s - 5);
				const after = t.positionAt(s + 5);
				const truth =
					(Math.atan2((after.lon - before.lon) * cosLat, after.lat - before.lat) * 180) / Math.PI;
				const err = Math.abs(normalizeSigned(t.headingAt(s) - truth));
				expect(
					err,
					`${name} heading off by ${err.toFixed(1)} deg at t=${s.toFixed(0)}`
				).toBeLessThan(1);
			}
		}
	});

	/**
	 * This used to compare `bankAt(PI/2)` against `bankAt(0)` and assert the
	 * first was larger, on a comment claiming the tight turns sit at +-PI/2.
	 * They do not. `aspect` is 1.7 and multiplies the EAST radius, so east is
	 * the major axis and its ends -- theta 0 and PI -- are the sharp ones. The
	 * old closed form had `a` paired with sin in the curvature denominator,
	 * which is the ellipse rotated ninety degrees, and the test was written to
	 * agree with it. Both were wrong together, so the suite stayed green while
	 * the wing dropped hardest on the straight sections.
	 *
	 * Comparing against the MEASURED heading rate cannot be wrong in the same
	 * direction as the implementation, because it shares none of its reasoning
	 * about which axis is which.
	 */
	it('rolls most where the heading is actually turning fastest', () => {
		const t = track();
		const turnRate = (s: number) =>
			Math.abs(normalizeSigned(t.headingAt(s + 1) - t.headingAt(s - 1)));

		let sharp = 0;
		let gentle = 0;
		for (let i = 0; i < 120; i++) {
			const s = (i / 120) * ORBIT_PERIOD_SEC;
			if (turnRate(s) > turnRate(sharp)) sharp = s;
			if (turnRate(s) < turnRate(gentle)) gentle = s;
		}

		expect(Math.abs(t.bankAt(sharp))).toBeGreaterThan(Math.abs(t.bankAt(gentle)));
	});

	it('stays within a comfortable roll', () => {
		const t = track();
		for (let i = 0; i < 80; i++) {
			expect(Math.abs(t.poseAt((i / 80) * ORBIT_PERIOD_SEC).bankDeg)).toBeLessThanOrEqual(
				ORBIT.maxBankDeg + 1e-9
			);
		}
	});
});

describe('altitude profile', () => {
	it('rises and falls rather than holding one height', () => {
		// Seen as a section through the path, the loop must have hills.
		const t = new FlightTrack(17.385, 78.4867, 400, 13_000);
		const alts = Array.from({ length: 60 }, (_, i) => t.altitudeAt((i / 60) * CLIMB_PERIOD_SEC));
		expect(Math.max(...alts) - Math.min(...alts)).toBeGreaterThan(10_000);
		// and it is smooth: no step between neighbouring samples
		for (let i = 1; i < alts.length; i++) {
			expect(Math.abs(alts[i] - alts[i - 1])).toBeLessThan(1_500);
		}
	});
});

describe('daySeed', () => {
	it('is stable within a day, so three panes fly the same orbit', () => {
		const place = Location.hyderabad();
		const now = Date.UTC(2026, 7, 25, 9, 0, 0);
		const later = Date.UTC(2026, 7, 25, 21, 30, 0);
		expect(daySeed(place, now)).toBe(daySeed(place, later));
	});

	it('changes between days, so the orbit is not pinned forever', () => {
		const place = Location.hyderabad();
		expect(daySeed(place, Date.UTC(2026, 7, 25))).not.toBe(daySeed(place, Date.UTC(2026, 7, 26)));
	});

	it('differs by place', () => {
		const now = Date.UTC(2026, 7, 25);
		expect(daySeed(Location.hyderabad(), now)).not.toBe(daySeed(Location.denver(), now));
	});

	it('is a unit interval', () => {
		for (let d = 0; d < 40; d++) {
			const v = daySeed(Location.denver(), Date.UTC(2026, 0, 1) + d * 86_400_000);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe('elevation strip normalisation', () => {
	/**
	 * The minimap's altitude dot is placed by normalising AGL into 0..1 and the
	 * curve behind it is drawn from the same cosine. If the dot normalises
	 * against the GLOBAL altitude constants while the aircraft actually flies
	 * the PLACE's envelope, the two disagree — and only on places whose envelope
	 * differs from the constants. Hyderabad (400..13000) matches them exactly,
	 * so the bug is invisible there and obvious over Denver (3000..13000).
	 */
	const stripY = (norm: number, h = 24) => h - norm * (h - 4) - 2;

	/**
	 * The strip must be sampled from `altitudeAt`, the same function the dot's
	 * height comes from — NOT from a hand-drawn cosine.
	 *
	 * It used to be a cosine, and that was fine while the climb WAS a cosine.
	 * It no longer is: the profile carries a seeded wander (see
	 * ORBIT.altitudeWanderFrac) so no two days fly the same climb. A cosine
	 * strip therefore draws a curve the aircraft does not fly, and the dot sits
	 * beside it — the same "drawn from different parameters than the flight"
	 * defect as the orbit ring and its phase.
	 *
	 * The second assertion is the one with teeth: it proves the wander is big
	 * enough to matter, so this test cannot quietly pass if the wander is
	 * removed and the strip silently reverts to a cosine.
	 */
	it('draws the strip from the flown altitude, not from a cosine', () => {
		for (const place of [Location.hyderabad(), Location.denver()]) {
			const track = new FlightTrack(place.lat, place.lon, place.climbFloorM, place.climbCeilingM);
			let worstAgainstCosine = 0;

			for (let i = 0; i <= 40; i++) {
				const phase = i / 40;
				const agl = track.altitudeAt(phase * CLIMB_PERIOD_SEC);

				// The wander must never breach the envelope it wanders inside.
				expect(agl).toBeGreaterThanOrEqual(place.climbFloorM);
				expect(agl).toBeLessThanOrEqual(place.climbCeilingM);

				const norm = (agl - place.climbFloorM) / (place.climbCeilingM - place.climbFloorM);
				const cosineNorm = (1 - Math.cos(phase * Math.PI * 2)) * 0.5;
				worstAgainstCosine = Math.max(
					worstAgainstCosine,
					Math.abs(stripY(norm) - stripY(cosineNorm))
				);
			}

			expect(worstAgainstCosine).toBeGreaterThan(0.5);
		}
	});

	it('would drift if normalised against the global constants', () => {
		// Guards the fix by demonstrating the bug it replaced.
		const place = Location.denver();
		const track = new FlightTrack(place.lat, place.lon, place.climbFloorM, place.climbCeilingM);
		const agl = track.altitudeAt(0);
		const wrong = (agl - ALTITUDE_FLOOR_M) / (ALTITUDE_CEILING_M - ALTITUDE_FLOOR_M);
		const right = (agl - place.climbFloorM) / (place.climbCeilingM - place.climbFloorM);
		expect(Math.abs(stripY(wrong) - stripY(right))).toBeGreaterThan(1);
	});
});

describe('MiniMap track', () => {
	const place = Location.hyderabad();
	const M_PER_DEG_LAT = 111_320;

	/** Worst distance, in metres, from any pose on `flown` to the nearest point of `ring`. */
	function worstGapM(flown: FlightTrack, ring: [number, number][]): number {
		const cosLat = Math.cos((place.lat * Math.PI) / 180);
		let worst = 0;
		for (let i = 0; i < 180; i++) {
			const pose = flown.poseAt((i / 180) * ORBIT_PERIOD_SEC);
			let best = Infinity;
			for (const [lon, lat] of ring) {
				const dy = (lat - pose.lat) * M_PER_DEG_LAT;
				const dx = (lon - pose.lon) * M_PER_DEG_LAT * cosLat;
				best = Math.min(best, Math.hypot(dx, dy));
			}
			worst = Math.max(worst, best);
		}
		return worst;
	}

	/**
	 * The minimap must draw the track it actually flies.
	 *
	 * `phase` is not decoration. It is added to `theta`, while the ellipse's
	 * breathing radius is keyed to raw wallSec — so it shifts where the three
	 * radius bumps land RELATIVE to the angle, changing the SHAPE flown rather
	 * than merely rotating it. The minimap built its ring without phase while
	 * the marker came from the real view, so the aircraft flew beside its own
	 * drawn track. The second assertion is the bug: it must stay large, or the
	 * first assertion proves nothing.
	 */
	/**
	 * The phase is a function of the SECOND, not of when a pane last changed
	 * place. It used to be assigned in `setPlace` from a bare `Date.now()`, so
	 * two panes that rotated either side of UTC midnight -- 05:30 in Hyderabad,
	 * with the wall running -- picked different days, and therefore different
	 * orbits, until the next rotation. `daySeed` also lost its `Date.now()`
	 * default, so no caller can silently reintroduce process time.
	 */
	it('derives the phase from the wall second, not from when the place was set', () => {
		const midnight = 1_767_225_600; // a UTC day boundary
		expect(phaseFor(place, midnight - 0.001)).toBe(phaseFor(place, midnight - 0.001));
		expect(phaseFor(place, midnight + 0.001)).not.toBe(phaseFor(place, midnight - 0.001));
		// ...and the whole day either side of it is one value.
		expect(phaseFor(place, midnight + 3600)).toBe(phaseFor(place, midnight + 40_000));
	});

	it('needs the same phase as the flight, or the marker leaves the ring', () => {
		const phase = phaseFor(place, 1_767_000_000);
		const args = [place.lat, place.lon, place.climbFloorM, place.climbCeilingM, 1] as const;
		const flown = new FlightTrack(...args, phase);

		expect(worstGapM(flown, flown.groundTrack())).toBeLessThan(500);
		expect(worstGapM(flown, new FlightTrack(...args).groundTrack())).toBeGreaterThan(2_000);
	});
});

describe('timezone offsets follow DST', () => {
	/**
	 * `utcOffset` was a field assigned in the constructor, and CATALOG is a
	 * static built once at module load — so the offset froze in whatever DST
	 * state the process started in. A kiosk booted in January would still report
	 * -07:00 for Denver in July, putting the sun an hour out until someone
	 * restarted it. Six of the eleven locations shift across DST.
	 */
	it('reports the offset for now, not for process start', () => {
		const denver = Location.byId('denver');
		const july = Date.UTC(2026, 6, 1);
		const january = Date.UTC(2026, 0, 15);

		const spy = vi.spyOn(Date, 'now');

		spy.mockReturnValue(july);
		const summer = denver.utcOffset;

		spy.mockReturnValue(january);
		const winter = denver.utcOffset;

		spy.mockRestore();

		expect(summer).toBe(-6); // MDT
		expect(winter).toBe(-7); // MST
	});

	it('leaves zones without DST alone', () => {
		const hyd = Location.byId('hyderabad');
		const spy = vi.spyOn(Date, 'now');
		spy.mockReturnValue(Date.UTC(2026, 6, 1));
		const summer = hyd.utcOffset;
		spy.mockReturnValue(Date.UTC(2026, 0, 15));
		const winter = hyd.utcOffset;
		spy.mockRestore();
		expect(summer).toBe(5.5);
		expect(winter).toBe(5.5);
	});

	it('derives every catalog offset from its IANA zone', () => {
		for (const place of Location.all()) {
			expect(Number.isFinite(place.utcOffset), place.id).toBe(true);
			expect(Math.abs(place.utcOffset), place.id).toBeLessThanOrEqual(14);
		}
	});
});

describe('feature locations are crossed, not orbited', () => {
	/**
	 * The Himalayas, open ocean and open desert have no centre worth looking at.
	 * Aiming inward — correct over a city, where the orbit centre is the skyline
	 * — would stare at one arbitrary patch of ground for the whole 49-minute
	 * loop. They aim along the track instead.
	 */
	const paramsFor = (place: Location) => ({
		place,
		azimuthDeg: 0,
		pitchDeg: -18,
		floorM: place.climbFloorM,
		ceilingM: place.climbCeilingM
	});

	it('classifies terrain as feature and places as city', () => {
		for (const id of ['himalayas', 'ocean', 'desert']) {
			expect(Location.byId(id).isFeature, id).toBe(true);
		}
		for (const id of ['hyderabad', 'denver', 'mumbai', 'dubai']) {
			expect(Location.byId(id).isFeature, id).toBe(false);
		}
	});

	it('every catalog entry is one kind or the other', () => {
		expect(Location.cities().length + Location.features().length).toBe(Location.all().length);
		expect(Location.features().length).toBe(3);
	});

	it('a city keeps its centre in frame; a feature does not fixate', () => {
		const city = Location.byId('denver');
		const feature = Location.byId('ocean');

		const spread = (place: Location) => {
			const targets: [number, number][] = [];
			for (let i = 0; i < 48; i++) {
				const v = calculateCameraView((i / 48) * ORBIT_PERIOD_SEC, paramsFor(place));
				targets.push([v.targetLon, v.targetLat]);
			}
			// How far the aim point wanders, relative to the place itself.
			const cos = Math.cos(place.lat * (Math.PI / 180));
			return Math.max(...targets.map(([x, y]) => Math.hypot((x - place.lon) * cos, y - place.lat)));
		};

		// The city's aim stays near its centre; the feature's sweeps much wider,
		// because it follows the aircraft's heading around the loop.
		expect(spread(feature)).toBeGreaterThan(spread(city));
	});

	it('a feature aims off the nose, a city aims across the orbit', () => {
		const off = (place: Location) => {
			const v = calculateCameraView(400, paramsFor(place));
			const d = Math.abs(v.cameraBearingDeg - v.planeHeadingDeg);
			return Math.min(d, 360 - d);
		};
		// Heading-relative aim is a fixed 90 deg off the nose by construction.
		expect(off(Location.byId('ocean'))).toBeCloseTo(90, 0);
		// Inward aim is not tied to the nose, so it differs.
		expect(Math.abs(off(Location.byId('denver')) - 90)).toBeGreaterThan(1);
	});
});

describe('atmosphere reads as altitude, not constant haze', () => {
	/**
	 * The Sky maps a band's `fogDensity` to MapLibre's `fog-ground-blend`. That
	 * mapping was `clamp(density * 2400, 0.65, 0.95)`, and the FLOOR did almost
	 * all the work: ground multiplied out to 0.24, haze 0.60, cirrus 0.48 and
	 * stratosphere 0.19 — all below 0.65, so all pinned to the same value. Only
	 * midDeck ever rose above it. The window sat in near-constant haze at every
	 * altitude, which is exactly the symptom of a band model that cannot be seen.
	 *
	 * This asserts the SHAPE the Sky depends on, at the band level: the bands
	 * must span a real range, and thin out above the deck.
	 */
	const byId = (id: string) => {
		const band = ATMOSPHERE_BANDS.find((b) => b.id === id);
		if (!band) throw new Error(`no band ${id}`);
		return band;
	};

	it('is clearest at ground and in the stratosphere, thickest at the deck', () => {
		const ground = byId('ground').fogDensity;
		const deck = byId('midDeck').fogDensity;
		const strato = byId('stratosphere').fogDensity;

		expect(deck).toBeGreaterThan(ground);
		expect(deck).toBeGreaterThan(strato);
		// and the top of the sky is the clearest air of all
		expect(strato).toBeLessThanOrEqual(ground);
	});

	it('spans enough range to be visible once mapped', () => {
		const densities = ATMOSPHERE_BANDS.map((b) => b.fogDensity);
		const min = Math.min(...densities);
		const max = Math.max(...densities);
		// A 5x spread. If this collapses, every altitude looks the same again.
		expect(max / min).toBeGreaterThan(3);
	});

	it('thins out again above the cloud deck', () => {
		// Climbing THROUGH the deck must clear, not keep thickening.
		expect(byId('cirrus').fogDensity).toBeLessThan(byId('midDeck').fogDensity);
		expect(byId('stratosphere').fogDensity).toBeLessThan(byId('cirrus').fogDensity);
	});
});

describe('sky colour', () => {
	/**
	 * The horizon's sunset mix was `(15 - elev) / 15`. That is not symmetric
	 * about the horizon and does not reach zero until the sun is 15 deg up —
	 * mid-morning. At 10 deg it still mixed 33% of a deep orange into a blue
	 * horizon, and #d96b2e over #99b8db gives #ae9ea2: grey-pink mud where a
	 * clear morning sky belongs.
	 */
	it('keeps sunset colour near the horizon, not into mid-morning', () => {
		expect(duskHorizonMix(-6)).toBeCloseTo(1, 2); // below the horizon: full
		expect(duskHorizonMix(0)).toBeGreaterThan(0.6); // at sunrise: strong
		expect(duskHorizonMix(10)).toBe(0); // mid-morning: none
		expect(duskHorizonMix(60)).toBe(0); // noon: none
	});

	it('dims the vault symmetrically at dawn and dusk', () => {
		// The sun 6 deg below the horizon looks the same going up or down.
		expect(duskVaultMix(-6)).toBeCloseTo(duskVaultMix(6), 6);
		expect(duskVaultMix(60)).toBe(0);
	});

	it('eases rather than ramping linearly', () => {
		// A linear ramp has a constant slope; an eased one is slowest at the ends.
		const midSlope = duskHorizonMix(1) - duskHorizonMix(3);
		const endSlope = duskHorizonMix(6) - duskHorizonMix(8);
		expect(midSlope).toBeGreaterThan(endSlope);
	});

	/**
	 * The version of this test that this replaces swept from -12 upward and
	 * asserted the value never rises. That is only true of a curve with no
	 * lower bound -- it was pinning the bug, not the behaviour. Past the peak
	 * the glow must fall off in BOTH directions: a sunset band needs a sun
	 * somewhere near the horizon to cast it.
	 */
	it('falls off monotonically above the peak, as the sun climbs', () => {
		let prev = duskHorizonMix(-5);
		for (let e = -4; e <= 20; e++) {
			const v = duskHorizonMix(e);
			expect(v).toBeLessThanOrEqual(prev + 1e-9);
			prev = v;
		}
	});

	it('leaves the horizon once the sun is far enough below it', () => {
		// 1.0 at -18 and 1.0 at -56 put a warm sunset band under a field of
		// stars at local midnight. Observed over the Sahara at 00:16.
		expect(duskHorizonMix(-18)).toBe(0);
		expect(duskHorizonMix(-56)).toBe(0);
		expect(duskHorizonMix(-12)).toBeLessThan(duskHorizonMix(-6));
	});
});

describe('mean ground elevation is not a terrain clearance', () => {
	/**
	 * `place.groundElevationM` is one number for a whole region. Measured against
	 * the real terrarium DEM across each orbit (+-0.3 deg at z9), mean + floor
	 * sits BELOW the local peak at five of the eleven locations — Las Vegas by
	 * 2072 m, Dubai by 1119 m, Mumbai by 990 m.
	 *
	 * The MapLibre camera is safe because it asks the renderer for the ground
	 * under the aircraft and uses the mean only as a floor. This test exists so
	 * that if anyone reverts to `aglM + groundElevationM`, or writes a second
	 * engine that does — the deleted Cesium bridge did — the reason is on record
	 * rather than rediscovered from a screenshot of a hillside.
	 */
	it('records the locations where mean + floor is below real terrain', () => {
		// Peaks measured from the DEM, not looked up — see the commit for method.
		const measuredPeakM: Record<string, number> = {
			mumbai: 1500,
			dubai: 1724,
			las_vegas: 3592,
			phoenix: 2373,
			ocean: 1213
		};

		for (const [id, peak] of Object.entries(measuredPeakM)) {
			const place = Location.byId(id);
			const meanBased = place.groundElevationM + place.climbFloorM;
			expect(meanBased, `${id}: mean+floor should be known-unsafe`).toBeLessThan(peak);
		}
	});

	it('the places we call high-terrain do clear their own peaks', () => {
		// Denver and the Himalayas carry floors chosen for exactly this.
		const denver = Location.byId('denver');
		expect(denver.groundElevationM + denver.climbFloorM).toBeGreaterThan(3284);

		const him = Location.byId('himalayas');
		expect(him.groundElevationM + him.climbFloorM).toBeGreaterThan(8704);
	});
});

describe('slotNoise keeps three panes in step', () => {
	/**
	 * Lightning used to schedule itself with `4000 + Math.random() * 9000`, so
	 * each pane rolled its own delay and the three windows flashed at three
	 * different moments. On one continuous window that reads as a fault rather
	 * than as weather — the same failure the director had before it moved to a
	 * wall-clock slot index.
	 */
	it('gives the same value for the same slot, every time', () => {
		for (const slot of [0, 1, 42, 999_999]) {
			expect(slotNoise(slot)).toBe(slotNoise(slot));
		}
	});

	it('differs between slots, so it does not look periodic', () => {
		const vals = new Set(Array.from({ length: 200 }, (_, i) => slotNoise(i)));
		expect(vals.size).toBeGreaterThan(190);
	});

	it('is a unit interval', () => {
		for (let i = 0; i < 500; i++) {
			const v = slotNoise(i);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('salts independently, so two effects do not fire together', () => {
		const a = Array.from({ length: 50 }, (_, i) => slotNoise(i, 0));
		const b = Array.from({ length: 50 }, (_, i) => slotNoise(i, 1));
		expect(a).not.toEqual(b);
	});

	it('spreads roughly evenly, so strikes are not clustered', () => {
		const buckets = new Array(10).fill(0);
		for (let i = 0; i < 10_000; i++) buckets[Math.floor(slotNoise(i) * 10)]++;
		for (const b of buckets) {
			expect(b).toBeGreaterThan(700); // uniform would be 1000
			expect(b).toBeLessThan(1300);
		}
	});
});

describe('the sightline stays below the horizon through a turn', () => {
	/**
	 * Bank used to be added to pitch in DEGREES, and the numbers hid how bad
	 * that was. Peak bank is 18 deg at BANK_VIEW_GAIN 0.85, so the offset swings
	 * +/-15.3 deg against a default pitch of -10 — every turn drove the
	 * effective pitch positive, the camera asked to look UP, and the 0.5 deg
	 * depression clamp caught it. The sightline was pinned at that clamp for
	 * 28.6% of every roll cycle: not moving at all, for a quarter of each turn.
	 *
	 * Because depression and range are related by a tangent, the cost showed up
	 * as distance rather than as angle. At 4,500 m AGL the look-at point ran
	 * from 10 km at the bottom of the roll to 516 km at the top — past the
	 * horizon, over ground no tile pack covers — so the window panned from a
	 * city block to half a continent and back, every turn. That is the single
	 * biggest reason the output did not read as an aeroplane window.
	 *
	 * This asserts the PROPERTY rather than the formula: whatever the bank, the
	 * camera looks down, is not sitting on its own clamp, and the range stays
	 * within a believable band. A future re-tune is free to change the curve and
	 * must not reintroduce a sightline that crosses the horizon.
	 */
	const sweep = (pitchDeg: number) => {
		const out: { dep: number; km: number }[] = [];
		for (let i = 0; i < 360; i++) {
			const bankDeg = 18 * Math.sin((2 * Math.PI * i) / 360);
			const cam = new FlightCamera(0, pitchDeg).viewOptions(
				{ lat: 40, lon: -105, headingDeg: 90, aglM: 4500, bankDeg },
				40,
				-105
			);
			const dep = 90 - cam.cameraPitchDeg;
			out.push({ dep, km: 4500 / Math.tan((dep * Math.PI) / 180) / 1000 });
		}
		return out;
	};

	it('never pins the depression clamp, at any bank angle', () => {
		for (const pitch of [-4, -10, -20, -45]) {
			const pinned = sweep(pitch).filter((s) => s.dep <= 0.51).length;
			expect(pinned, `pitch ${pitch} sits on the 0.5deg clamp`).toBe(0);
		}
	});

	it('keeps the look-at range within one order of magnitude', () => {
		const km = sweep(-10).map((s) => s.km);
		const ratio = Math.max(...km) / Math.min(...km);
		// Was ~50x. A real window holds a roughly constant slant range while the
		// ground rotates past it; some swing is the bank being legible.
		expect(ratio, `look-at range swings ${ratio.toFixed(1)}x across a turn`).toBeLessThan(10);
		expect(Math.max(...km), 'looking past the packed tile radius').toBeLessThan(200);
	});

	/**
	 * Depression and range are related by a tangent, so at a FIXED depression
	 * the look-at point runs away with altitude: the 4 deg shallow end sits
	 * 64 km out at 4,500 m but 186 km out at the 13,000 m ceiling — past the
	 * packed near box the manifests promise (~72 km half-width), aiming the
	 * camera at ground with no sharp tiles. The depression floor scales with
	 * altitude (LOOKAT_MAX_GROUND_DIST_M) so the target stays inside the
	 * pack however high the climb goes, while low-altitude aiming is
	 * untouched: at 4,500 m the floor is 3.7 deg, below anything flown.
	 */
	const sweepAlt = (pitchDeg: number, aglM: number) => {
		const out: { dep: number; km: number }[] = [];
		for (let i = 0; i < 360; i++) {
			const bankDeg = 18 * Math.sin((2 * Math.PI * i) / 360);
			const cam = new FlightCamera(0, pitchDeg).viewOptions(
				{ lat: 40, lon: -105, headingDeg: 90, aglM, bankDeg },
				40,
				-105
			);
			const dep = 90 - cam.cameraPitchDeg;
			out.push({ dep, km: aglM / Math.tan((dep * Math.PI) / 180) / 1000 });
		}
		return out;
	};

	it('holds the look-at point inside packed imagery at altitude', () => {
		for (const aglM of [9_000, 12_000, 13_000]) {
			const rows = sweepAlt(-10, aglM);
			const max = Math.max(...rows.map((r) => r.km));
			// 70 km by construction, plus float dust on the tan/atan round-trip.
			expect(max, `agl ${aglM}m looks ${max.toFixed(1)}km out`).toBeLessThan(70.01);
			for (const r of rows) expect(r.dep).toBeGreaterThan(0);
		}
	});

	it('leaves low-altitude aiming alone', () => {
		const rows = sweepAlt(-10, 4_500);
		const minDep = Math.min(...rows.map((r) => r.dep));
		// The bank swing still bottoms out at its own 4 deg, not on the
		// altitude floor (3.7 deg here) — the cap must not reshape the view
		// it was not built to fix.
		expect(minDep, `shallow end now ${minDep.toFixed(2)}deg`).toBeGreaterThan(3.99);
		expect(minDep, `shallow end now ${minDep.toFixed(2)}deg`).toBeLessThan(4.01);
		expect(Math.max(...rows.map((r) => r.km))).toBeLessThan(70);
	});

	it('always looks DOWN, never at or above the horizon', () => {
		for (const pitch of [-1, -10, -30]) {
			for (const s of sweep(pitch)) expect(s.dep).toBeGreaterThan(0);
		}
	});
});

describe('weather changes the light, not just the glass', () => {
	/**
	 * `weather` reached the window in exactly two places: turbulence, and
	 * droplets on the glass. So a storm was a shaky window with rain on it over
	 * SUNLIT ground under a BLUE sky — every photometric property identical to
	 * `clear`. From a cabin window that is the wrong way round: you cannot see
	 * the turbulence and the droplets are a few pixels, while the thing you
	 * cannot miss is that the world has gone grey and flat.
	 *
	 * One scalar drives dimming, flattening and desaturation across the four
	 * components that consume it, so the sky cannot disagree with the ground
	 * about the weather.
	 */
	it('loses light monotonically from clear to storm', () => {
		const seq = WEATHERS.map((w) => weatherLightLoss(w));
		expect(seq[0]).toBe(0);
		for (let i = 1; i < seq.length; i++) {
			expect(
				seq[i],
				`${WEATHERS[i]} does not lose more light than ${WEATHERS[i - 1]}`
			).toBeGreaterThan(seq[i - 1]);
		}
		expect(seq[seq.length - 1]).toBeLessThan(1);
	});

	it('an unknown weather is clear, never a crash or a black window', () => {
		expect(weatherLightLoss('typo')).toBe(0);
	});

	/**
	 * The cloud tint must be RELATIVE to the light it replaces.
	 *
	 * The first version used a fixed grey, which is the natural way to write it
	 * and is measurably wrong: it is used as fog, fog thickens with the weather,
	 * so at storm strength the constant became most of the lower frame —
	 * brighter than the night scene it was meant to be dimming. With the clock
	 * frozen so the sun could not move between samples, a storm rendered 32%
	 * BRIGHTER than a clear sky. A cloud layer can only ever take light away.
	 */
	it('never brightens the colour it clouds, at any time of day', () => {
		const luma = (c: readonly [number, number, number]) =>
			0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
		const samples: [number, number, number][] = [
			[0.75, 0.82, 0.9], // bright day horizon
			[0.35, 0.55, 0.85], // day vault
			[0.03, 0.06, 0.14], // night horizon
			[0.01, 0.02, 0.06] // deep night
		];
		for (const c of samples) {
			let prev = luma(c);
			for (const loss of [0, 0.14, 0.52, 0.68, 0.85]) {
				const out = luma(cloudedRgb(c, loss));
				expect(out, `clouding ${JSON.stringify(c)} at ${loss} added light`).toBeLessThanOrEqual(
					prev + 1e-9
				);
				prev = out;
			}
		}
	});

	it('desaturates toward grey rather than toward a colour cast', () => {
		const c: [number, number, number] = [0.8, 0.5, 0.2];
		const spread = (v: readonly [number, number, number]) => Math.max(...v) - Math.min(...v);
		expect(spread(cloudedRgb(c, 0.85))).toBeLessThan(spread(c) * 0.5);
	});
});

describe('water glint is specular, not a wash', () => {
	/**
	 * The mask exists because MapLibre draws a PHOTOGRAPH of water while Cesium
	 * drew a SURFACE, which is why v1 shimmered and this reads flat. A grade
	 * cannot recover that — it operates on a still image — so the fix is a
	 * specular layer, and a specular layer is only worth having if it behaves
	 * specularly.
	 *
	 * These pin the geometry rather than the constant: bright when the sun is
	 * LOW and the window is pointed at it, gone at a high sun or facing away.
	 * That is what makes a lake a mirror at 18:00 and a grey sheet at noon, and
	 * it is also what makes the layer worth its bytes on a three-Pi wall — the
	 * panes point different ways, so one can be looking across a blazing lake
	 * while another sees the same water dark.
	 */
	it('peaks looking into a low sun', () => {
		expect(specularGlint(90, 90, 5)).toBeGreaterThan(0.8);
	});

	it('is zero facing away, whatever the elevation', () => {
		for (const elev of [1, 5, 15, 30, 60]) {
			expect(specularGlint(0, 180, elev), `elev ${elev} glinted facing away`).toBe(0);
		}
	});

	it('fades out as the sun climbs, and is gone by 40 deg', () => {
		const low = specularGlint(90, 90, 5);
		const mid = specularGlint(90, 90, 20);
		const high = specularGlint(90, 90, 45);
		expect(mid).toBeLessThan(low);
		expect(high).toBe(0);
	});

	/** Below the horizon there is no sun to reflect. */
	it('is zero at night', () => {
		for (const elev of [-0.1, -6, -18, -40]) {
			expect(specularGlint(90, 90, elev)).toBe(0);
		}
	});

	it('is continuous across the bearing sweep — no seam on a panorama', () => {
		let prev = specularGlint(0, 90, 10);
		for (let b = 1; b <= 360; b++) {
			const g = specularGlint(b, 90, 10);
			expect(Math.abs(g - prev), `jump at bearing ${b}`).toBeLessThan(0.05);
			prev = g;
		}
	});

	/**
	 * `facingSunAmount` is shared with the sunward haze in `Sky.svelte`. Two
	 * components deriving the same specular geometry from the same two angles is
	 * how a sheen and a haze end up disagreeing about where the sun is, which on
	 * one continuous window reads as a seam.
	 */
	it('agrees with the haze about which way the sun is', () => {
		for (const [bearing, az] of [
			[0, 0],
			[45, 90],
			[180, 10],
			[270, 275]
		]) {
			const facing = facingSunAmount(bearing, az);
			const glint = specularGlint(bearing, az, 0.0001);
			expect(Math.abs(glint - facing), `bearing ${bearing} az ${az}`).toBeLessThan(1e-3);
		}
	});
});

describe('the wing is attached to the aircraft', () => {
	/**
	 * THE MISMATCH. Bank reached the world only as a pitch offset, so the
	 * horizon stayed dead level through every turn while the sightline dipped
	 * and lifted. The wing meanwhile rolled by its aeroelastic FLEX term alone —
	 * `bank * 0.04`, which is 0.72 deg at a full 18 deg bank, against roughly
	 * 6 deg of camera depression. A wing that barely moves while the view swings
	 * reads as pasted onto the glass, and that is the loudest tell that this is
	 * a map rather than a window.
	 *
	 * `Sky.svelte` had already reasoned this out and deferred it, on the
	 * grounds that bank was "already spent on pitch". Both now apply: pitch
	 * (which reveals ground on the inside of a turn) and roll at
	 * WORLD_ROLL_GAIN.
	 */
	it('rolls the world by a real fraction of the bank, not a token amount', () => {
		expect(WORLD_ROLL_GAIN).toBeGreaterThan(0.2);
		expect(WORLD_ROLL_GAIN, 'a full-gain horizon shows the frame corners').toBeLessThanOrEqual(1);
		// The old flex-only coupling was 0.04. Anything near it is the bug back.
		expect(WORLD_ROLL_GAIN).toBeGreaterThan(0.04 * 4);
	});

	/**
	 * ONE home for the gain. Two renderers read it — the MapLibre camera rolls
	 * the world, the Three wing counter-rotates to stay fixed to the airframe —
	 * and a copy in each drifts the moment someone tunes one. The symptom, a
	 * wing sliding against its own horizon through a turn, is subtle enough to
	 * survive review, which is exactly why this is asserted rather than trusted.
	 */
	it('both renderers read the gain from flight/view, not their own copy', () => {
		for (const file of [
			'src/lib/display/world/Stage.svelte',
			'src/lib/display/cabin/Wing.svelte'
		]) {
			const src = readFileSync(file, 'utf8');
			expect(src, `${file} must import WORLD_ROLL_GAIN`).toMatch(/import\s*\{[^}]*WORLD_ROLL_GAIN/);
			expect(
				src.replace(/\/\*[\s\S]*?\*\//g, ''),
				`${file} declares its own WORLD_ROLL_GAIN`
			).not.toMatch(/const\s+WORLD_ROLL_GAIN\s*=/);
		}
	});

	/**
	 * Sign, checked geometrically rather than by reading it back — the same
	 * method that caught the inverted bank. A left (counterclockwise) turn drops
	 * the left wing, and MapLibre rotates the camera so the world
	 * counter-rotates: the roll passed to the map must be POSITIVE.
	 */
	it('a left turn tips the horizon the correct way', () => {
		const track = new FlightTrack(40, -105, 400, 13_000, 1, 0);
		const cosLat = Math.cos((40 * Math.PI) / 180);
		for (const s of [0, 600, 1200, 1800, 2400]) {
			const p0 = track.positionAt(s - 10);
			const p1 = track.positionAt(s);
			const p2 = track.positionAt(s + 10);
			const v1 = [(p1.lon - p0.lon) * cosLat, p1.lat - p0.lat];
			const v2 = [(p2.lon - p1.lon) * cosLat, p2.lat - p1.lat];
			const cross = v1[0] * v2[1] - v1[1] * v2[0];
			const bank = track.bankAt(s);
			if (Math.abs(bank) < 0.05) continue;
			const mapRoll = -bank * WORLD_ROLL_GAIN;
			expect(Math.sign(mapRoll), `t=${s} turning ${cross > 0 ? 'left' : 'right'}`).toBe(
				cross > 0 ? 1 : -1
			);
		}
	});
});
