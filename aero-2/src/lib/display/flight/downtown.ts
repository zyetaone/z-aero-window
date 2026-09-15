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
import { DWELL_SEC } from './flight-path.js';

/** Seconds into each dwell the pass starts and ends. Inside the slot with
 * margin both sides: the 3.5 s arrival glide is long over by 37 s, and 67 s
 * of big loop remain after the 173 s handoff before the next rotation. */
export const DOWNTOWN_PASS_START_SEC = 45;
export const DOWNTOWN_PASS_END_SEC = 165;
/** Ease each side of the pass. A cut would teleport ~25 km; 8 s reads as the
 * descent toward the city / climb back out to the loop. */
export const DOWNTOWN_HANDOFF_SEC = 8;
/** Big-loop offsets shrink to this fraction: ~2 km N-S, ~3.4 km E-W at the
 * equator (less up-latitude) — city-centre scale, still a loop, not a hover.
 * Sized against the downtown building packs (~5 km span); Hyderabad's pack
 * sits ~11 km off its pin, so the thread circles empty ground there until
 * that pack is repacked — the loop is right, the content is misplaced. */
export const DOWNTOWN_LOOP_SCALE = 0.08;
/** Thread altitude floor. Clears the tallest stamped tower (Dubai, 225 m) by
 * 5x, stays in the buildings' full-render band (under ~5,500 m), and never
 * undercuts a place's own climb floor — Denver threads at its 3,000 m. */
export const DOWNTOWN_MIN_AGL_M = 1200;
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
	const smooth = (s: number) => {
		const c = Math.max(0, Math.min(1, s));
		return c * c * (3 - 2 * c);
	};
	const phase = ((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC;
	const rampUpAt = DOWNTOWN_PASS_START_SEC - DOWNTOWN_HANDOFF_SEC;
	const rampDownAt = DOWNTOWN_PASS_END_SEC - DOWNTOWN_HANDOFF_SEC;
	let time = 0;
	if (phase >= rampUpAt && phase <= DOWNTOWN_PASS_END_SEC + DOWNTOWN_HANDOFF_SEC) {
		if (phase < DOWNTOWN_PASS_START_SEC + DOWNTOWN_HANDOFF_SEC)
			time = smooth((phase - rampUpAt) / (2 * DOWNTOWN_HANDOFF_SEC));
		else if (phase > rampDownAt)
			time = 1 - smooth((phase - rampDownAt) / (2 * DOWNTOWN_HANDOFF_SEC));
		else time = 1;
	}
	if (time <= 0) return 0;
	return time * smooth((DOWNTOWN_THREAD_MAX_AGL_M - aglM) / DOWNTOWN_GATE_FADE_M);
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
	floorM: number
): OrbitPose {
	return {
		lat: centerLat + (pose.lat - centerLat) * DOWNTOWN_LOOP_SCALE,
		lon: centerLon + (pose.lon - centerLon) * DOWNTOWN_LOOP_SCALE,
		headingDeg: pose.headingDeg,
		bankDeg: pose.bankDeg,
		aglM: downtownAltM(floorM)
	};
}
