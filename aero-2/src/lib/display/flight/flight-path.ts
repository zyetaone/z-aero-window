/**
 * flight-path.ts — Aircraft flight path kinematics, ground track, heading, and altitude climb curves.
 * Pure deterministic mathematics — rune-free and renderer-free.
 */

export const ORBIT = {
	driftRate: 3.42e-4,
	/**
	 * Orbit radius in degrees of latitude, and how much it "breathes".
	 *
	 * Was 0.08 / 0.25 — a 3.1x swing that made the ground track a flower. ~1.1x
	 * is a gentle bump: an ellipse that is not machine-perfect, not a spirograph.
	 * 0.225/0.25 (25 km north-south, 42 km east-west) put the city on the
	 * horizon for most of each circuit; 0.19/0.21 keeps it under the wing.
	 */
	majorMin: 0.19,
	majorMax: 0.21,
	/**
	 * Breathe cycles per circuit. MUST be a whole number, or the track never
	 * returns to its own start and the drawn loop shows a seam. Low, so the
	 * bumps are broad rather than scalloped.
	 */
	petals: 3,
	/**
	 * East-west radius as a multiple of north-south. >1 is WIDER than tall.
	 * Was 0.6, which put the long axis up the short screen dimension.
	 */
	aspect: 1.7,
	/**
	 * Peak roll in degrees at the tightest part of the turn.
	 *
	 * CONTENT TUNING, and deliberately not physical. At this orbit radius and
	 * speed the correct bank angle is about 3.5 degrees, which is invisible.
	 * This is a readable exaggeration, not a simulation -- that is the whole
	 * justification for the number, and it was once written down here before
	 * being replaced with adjectives. Restored, because the value has
	 * consequences that are not local to this file:
	 *
	 *   - `viewOptions` folds bank into the sightline at BANK_VIEW_GAIN (0.85).
	 *     This paragraph used to end "saturates the 0.5 deg depression clamp on
	 *     one side of every turn, pinning the sightline near-horizontal", which
	 *     described the ADDITIVE camera. `view.ts` now applies the bank as a
	 *     RATIO of the current depression, which cannot cross zero, so the
	 *     clamp is a guard again rather than a mode. The coupling is still
	 *     real: at 18 deg the ratio clamp saturates and the look-at distance
	 *     swings 4.1x across a turn. Read `viewOptions` before changing this.
	 *   - The night-wash mask in Sky.svelte derives the horizon from the same
	 *     pitch (crisp stars have since moved in-map behind the depth buffer
	 *     and no longer care, but the milky-way wash still does). Going
	 *     14 -> 18 moved the horizon +/-13.8% of screen height, past the 12%
	 *     fade band that was covering it. The coupling is real and this is
	 *     where it originates.
	 *
	 * 14 was the previous value. Anything raised here should be checked against
	 * both of the above, not just against how the turn looks.
	 */
	maxBankDeg: 18,

	/**
	 * How far the altitude wanders off the clean climb curve, as a fraction of
	 * the floor-to-ceiling band. A real airliner does not trace a cosine; it
	 * holds, drifts, and steps. Tapered to zero at both ends of the band so it
	 * can never breach the floor or the ceiling.
	 */
	altitudeWanderFrac: 0.08,

	/**
	 * How much the ellipse itself deviates, as a fraction of its radius. Keyed
	 * to THETA rather than to time, so the loop still closes on itself — a
	 * time-keyed wobble would leave a seam where the track met its own start.
	 */
	pathWanderFrac: 0.06
} as const;

/**
 * One full circuit of the flight path, in seconds.
 * `theta` advances by `driftRate * 2π` per second (~49 minutes).
 */
export const ORBIT_PERIOD_SEC = 1 / ORBIT.driftRate;

/**
 * The breathe cycle, derived from the flight path to guarantee the loop closes without seams.
 */
export const BREATHE_PERIOD_SEC = ORBIT_PERIOD_SEC / ORBIT.petals;

/**
 * Turn rate that corresponds to full bank, degrees per second.
 *
 * The circuit is ~49 minutes, so the mean rate is 360/2924 = 0.123 deg/s and
 * the sharp ends of a 1.7:1 ellipse run roughly twice that. Normalising here
 * rather than against a closed form keeps the bank honest when the path is
 * tuned — change `aspect` and the roll follows without a second edit.
 */
