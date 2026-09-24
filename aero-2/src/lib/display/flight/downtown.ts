/**
 * downtown.ts — the mid-visit pass over downtown.
 *
 * The orbit circles 25-40 km out and never comes closer, so the window never
 * flies over downtown and the buildings layer's pass-through moments (towers
 * close below, outline glow lit) can never happen. Routing the ARRIVAL over
 * downtown does not fix it: the arrival is a warp between cities, and a
 * quadratic path through the new centre only bends a 1,900 km glide without
 * ever coming close — the midpoint of old→centre→new sits ~475 km out.
 *
 * So the pass lives inside the visit instead. Mid-dwell, on the global slot
 * grid the rotation already runs on, a city visit detours into a tight loop
 * over the pin for two minutes — provided the climb is low enough for it to
 * read (threading downtown at 12 km shows nothing but haze, so high climb
 * stands the pass down). Then it rejoins the big ellipse. Pure in wallSec
 * and climb altitude: every pane enters and leaves the pass on the same
 * second with nothing exchanged, and a rebooted pane rejoins wherever the
 * slot is.
 *
 * The small loop is the big loop scaled about the centre, not a second path:
 * a uniform positive scale preserves velocity DIRECTION exactly, so the
 * heading the big orbit reports stays true while flying small — and bank
 * too, since yaw-rate ω = v·κ is scale-invariant (v scales up, κ scales
 * down by the same factor). A separate loop would need its own heading
 * derivation kept in sync.
 *
 * Features never thread — there is no downtown to visit, and the Himalaya
 * pin at 6,000 m AGL is not a pass-through anyone wants.
 */

import type { OrbitPose } from './flight-path.js';
import { CLIMB_LOW_PHASE_SEC, DWELL_SEC } from './flight-path.js';

/** Seconds into each dwell the pass starts and ends. Inside the slot with
 * margin both sides: the 3.5 s arrival glide is long over by 37 s, and 67 s
 * of big loop remain after the 173 s handoff before the next rotation. */
// Centred on the climb's trough (flight-path.ts), so the gate opens on the
// slots the climb is already low in and the pull down to the thread is small.
export const DOWNTOWN_PASS_START_SEC = CLIMB_LOW_PHASE_SEC - 75;
export const DOWNTOWN_PASS_END_SEC = CLIMB_LOW_PHASE_SEC + 75;
/** Ease each side of the pass. A cut would teleport ~25 km; 8 s reads as the
 * descent toward the city / climb back out to the loop. */
/**
 * 45 s each way (spiral in 30-120 s, downtown 120-180 s, spiral out 180-270 s). The pass used to blend two VIEWS 40 km apart over 8 s, which
 * measured as a 4-10 km/s slide against the heading and a 190-degree heading
 * flip in one second (the "rewind"). It is now ONE pose whose loop scale, clock
 * warp and altitude follow the blend, so the aircraft spirals in and out.
 */
export const DOWNTOWN_HANDOFF_SEC = 45;
/** Big-loop offsets shrink to this fraction: ~2 km N-S, ~3.4 km E-W at the
 * equator (less up-latitude) — city-centre scale, still a loop, not a hover.
 * Sized against the downtown building packs (~5 km span); Hyderabad's pack
 * sits ~11 km off its pin, so the thread circles empty ground there until
 * that pack is repacked — the loop is right, the content is misplaced. */
const DOWNTOWN_LOOP_SCALE = 0.08;
/**
 * How much faster the thread traverses its small loop than the big loop
 * would. Without it the pass is a hover, not a rotation: the small loop
 * inherits the big loop's angular rate, so a 120 s pass flies ~15° of arc
 * — the window hangs over one suburb for two minutes. At 3x it walks ~45°
 * of the downtown circle, a real circling feel, while ground speed stays
 * low (0.08 × 3 = 0.24× the big loop) because the loop itself is small.
 *
 * Anchored at the pass start so the thread clock reads 45 s when the
 * handoff begins — continuous by construction, and still a pure function
 * of the second, so all panes warp identically. Heading and bank come
 * from the warped time too (view.ts poses the thread from it), which is
 * what banks the aircraft INTO the small circle instead of holding the
 * big loop's attitude while sliding sideways across it.
 */
export const DOWNTOWN_TIME_WARP = 3;

/** Thread-clock second for a flight-clock second: identity at the anchor. */
export function downtownWarpSec(effectiveSec: number, wallSec: number, speed = 1, gate = 1): number {
	if (!Number.isFinite(effectiveSec) || !Number.isFinite(wallSec)) return DOWNTOWN_PASS_START_SEC;
	return effectiveSec + speed * (DOWNTOWN_TIME_WARP - 1) * gate * downtownWarpAdvanceSec(wallSec);
}

/**
 * How open the altitude gate is for a visit whose climb sits at `aglM` at
 * the pass midpoint: 1 well below the thread ceiling, 0 at it. Read ONCE per
 * slot (see view.ts), so it is a constant inside the slot: a gate that
 * followed the live climb closed mid-pass and, with the thread clock far
 * ahead of the flight clock, swung the aircraft across the big ring.
 */
export function downtownGateAt(aglM: number): number {
	if (!Number.isFinite(aglM)) return 0;
	return smooth((DOWNTOWN_THREAD_MAX_AGL_M - aglM) / DOWNTOWN_GATE_FADE_M);
}