export const TURN_RATE_REF_DEG_PER_SEC = 0.25;

import {
	normalizeHeading as _normalizeHeading,
	wrapSigned as normalizeSigned
} from '#lib/angles.js';

/**
 * 400 m read as a low approach for most of every climb cycle (2026-09-23,
 * "sometimes it seems too low"). 3,000 m is a real climb-out height: roads
 * and towers still resolve, and the cosine curve spends its trough there.
 */
export const ALTITUDE_FLOOR_M = 3000;
export const ALTITUDE_CEILING_M = 13_000;
export const CLIMB_PERIOD_SEC = 900;

/**
 * How long the window holds one destination.
 *
 * Content pacing, not mechanism: v1's director ran ~2:10 per location, tuned
 * for passers-by rather than the desk-workers this installation actually sits
 * in front of. Ten minutes, the middle of the fielded aero-1 band (7 to 15),
 * and it is one number to change.
 *
 * Lives here, not in the director, for two compounding reasons. The view
 * layer cannot import the director without closing an import cycle
 * (view → downtown → director → settings → presets → view — the last hop
 * is type-only, but the cycle gate counts it, as a red run proved). And
 * `director.svelte.ts` is a `$state` rune module while this file is
 * rune-free pure math; the camera derivation must not depend on the
 * reactive layer. Re-exported from the director so its importers do not
 * churn.
 */
export const DWELL_SEC = 600;

/**
 * The blind comes down for the hop, the way aero-1 staged every location
 * change: shut on departure, open on arrival. Nothing "flies" between
 * cities; the passenger looks at the shade for a moment and the world has
 * moved on when it lifts. A pure function of the wall clock, so three panes
 * close and open on the same second without exchanging anything.
 *
 * LEAD hides the last seconds of the old place; LAG covers the new place's
 * tile draw. LAG is sized for a Pi, not a Mac: lifting on a half-drawn
 * city is the one failure a wall cannot hide, and three panes lifting at
 * different moments would be worse, which is why this is a constant and
 * not a tiles-loaded gate.
 */
export const BLIND_LEAD_SEC = 6;
export const BLIND_LAG_SEC = 12;