const smooth = (s: number) => {
	const c = Math.max(0, Math.min(1, s));
	return c * c * (3 - 2 * c);
};
const RAMP_SEC = 2 * DOWNTOWN_HANDOFF_SEC;
const RAMP_UP_AT = DOWNTOWN_PASS_START_SEC - DOWNTOWN_HANDOFF_SEC;
const FULL_AT = DOWNTOWN_PASS_START_SEC + DOWNTOWN_HANDOFF_SEC;
const RAMP_DOWN_AT = DOWNTOWN_PASS_END_SEC - DOWNTOWN_HANDOFF_SEC;
const OUT_AT = DOWNTOWN_PASS_END_SEC + DOWNTOWN_HANDOFF_SEC;

/** The time half of the blend: 0 outside the pass, smoothstep ramps, 1 inside. */
export function downtownTimeAt(phase: number): number {
	if (phase < RAMP_UP_AT || phase > OUT_AT) return 0;
	if (phase < FULL_AT) return smooth((phase - RAMP_UP_AT) / RAMP_SEC);
	if (phase > RAMP_DOWN_AT) return 1 - smooth((phase - RAMP_DOWN_AT) / RAMP_SEC);
	return 1;
}

/**
 * Integral of `downtownTimeAt` over the slot so far, in wall seconds. The
 * thread clock is `effective + (warp-1) * speed * this`, so its rate is
 * `speed * (1 + (warp-1) * time)`: never below the flight clock's own rate,
 * never backwards. A blend-scaled warp FACTOR ran the clock backwards on the
 * way out (the factor fell faster than the time grew) and flipped the
 * heading; this is closed form, so no pane keeps state to agree on it.
 */
function downtownWarpAdvanceSec(wallSec: number): number {
	const p = ((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC;
	const rampArea = (c: number) => RAMP_SEC * (c * c * c - (c * c * c * c) / 2);
	const plateau = RAMP_DOWN_AT - FULL_AT;
	// Per slot: the clock steps back at the boundary, where the place changes
	// under the blind anyway. (A pinned place sees that step once per dwell.)
	if (p <= RAMP_UP_AT) return 0;
	if (p < FULL_AT) return rampArea((p - RAMP_UP_AT) / RAMP_SEC);
	if (p <= RAMP_DOWN_AT) return RAMP_SEC / 2 + (p - FULL_AT);
	if (p < OUT_AT) {
		const c = (p - RAMP_DOWN_AT) / RAMP_SEC;
		return RAMP_SEC / 2 + plateau + RAMP_SEC * c - rampArea(c);
	}
	return RAMP_SEC + plateau;
}
/** Thread altitude floor. Clears the tallest stamped tower (Dubai, 225 m) by
 * 5x, stays in the buildings' full-render band (under ~5,500 m), and never
 * undercuts a place's own climb floor — Denver threads at its 3,000 m. */
export const DOWNTOWN_MIN_AGL_M = 1800;
/**
 * Climb altitude above which the pass stands down.
 *
 * Threading downtown at 12 km shows nothing — the buildings fade out above
 * ~8,000 m — so the pass only engages when the climb is low enough for it to
 * read. This also keeps the climb-cycle contract: the window still visits
 * every atmosphere band, because high climb is never pinned down. Fades over
 * DOWNTOWN_GATE_FADE_M rather than cutting, so crossing the ceiling mid-pass
 * climbs away smoothly instead of popping back to the loop.
 */
export const DOWNTOWN_THREAD_MAX_AGL_M = 6000;
export const DOWNTOWN_GATE_FADE_M = 500;
/** Slot phase at which the visit's climb altitude is read for the gate. */
export const DOWNTOWN_GATE_PHASE_SEC = (DOWNTOWN_PASS_START_SEC + DOWNTOWN_PASS_END_SEC) / 2;

/** Thread altitude for a visit: the floor, unless the floor is lower than is
 * useful — Hyderabad's 400 m floor would thread rooftops at chimney height.
 *
 * Cross-pane determinism additionally assumes uniform speed: the gate reads
 * climb altitude, which runs on wallSec × speed, so a hand-tuned per-pane
 * speed moves thread engagement as well as phase (pose already diverges
 * there, so this adds amplitude, not a new cliff). */
export function downtownAltM(floorM: number): number {
	return Math.max(floorM, DOWNTOWN_MIN_AGL_M);
}

/**
 * How far into the downtown pass `wallSec` is at climb altitude `aglM`: 0
 * outside, 1 fully inside, smooth ramps across the handoffs and across the
 * altitude gate. Zero-end-derivative easing (smoothstep) on both axes, so
 * neither the handoff nor a mid-pass climb-out starts or stops with a jerk.
 */
export function downtownBlendAt(wallSec: number, aglM: number): number {
	// A NaN climb would otherwise poison the whole view through blendViews;
	// standing down is the only honest answer to an unknown altitude.
	if (!Number.isFinite(wallSec) || !Number.isFinite(aglM)) return 0;
	const time = downtownTimeAt(((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC);
	if (time <= 0) return 0;
	return time * downtownGateAt(aglM);
}

/**
 * Pull an orbit pose into the downtown thread.
 *
 * Position scales about the centre; heading and bank ride through untouched
 * (uniform scaling preserves direction — see above); altitude drops to the
 * thread band. Finite in, finite out; no state, no clock.
 */
export function downtownPose(
	pose: OrbitPose,
	centerLat: number,
	centerLon: number,
	floorM: number,
	blend = 1
): OrbitPose {
	const scale = 1 + (DOWNTOWN_LOOP_SCALE - 1) * blend;
	return {
		lat: centerLat + (pose.lat - centerLat) * scale,
		lon: centerLon + (pose.lon - centerLon) * scale,
		headingDeg: pose.headingDeg,
		bankDeg: pose.bankDeg,
		aglM: pose.aglM + (downtownAltM(floorM) - pose.aglM) * blend
	};
}