/** Is the automatic blind down at this second? Closed across every slot boundary. */
export function blindClosedAt(wallSec: number): boolean {
	const phase = ((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC;
	return phase >= DWELL_SEC - BLIND_LEAD_SEC || phase < BLIND_LAG_SEC;
}

const TWO_PI = Math.PI * 2;
const M_PER_DEG_LAT = 111_320;

/**
 * How far the window pans either side of its aim, degrees.
 *
 * The camera used to stare inward 100% of every visit: the city never left
 * frame centre, so banks played across an identical view and every turn
 * read the same. A real side window watches the world slide sideways, so
 * the aim pans — ±18° keeps the city framed (the inward aim dominates)
 * while the glass walks across it. Banks then reveal ground and sky
 * asymmetrically as the sightline swings, instead of modulating one
 * frozen composition.
 */
export const AZIMUTH_SWEEP_DEG = 18;

/**
 * Pan offset for a wall-clock second, degrees in ±AZIMUTH_SWEEP_DEG.
 *
 * One cosine per dwell: slow enough to read as looking around, fast enough
 * that a four-minute visit sees both sides. Pure in wallSec — three panes,
 * one pan — and C1 continuous, so the sightline never steps. No per-place
 * phase: the dwell slot already staggers visits, and a second free knob
 * would just be something else to mistune.
 */
export function azimuthSweepAt(wallSec: number): number {
	if (!Number.isFinite(wallSec)) return 0;
	const phase = (((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC) / DWELL_SEC;
	return AZIMUTH_SWEEP_DEG * Math.cos(phase * TWO_PI);
}

/** Re-exported from `#lib/angles` — kept so this module's many importers do not churn. */
export const normalizeHeading = _normalizeHeading;

export interface OrbitPose {
	lat: number;
	lon: number;
	headingDeg: number;
	aglM: number;
	/**
	 * Bank angle, degrees. Negative rolls left (left wing down).
	 *
	 * An aircraft banks INTO its turn — the inside wing drops, whichever way it
	 * is going. Flying the loop in reverse mirrors the sign, it does not remove
	 * it, and level flight is only ever momentary on a curved path.
	 */
	bankDeg: number;
}

/**
 * A small, stable per-day offset so the flight path is not pinned to the same patch
 * of ground forever.
 *
 * Deterministic on purpose. Three Pis form one window and never talk to each
 * other about pose, so the offset must be a pure function of the day and the
 * place — `Math.random()` would give each pane a different flight path and split the
 * wall into three unrelated views.
 */
export function daySeed(place: { lat: number; lon: number }, nowMs: number): number {
	const day = Math.floor(nowMs / 86_400_000);
	let h =
		(day * 2654435761) ^
		(Math.round(place.lat * 1000) * 40503) ^
		(Math.round(place.lon * 1000) * 65537);
	h = Math.imul(h ^ (h >>> 15), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The orbit's starting angle for a place, on the day `wallSec` falls in.
 *
 * Derived on read, never stored. It used to be a `$state` field on
 * PaneSettings, assigned in `setPlace` from a bare `Date.now()` -- so the one
 * quantity that has to be identical on three panes was a clock reading taken at
 * whatever instant each pane happened to change location. `daySeed` buckets by
 * UTC day, which hides it for all but a few milliseconds a day: at UTC midnight
 * -- 05:30 in Hyderabad, with the wall running -- two panes calling `setPlace`
 * either side of the boundary got different phases and flew different paths
 * until the next rotation.
 *
 * Taking `wallSec` closes it. Every pane derives the phase from the same second
 * it derives the pose from, so they cannot disagree about which day it is
 * without already disagreeing about the time.
 */
export function phaseFor(place: { lat: number; lon: number }, wallSec: number): number {
	return daySeed(place, wallSec * 1000) * TWO_PI;
}

/**
 * FlightTrack — Domain model representing a flight path trajectory around a ground center.
 */
export class FlightTrack {
	constructor(
		readonly centerLat: number,
		readonly centerLon: number,
		readonly floorM: number = ALTITUDE_FLOOR_M,
		readonly ceilingM: number = ALTITUDE_CEILING_M,
		/** +1 flies the loop one way, -1 the other. */
		readonly direction: 1 | -1 = 1,
		/**
		 * Phase offset in radians, so the loop does not start from the same point
		 * (and sit over the same ground) every launch. Comes from `daySeed`, so it
		 * is stable across a day and identical on all three panes.
		 */
		readonly phase = 0
	) {}

	/** The same track flown the other way round. */
	reversed(): FlightTrack {
		return new FlightTrack(
			this.centerLat,
			this.centerLon,
			this.floorM,
			this.ceilingM,
			this.direction === 1 ? -1 : 1,
			this.phase
		);
	}

	/**
	 * Compute 3D aircraft flight path position, heading, and altitude at wall-clock second `wallSec`.
	 */
	/**
	 * Where the aircraft is at `wallSec` — position only.
	 *
	 * Split out from `poseAt` so heading can be measured from the track itself
	 * rather than hand-differentiated. `a` and `b` are functions of time via
	 * `breathe` and of theta via `wobble`, so an analytic velocity that treats
	 * them as constants is missing the radial term entirely.
	 */
	positionAt(wallSec: number): { lat: number; lon: number } {
		const breathePhase = (wallSec % BREATHE_PERIOD_SEC) / BREATHE_PERIOD_SEC;
		const orbitPhase = (wallSec % ORBIT_PERIOD_SEC) / ORBIT_PERIOD_SEC;

		// Harmonic dynamic motion noise (rich multi-frequency organic waves)
		const harmonic =
			Math.sin(orbitPhase * TWO_PI * 4) * 0.08 + Math.cos(orbitPhase * TWO_PI * 8) * 0.04;
		const breathe = Math.max(
			0,
			Math.min(1, (1 - Math.cos(breathePhase * TWO_PI)) * 0.5 + harmonic)
		);

		const theta = (wallSec * ORBIT.driftRate * TWO_PI * this.direction + this.phase) % TWO_PI;

		/**
		 * Deviate the ellipse itself, so the ground track is not a perfect oval.
		 */
		const blend = Math.cos(this.phase * 5.3);
		const shape = Math.cos(theta * 2) * blend + Math.cos(theta * 3) * (1 - Math.abs(blend));
		const wobble = 1 - ORBIT.pathWanderFrac * (1 + shape) * 0.5;

		const a = (ORBIT.majorMin + (ORBIT.majorMax - ORBIT.majorMin) * breathe) * wobble;
		const b = a * ORBIT.aspect;
		const cosLat = Math.cos((this.centerLat * Math.PI) / 180);

		return {
			lat: this.centerLat + a * Math.sin(theta),
			lon: this.centerLon + (b * Math.cos(theta)) / (cosLat || 1)
		};
	}

	/**
	 * Compute 3D aircraft flight path position, heading, bank and altitude.
	 */
	poseAt(wallSec: number): OrbitPose {
		const here = this.positionAt(wallSec);
		const headingDeg = this.headingAt(wallSec);

		return {
			lat: here.lat,
			lon: here.lon,
			headingDeg,
			aglM: this.altitudeAt(wallSec),
			bankDeg: this.bankAt(wallSec)
		};
	}

	/**
	 * Heading, measured from the track rather than derived from it.
	 *
	 * The hand-derived velocity was wrong twice over. It divided the east
	 * component by cosLat AND multiplied by metres-per-degree-of-longitude at
	 * the equator, double-counting the convergence of the meridians — so the
	 * error grew with latitude. And it treated the ellipse radii as constants
	 * when both breathe with time and wobble with theta, dropping the radial
	 * velocity altogether. Measured against the actual ground track the
	 * reported heading was out by up to 27 degrees at Chicago and 21 at
	 * Hyderabad.
	 *
	 * A central difference over the real positions has neither problem, cannot
	 * drift out of sync with `positionAt` when the path is tuned, and is three
	 * lines instead of six. Two extra evaluations of a handful of trig calls,
	 * once per frame.
	 */
	headingAt(wallSec: number, dt = 0.5): number {
		const before = this.positionAt(wallSec - dt);
		const after = this.positionAt(wallSec + dt);
		const cosLat = Math.cos((this.centerLat * Math.PI) / 180) || 1;
		const dNorth = (after.lat - before.lat) * M_PER_DEG_LAT;
		const dEast = (after.lon - before.lon) * M_PER_DEG_LAT * cosLat;
		return normalizeHeading((Math.atan2(dEast, dNorth) * 180) / Math.PI);
	}

	/**
	 * Bank, from how fast the heading is actually changing.
	 *
	 * This used to evaluate the curvature of the ideal ellipse, and it had the
	 * axes transposed: the denominator paired `a` with sin and `b` with cos,
	 * which is the curvature of an ellipse rotated ninety degrees from the one
	 * being flown. With `aspect` at 1.7 the long axis runs east, so the sharp
	 * ends are at theta 0 and pi — and the aircraft rolled to its full 14
	 * degrees at theta pi/2, where the measured turn rate is at its LOWEST. The
	 * wing dropped hardest while flying straightest, and levelled through the
	 * tightest part of the turn.
	 *
	 * Deriving it from the heading rate removes the question. It also picks up
	 * the wobble and breathe terms for free, which the closed form ignored.
	 */
	bankAt(wallSec: number, dt = 1.0): number {
		const rate =
			normalizeSigned(this.headingAt(wallSec + dt) - this.headingAt(wallSec - dt)) / (2 * dt);
		const norm = Math.max(-1, Math.min(1, rate / TURN_RATE_REF_DEG_PER_SEC));
		/**
		 * NOT negated. The sign here was inverted, so the aircraft banked AWAY
		 * from every turn — the exact failure the docstring on `OrbitPose.bankDeg`
		 * says must not happen, sitting four lines from the code that caused it.
		 *
		 * `headingAt` returns a COMPASS bearing, which increases clockwise. A
		 * left turn therefore DECREASES heading, giving a negative rate; the old
		 * `-norm` turned that into a positive bank, and positive is right-wing-
		 * down by this file's own convention. Left turn, right wing down.
		 *
		 * Verified geometrically rather than by reading the sign back: take the
		 * 2D cross product of successive velocity vectors along the real ground
		 * track, which is positive for a counterclockwise (left) turn and owes
		 * nothing to any bearing convention. Every sample of the orbit came back
		 * turning LEFT with the RIGHT wing down.
		 *
		 * It reaches the passenger three ways, all of them wrong together, which
		 * is presumably why it survived: the wing model rolls the wrong way, the
		 * sightline pitches down when it should lift (`BANK_VIEW_GAIN`), and the
		 * cloud deck counter-rotates. Nothing looks broken frame-to-frame — it
		 * just never feels like an aircraft.
		 */
		return norm * ORBIT.maxBankDeg;
	}

	/**
	 * Compute altitude at wall-clock second `wallSec` along the climb/descent cosine curve.
	 */
	altitudeAt(wallSec: number): number {
		const phase = (wallSec % CLIMB_PERIOD_SEC) / CLIMB_PERIOD_SEC;
		const smooth = (1 - Math.cos(phase * TWO_PI)) * 0.5;
		const band = this.ceilingM - this.floorM;
		const base = this.floorM + band * smooth;

		const seed = this.phase;
		const wander =
			Math.sin(wallSec / 211 + seed * 7.1) * 0.6 +
			Math.sin(wallSec / 97 + seed * 3.7) * 0.3 +
			Math.sin(wallSec / 43 + seed * 11.3) * 0.1;

		const taper = Math.sin(phase * Math.PI);
		const out = base + wander * band * ORBIT.altitudeWanderFrac * taper;
		return Math.min(this.ceilingM, Math.max(this.floorM, out));
	}

	/**
	 * Sample the closed ground track ring of [lon, lat] pairs for minimap display.
	 */
	groundTrack(wallSec = 0, samples = 240): [number, number][] {
		const ring: [number, number][] = [];
		for (let i = 0; i < samples; i++) {
			const t = wallSec + (i / samples) * ORBIT_PERIOD_SEC;
			const p = this.poseAt(t);
			ring.push([p.lon, p.lat]);
		}
		ring.push(ring[0]);
		return ring;
	}
}

/**
 * A deterministic pseudo-random value in [0,1) for a given integer slot.
 *
 * For effects that need to look random but must be IDENTICAL on all three
 * panes: lightning, gusts, anything scheduled. `Math.random()` gives each pane
 * its own answer, and on one continuous window that reads as a fault rather
 * than as weather — three panes flashing at three different moments.
 *
 * Keyed off a slot index derived from the wall clock, so every pane computes
 * the same value for the same instant without exchanging anything, and a pane
 * that reboots rejoins mid-sequence instead of restarting it.
 */
export function slotNoise(slot: number, salt = 0): number {
	let h = Math.imul(slot ^ 0x9e3779b9, 2246822507) ^ Math.imul(salt + 1, 3266489909);
	h = Math.imul(h ^ (h >>> 15), 2246822507);
	h = Math.imul(h ^ (h >>> 13), 3266489909);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Seeded PRNG (mulberry32) — a deterministic stream from one integer seed.
 *
 * Lives beside `daySeed` and `slotNoise` because it is the same primitive
 * serving the same invariant: three Pi 5s draw one window and exchange nothing,
 * so anything that looks random has to be a pure function of a shared seed.
 *
 * Was copied byte-for-byte into Clouds.svelte and RainGlass.svelte. Two copies
 * of a PRNG is worse than two copies of most things — if one is ever "improved"
 * the panes stop agreeing, and the symptom is a wall that looks subtly wrong
 * rather than anything that throws.
 */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Wind-drift angle of the cloud deck for a wall-clock second.
 *
 * The deck spins around the viewer as the aircraft flies through the air
 * mass, so the drift MUST follow the flight direction: clockwise loop,
 * drift one way; reversed loop, drift the other. It used to be a bare
 * `wallSec * speed * k` with no direction term, which is why the wind only
 * ever agreed with a clockwise circuit. Pure and wall-shared, so all panes
 * stay in the same air.
 */
export function windDriftAngle(wallSec: number, driftSpeed: number, direction: 1 | -1): number {
	const dirSign = direction < 0 ? -1 : 1;
	return dirSign * wallSec * driftSpeed * 0.0006;
}
